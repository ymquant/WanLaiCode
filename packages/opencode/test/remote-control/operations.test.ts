import { afterAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Question } from "@/question"
import { operations, remotePermissionSentinel, remoteRequestKey, remoteSessionID } from "@/remote-control/operations"
import type { RemotePermissionMode } from "@/remote-control/protocol"
import { Database } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"
import { tmpdir } from "../fixture/fixture"

// 异步 ACK 测试会与全仓数千个用例共享 CI runner；统一保留约 4 秒调度窗口，避免按本机速度误判回复丢失。
const ASYNC_REPLY_POLL_ATTEMPTS = 400

async function waitForRemoteUpdateCount(updates: readonly unknown[], count: number) {
  // Session 事件通过异步 Bus 发布；定向测试只等待目标数量，避免用固定长延时掩盖少发事件。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (updates.length >= count) return
    await Bun.sleep(5)
  }
  throw new Error(`等待 ${count} 个远控会话更新事件超时，实际收到 ${updates.length} 个`)
}

describe("remote-control operations", () => {
  test("手机创建空白项目后通知桌面加入项目列表", async () => {
    await using tmp = await tmpdir()
    const events: GlobalEvent[] = []
    const collect = (event: GlobalEvent) => events.push(event)
    GlobalBus.on("event", collect)
    try {
      const created = await operations.blankProjectCreate({ parent: tmp.path, name: "Remote blank" })

      // 生产代码返回当前平台的原生路径；测试必须与 Windows 和 POSIX 的分隔符语义同时一致。
      expect(created.path).toBe(join(tmp.path, "Remote blank"))
      expect(events).toContainEqual(
        expect.objectContaining({
          directory: "global",
          payload: expect.objectContaining({
            type: "project.open.requested",
            properties: { directory: created.path },
          }),
        }),
      )
    } finally {
      GlobalBus.off("event", collect)
    }
  })

  test("start 请求重发复用同一个数据库会话", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await operations.create({ directory: tmp.path, title: "Idempotent", request_id: "mobile:start_1" })
    const retried = await operations.create({ directory: tmp.path, title: "Idempotent", request_id: "mobile:start_1" })

    expect(retried.id).toBe(first.id)
    expect(first.id).toBe(remoteSessionID("mobile:start_1"))
    expect(Array.from(Session.listGlobal({ limit: 10_000 })).filter((item) => item.id === first.id)).toHaveLength(1)
  })

  test("start request_id 对归档会话继续执行幂等冲突校验", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await operations.create({
      directory: tmp.path,
      title: "Archived idempotent",
      request_id: "mobile:start_archived",
    })
    await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) =>
            service.setArchived({ sessionID: SessionID.make(created.id), time: Date.now() }),
          ),
        ),
      ),
    )

    // 归档只隐藏会话，不能释放 request_id；同值重试复用实际记录，异值重试必须明确冲突。
    const retried = await operations.create({
      directory: tmp.path,
      title: "Archived idempotent",
      request_id: "mobile:start_archived",
    })
    expect(retried.id).toBe(created.id)
    await expect(
      operations.create({
        directory: tmp.path,
        title: "Conflicting archived title",
        request_id: "mobile:start_archived",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
    expect(
      Array.from(Session.listGlobal({ archived: true, unlimited: true })).filter((item) => item.id === created.id),
    ).toHaveLength(1)
  })

  test("会话快照不受普通列表默认分页上限影响", async () => {
    await using tmp = await tmpdir({ git: true })
    const createdIDs = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Effect.gen(function* () {
            const service = yield* Session.Service
            const ids: string[] = []
            for (let index = 0; index < 105; index += 1) {
              const session = yield* service.create({ title: `Remote session ${index}` })
              ids.push(session.id)
            }
            return ids
          }),
        ),
      ),
    )

    // 普通列表默认最多读取 100 条；远控权威快照必须包含该目录本轮创建的全部活动会话。
    const sessions = await operations.listSessions()
    const snapshotIDs = new Set(sessions.map((session) => session.id))
    expect(createdIDs.every((id) => snapshotIDs.has(id))).toBe(true)
  })

  test("historyPage 在 hydrate 前拦截超过 32 MiB 的 SQLite Part", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.create({ title: "Oversized remote history" })),
        ),
      ),
    )
    const sessionID = SessionID.make(created.id)
    const messageID = MessageID.make("msg_remote_history_oversized")
    const partID = PartID.make("prt_remote_history_oversized")

    // 直接写入有效但超限的 Part JSON，确保长度门禁只返回消息 ID，不读取并解析完整正文。
    await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Effect.sync(() =>
            Database.use((db) => {
              db.insert(MessageTable)
                .values({
                  id: messageID,
                  session_id: sessionID,
                  // 新游标协议要求测试消息也具备稳定序号，避免夹具绕过真实的写入顺序约束。
                  sequence: 1,
                  time_created: 1,
                  data: {
                    role: "user",
                    time: { created: 1 },
                    agent: "build",
                    model: { providerID: "test", modelID: "test-model" },
                  } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
                })
                .run()
              db.insert(PartTable)
                .values({
                  id: partID,
                  message_id: messageID,
                  session_id: sessionID,
                  time_created: 1,
                  data: {
                    type: "text",
                    text: "x".repeat(32 * 1024 * 1024),
                  } as NonNullable<(typeof PartTable.$inferInsert)["data"]>,
                })
                .run()
            }),
          ),
        ),
      ),
    )

    const page = await operations.historyPage({
      session_id: created.id,
      direction: "forward",
      limit: 1,
    })
    expect(page.items).toEqual([{ type: "oversized", messageID }])
    expect(page.items[0]).not.toHaveProperty("message")
    await expect(operations.history({ session_id: created.id, limit: 1 })).rejects.toMatchObject({
      code: "REMOTE_HISTORY_ENTRY_TOO_LARGE",
    })
  })

  test("从其他当前工作区读取附件时切换到目标会话数据库", async () => {
    await using source = await tmpdir({ git: true })
    await using caller = await tmpdir({ git: true })
    const bytes = Buffer.from("cross-directory attachment")
    const base64 = bytes.toString("base64")
    const messageID = MessageID.make("msg_remote_cross_directory")
    const partID = PartID.make("prt_remote_cross_directory")
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: source.path },
          Effect.gen(function* () {
            const session = yield* Session.Service
            const info = yield* session.create({ title: "Cross-directory attachment" })
            yield* Effect.sync(() =>
              Database.use((db) => {
                // 直接写入目标目录的有效用户附件，隔离验证 getAttachment 自己是否选择正确数据库。
                db.insert(MessageTable)
                  .values({
                    id: messageID,
                    session_id: info.id,
                    sequence: 1,
                    time_created: 1,
                    data: {
                      role: "user",
                      time: { created: 1 },
                      agent: "build",
                      model: { providerID: "test", modelID: "test-model" },
                    } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
                  })
                  .run()
                db.insert(PartTable)
                  .values({
                    id: partID,
                    message_id: messageID,
                    session_id: info.id,
                    time_created: 1,
                    data: {
                      type: "file",
                      mime: "text/plain",
                      filename: "cross-directory.txt",
                      url: `data:text/plain;base64,${base64}`,
                    } as NonNullable<(typeof PartTable.$inferInsert)["data"]>,
                  })
                  .run()
              }),
            )
            return info
          }),
        ),
      ),
    )

    const content = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: caller.path },
          // 调用现场故意停留在另一目录；生产实现必须以 session.directory 覆盖该上下文。
          Effect.promise(() => operations.getAttachment({ session_id: created.id, attachment_id: partID })),
        ),
      ),
    )
    expect(content).toMatchObject({
      attachment_id: partID,
      filename: "cross-directory.txt",
      mime_type: "text/plain",
      size_bytes: bytes.length,
      base64,
    })
  })

  test("手机 send 先写入同一 session 数据库", async () => {
    await using tmp = await tmpdir({
      git: true,
      // 使用真实 Provider 配置完成 PromptInput 建模，但 baseURL 不承载请求；断言写库后立即取消后台 loop。
      config: {
        model: "test/test-model",
        provider: {
          test: {
            name: "Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "test-model": {
                name: "Test Model",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: true,
                limit: { context: 100_000, output: 10_000 },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.create({ title: "Remote shared session" })),
        ),
      ),
    )

    const image = {
      type: "file" as const,
      mime: "image/png",
      filename: "mobile-image-1.png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    }
    const documentBytes = Buffer.from("%PDF-1.7\nremote document")
    const attachment = {
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: documentBytes.length,
      base64: documentBytes.toString("base64"),
      extractedText: "设备端提取出的报告正文",
      derivedImages: [
        {
          pageNumber: 1,
          mimeType: "image/jpeg",
          base64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"),
        },
      ],
    }
    // 相同 request_id 必须同时复用文本、图片、原文件和设备端派生上下文；任一内容变化都不能命中旧消息。
    const sent = await operations.send({
      session_id: created.id,
      text: "sent from phone",
      images: [image],
      attachments: [attachment],
      request_id: "mobile:input_1",
      client_message_id: "mobile-client-message-1",
    })
    const retried = await operations.send({
      session_id: created.id,
      text: "sent from phone",
      images: [image],
      attachments: [attachment],
      request_id: "mobile:input_1",
      client_message_id: "mobile-client-message-1",
    })
    await expect(
      operations.send({
        session_id: created.id,
        text: "sent from phone",
        images: [{ ...image, url: "data:image/png;base64,iVBORw0KGgpkaWZmZXJlbnQ=" }],
        attachments: [attachment],
        request_id: "mobile:input_1",
        client_message_id: "mobile-client-message-1",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
    await expect(
      operations.send({
        session_id: created.id,
        text: "sent from phone",
        images: [image],
        attachments: [{ ...attachment, extractedText: "另一份提取正文" }],
        request_id: "mobile:input_1",
        client_message_id: "mobile-client-message-1",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
    const history = await operations.history({ session_id: created.id, limit: 20 })
    const user = history.messages.find((message) => message.info.id === sent.message_id)
    expect(retried.message_id).toBe(sent.message_id)
    expect(sent.message_id).toMatch(/^msg_[0-9a-f]{12}/)
    expect(history.messages.filter((message) => message.info.id === sent.message_id)).toHaveLength(1)
    expect(user?.info.sessionID).toBe(created.id)
    expect(user?.info.role === "user" ? user.info.remoteClientMessageID : undefined).toBe("mobile-client-message-1")
    // 远控输入必须显式落下当前 Provider 模型，不能依赖 Prompt.lastModel 的隐式回退。
    expect(user?.info.role === "user" ? user.info.model : undefined).toMatchObject({
      providerID: "test",
      modelID: "test-model",
    })
    expect(user?.parts.some((part) => part.type === "text" && part.text === "sent from phone")).toBe(true)
    expect(user?.parts.some((part) => part.type === "file" && part.url === image.url)).toBe(true)
    expect(
      user?.parts.some(
        (part) =>
          part.type === "file" &&
          part.filename === "report.pdf" &&
          part.url === `data:application/pdf;base64,${attachment.base64}`,
      ),
    ).toBe(true)
    expect(
      user?.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("设备端提取出的报告正文"),
      ),
    ).toBe(true)
    expect(
      user?.parts.some((part) => part.type === "file" && part.filename === ".wanlai-mobile-derived-1-page-1.jpg"),
    ).toBe(true)

    const storedDocument = user?.parts.find((part) => part.type === "file" && part.filename === "report.pdf")
    if (!storedDocument || storedDocument.type !== "file") throw new Error("缺少已持久化的远控文件")
    const derivedPage = user?.parts.find(
      (part) => part.type === "file" && part.filename === ".wanlai-mobile-derived-1-page-1.jpg",
    )
    if (!derivedPage || derivedPage.type !== "file") throw new Error("缺少已持久化的 PDF 派生页")
    const content = await operations.getAttachment({
      session_id: created.id,
      attachment_id: storedDocument.id,
    })
    expect(content).toMatchObject({
      attachment_id: storedDocument.id,
      filename: "report.pdf",
      mime_type: "application/pdf",
      size_bytes: documentBytes.length,
      base64: attachment.base64,
    })
    await expect(
      operations.getAttachment({ session_id: "ses_other", attachment_id: storedDocument.id }),
    ).rejects.toMatchObject({ code: "attachment_forbidden" })
    // 扫描页只服务模型视觉上下文，即使调用方拿到同会话 part ID 也不能把内部派生文件当原附件下载。
    await expect(
      operations.getAttachment({ session_id: created.id, attachment_id: derivedPage.id }),
    ).rejects.toMatchObject({ code: "attachment_forbidden" })
    await expect(
      operations.getAttachment({ session_id: created.id, attachment_id: "prt_missing" }),
    ).rejects.toMatchObject({ code: "attachment_not_found" })
    const storedPartData = Database.use((db) =>
      db.select({ data: PartTable.data }).from(PartTable).where(eq(PartTable.id, storedDocument.id)).get(),
    )?.data
    if (!storedPartData || storedPartData.type !== "file") throw new Error("缺少附件数据库记录")
    // 预览接口绝不能把桌面本地路径转发给手机；正文不再是 data URL 时只返回过期错误。
    Database.use((db) =>
      db
        .update(PartTable)
        .set({
          data: { ...storedPartData, url: "file:///Users/developer/report.pdf" } as NonNullable<
            (typeof PartTable.$inferInsert)["data"]
          >,
        })
        .where(eq(PartTable.id, storedDocument.id))
        .run(),
    )
    await expect(
      operations.getAttachment({ session_id: created.id, attachment_id: storedDocument.id }),
    ).rejects.toMatchObject({ code: "attachment_expired" })

    // 先结束文本场景，再验证不同空白写法会归一为同一个纯图片请求，不产生重复消息或幂等冲突。
    await operations.abort({ session_id: created.id })
    const whitespace = await operations.send({
      session_id: created.id,
      text: "   ",
      images: [image],
      request_id: "mobile:input_whitespace_image",
      client_message_id: "mobile-client-message-whitespace",
    })
    const whitespaceRetry = await operations.send({
      session_id: created.id,
      text: "\n\t",
      images: [image],
      request_id: "mobile:input_whitespace_image",
      client_message_id: "mobile-client-message-whitespace",
    })
    const afterWhitespaceRetry = await operations.history({ session_id: created.id, limit: 20 })
    const whitespaceMessages = afterWhitespaceRetry.messages.filter(
      (message) => message.info.id === whitespace.message_id,
    )
    expect(whitespaceRetry.message_id).toBe(whitespace.message_id)
    expect(whitespaceMessages).toHaveLength(1)
    expect(whitespaceMessages[0]?.parts.some((part) => part.type === "text")).toBe(false)
    expect(whitespaceMessages[0]?.parts.some((part) => part.type === "file" && part.url === image.url)).toBe(true)

    // 测试收尾主动取消后台 loop，避免真实 provider 调用影响后续测试。
    await operations.abort({ session_id: created.id })
  })

  test("模型目录校验后持久化 WanlaiCode model 与 variant", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/remote-model-a",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "remote-model-a": {
                name: "Remote Model A",
                reasoning: true,
                tool_call: true,
                limit: { context: 100_000, output: 10_000 },
                variants: { low: {}, high: {} },
              },
              "remote-model-b": {
                name: "Remote Model B",
                reasoning: true,
                tool_call: true,
                limit: { context: 250_000, output: 20_000 },
                variants: { low: {}, high: {} },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) =>
            service.create({
              title: "Remote model selection",
              model: {
                providerID: ProviderID.make("wanlaicode"),
                id: ModelID.make("remote-model-a"),
                variant: "low",
              },
            }),
          ),
        ),
      ),
    )

    const catalog = await operations.modelCatalog({ directory: tmp.path })
    expect(catalog.find((model) => model.model_id === "remote-model-b")).toMatchObject({
      provider_id: "wanlaicode",
      reasoning_efforts: expect.arrayContaining(["low", "high"]),
      context_window: 250_000,
    })
    const changed = await operations.setModel({
      session_id: created.id,
      model_id: "remote-model-b",
      variant: "high",
    })
    const stored = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(created.id))),
        ),
      ),
    )
    expect(changed).toMatchObject({
      previous_model: { model_id: "remote-model-a", variant: "low" },
      model: { model_id: "remote-model-b", variant: "high", context_window: 250_000 },
    })
    expect(stored.model as unknown).toEqual({
      providerID: "wanlaicode",
      id: "remote-model-b",
      variant: "high",
    })
    await expect(operations.setModel({ session_id: created.id, model_id: "not-in-catalog" })).rejects.toMatchObject({
      code: "set_codex_model_rejected",
    })
  })

  test("resume 对目录已下架的当前模型同值恢复保持零写入", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/active-model",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Retired Model Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "active-model": {
                name: "Active Model",
                reasoning: true,
                tool_call: true,
                limit: { context: 100_000, output: 10_000 },
                variants: { low: {}, high: {} },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) =>
            service.create({
              title: "Retired remote model",
              model: {
                providerID: ProviderID.make("wanlaicode"),
                id: ModelID.make("retired-model"),
                variant: "high",
              },
            }),
          ),
        ),
      ),
    )
    const readStored = () =>
      AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: tmp.path },
            Session.Service.use((service) => service.get(SessionID.make(created.id))),
          ),
        ),
      )

    // 创建事件排空后再监听，确保普通打开旧会话既不校验失败，也不伪造一次 Updated。
    await Bun.sleep(25)
    const updates: string[] = []
    const unsubscribe = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Bus.Service.use((bus) =>
            bus.subscribeCallback(Session.Event.Updated, (event) => {
              if (String(event.properties.sessionID) === created.id) updates.push(created.id)
            }),
          ),
        ),
      ),
    )

    try {
      const before = await readStored()
      const resumed = await operations.resume({
        session_id: created.id,
        model_id: "retired-model",
        variant: "high",
      })
      await Bun.sleep(20)

      expect(updates).toHaveLength(0)
      expect(await readStored()).toEqual(before)
      expect(resumed).toMatchObject({
        model: { provider_id: "wanlaicode", model_id: "retired-model", variant: "high" },
      })
      expect(resumed.model_catalog?.map((model) => model.model_id)).not.toContain("retired-model")

      const concurrentResume = operations.resume({
        session_id: created.id,
        model_id: "retired-model",
        variant: "high",
      })
      // resume 在首次异步解析后继续执行；同步写入 B 可稳定复现“事务前看到 A、事务内 current 已是 B”。
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({
            model: {
              providerID: ProviderID.make("wanlaicode"),
              id: ModelID.make("active-model"),
              variant: "low",
            },
          })
          .where(eq(SessionTable.id, SessionID.make(created.id)))
          .run(),
      )
      const synchronized = await concurrentResume
      await Bun.sleep(20)

      // direct resume 的旧事实不能覆盖桌面并发切换，ACK 也必须回显事务内最终模型 B。
      expect(updates).toHaveLength(0)
      expect((await readStored()).model as unknown).toEqual({
        providerID: "wanlaicode",
        id: "active-model",
        variant: "low",
      })
      expect(synchronized).toMatchObject({
        model: { provider_id: "wanlaicode", model_id: "active-model", variant: "low" },
      })

      const validatedResume = operations.resume({
        session_id: created.id,
        model_id: "active-model",
        variant: "high",
      })
      // 远端校验 B/high 期间桌面也先写成 B/high；apply 必须比较最新 current，不能按旧 B/low 冗余发 Updated。
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({
            model: {
              providerID: ProviderID.make("wanlaicode"),
              id: ModelID.make("active-model"),
              variant: "high",
            },
          })
          .where(eq(SessionTable.id, SessionID.make(created.id)))
          .run(),
      )
      const converged = await validatedResume
      await Bun.sleep(20)

      // 两端已收敛到同一模型时保持零写入，ACK 仍从事务后会话回显最终 B/high。
      expect(updates).toHaveLength(0)
      expect((await readStored()).model as unknown).toEqual({
        providerID: "wanlaicode",
        id: "active-model",
        variant: "high",
      })
      expect(converged).toMatchObject({
        model: { provider_id: "wanlaicode", model_id: "active-model", variant: "high" },
      })
    } finally {
      unsubscribe()
    }
  })

  test("resume 以单个 Updated 原子应用模型与权限，空设置和校验失败不写状态", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/resume-model-a",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Resume Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "resume-model-a": {
                name: "Resume Model A",
                reasoning: true,
                tool_call: true,
                limit: { context: 120_000, output: 10_000 },
                variants: { low: {}, high: {} },
              },
              "resume-model-b": {
                name: "Resume Model B",
                reasoning: true,
                tool_call: true,
                limit: { context: 240_000, output: 20_000 },
                variants: { low: {}, high: {} },
              },
              "resume-model-high-only": {
                name: "Resume Model High Only",
                // 禁用通用 reasoning 启发式，只保留显式 high variant，构造真实的不兼容目录项。
                reasoning: false,
                tool_call: true,
                limit: { context: 180_000, output: 15_000 },
                variants: { high: {} },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) =>
            service.create({
              title: "Atomic remote resume",
              model: {
                providerID: ProviderID.make("wanlaicode"),
                id: ModelID.make("resume-model-a"),
                variant: "low",
              },
              permission: [{ permission: "bash", pattern: "git status", action: "ask" }],
            }),
          ),
        ),
      ),
    )
    const readStored = () =>
      AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: tmp.path },
            Session.Service.use((service) => service.get(SessionID.make(created.id))),
          ),
        ),
      )
    // 先验证 Provider 归一化后的真实目录，防止夹具被默认 variants 扩展后失去“不兼容”前提。
    expect(
      (await operations.modelCatalog({ directory: tmp.path })).find(
        (model) => model.model_id === "resume-model-high-only",
      )?.reasoning_efforts,
    ).toEqual(["high"])

    // 创建兼容事件完全排空后再订阅，只统计本测试触发的 resume 更新。
    await Bun.sleep(25)
    const updates: Array<{ sessionID: string }> = []
    const patches: unknown[] = []
    const collectPatch = (event: GlobalEvent) => {
      const syncEvent = event.payload?.syncEvent
      if (syncEvent?.type !== "session.updated.1" || String(syncEvent.data?.sessionID) !== created.id) return
      // ProjectBus 会把 patch 转换成完整会话；原始 GlobalBus syncEvent 才能验证事务实际写了哪些字段。
      patches.push(syncEvent.data.info)
    }
    GlobalBus.on("event", collectPatch)
    const unsubscribe = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Bus.Service.use((bus) =>
            bus.subscribeCallback(Session.Event.Updated, (event) => {
              if (String(event.properties.sessionID) === created.id) updates.push({ sessionID: created.id })
            }),
          ),
        ),
      ),
    )

    try {
      const before = await readStored()
      const unchanged = await operations.resume({ session_id: created.id })
      await Bun.sleep(20)
      expect(updates).toHaveLength(0)
      expect(await readStored()).toEqual(before)
      expect(unchanged).toMatchObject({
        model: { model_id: "resume-model-a", variant: "low" },
        permission_mode: "default",
      })

      // 仅模型且档位缺省时沿用兼容的旧值，不能把 Dart 省略字段误当作显式清空。
      const modelOnly = await operations.resume({
        session_id: created.id,
        model_id: "resume-model-b",
      })
      await waitForRemoteUpdateCount(updates, 1)
      expect(updates).toHaveLength(1)
      expect(modelOnly).toMatchObject({
        model: { model_id: "resume-model-b", variant: "low", context_window: 240_000 },
        permission_mode: "default",
      })
      expect(patches[0]).toMatchObject({
        model: { providerID: "wanlaicode", id: "resume-model-b", variant: "low" },
      })
      expect(patches[0]).not.toHaveProperty("permission")

      const cleared = await operations.resume({
        session_id: created.id,
        model_id: "resume-model-a",
        variant: null,
      })
      await waitForRemoteUpdateCount(updates, 2)
      expect(updates).toHaveLength(2)
      expect(cleared).toMatchObject({
        model: { model_id: "resume-model-a" },
        permission_mode: "default",
      })
      expect(cleared.model).not.toHaveProperty("variant")

      // 模型与权限组合仍只发一个 Updated，并把显式档位与 Auto-review 一起写入同一事务。
      const combined = await operations.resume({
        session_id: created.id,
        model_id: "resume-model-a",
        variant: "low",
        permission_mode: "autoReview",
      })
      await waitForRemoteUpdateCount(updates, 3)
      expect(updates).toHaveLength(3)
      expect(combined).toMatchObject({
        model: { model_id: "resume-model-a", variant: "low", context_window: 120_000 },
        permission_mode: "autoReview",
      })
      expect(patches[2]).toMatchObject({
        model: { providerID: "wanlaicode", id: "resume-model-a", variant: "low" },
        permission: expect.arrayContaining([{ permission: remotePermissionSentinel, pattern: "*", action: "allow" }]),
      })

      // direct resume 重发同一模型和权限事实时必须保持零事件，不能刷新时间或重写 sentinel。
      const repeated = await operations.resume({
        session_id: created.id,
        model_id: "resume-model-a",
        variant: "low",
        permission_mode: "autoReview",
      })
      await Bun.sleep(20)
      expect(updates).toHaveLength(3)
      expect(repeated).toMatchObject({
        model: { model_id: "resume-model-a", variant: "low" },
        permission_mode: "autoReview",
      })

      // 旧 low 档位与目标模型不兼容时只回到模型默认值，不把整个 resume 错误拒绝。
      const incompatible = await operations.resume({
        session_id: created.id,
        model_id: "resume-model-high-only",
        permission_mode: "autoReview",
      })
      await waitForRemoteUpdateCount(updates, 4)
      expect(updates).toHaveLength(4)
      expect(incompatible).toMatchObject({
        model: { model_id: "resume-model-high-only", context_window: 180_000 },
        permission_mode: "autoReview",
      })
      expect(incompatible.model).not.toHaveProperty("variant")
      expect(patches[3]).toMatchObject({
        model: { providerID: "wanlaicode", id: "resume-model-high-only" },
      })
      expect(patches[3]).not.toHaveProperty("permission")

      const permissionOnly = await operations.resume({
        session_id: created.id,
        model_id: "resume-model-high-only",
        variant: null,
        permission_mode: "default",
      })
      await waitForRemoteUpdateCount(updates, 5)
      expect(updates).toHaveLength(5)
      expect(permissionOnly).toMatchObject({
        model: { model_id: "resume-model-high-only" },
        permission_mode: "default",
      })
      expect(patches[4]).toMatchObject({
        permission: expect.arrayContaining([{ permission: remotePermissionSentinel, pattern: "*", action: "deny" }]),
      })
      expect(patches[4]).not.toHaveProperty("model")

      // 缺失 model、未知模型或非法权限任一失败后都不能产生第六个 Updated，也不能留下部分模型切换。
      await expect(operations.resume({ session_id: created.id, variant: "high" })).rejects.toMatchObject({
        code: "set_codex_model_rejected",
      })
      await expect(
        operations.resume({
          session_id: created.id,
          model_id: "missing-model",
          permission_mode: "autoReview",
        }),
      ).rejects.toMatchObject({ code: "set_codex_model_rejected" })
      await expect(
        operations.resume({
          session_id: created.id,
          model_id: "resume-model-b",
          permission_mode: "fullAccess" as RemotePermissionMode,
        }),
      ).rejects.toMatchObject({ code: "set_permission_mode_rejected" })
      await Bun.sleep(20)
      expect(updates).toHaveLength(5)
      expect(await readStored()).toMatchObject({
        model: { providerID: "wanlaicode", id: "resume-model-high-only" },
        permission: expect.arrayContaining([{ permission: remotePermissionSentinel, pattern: "*", action: "deny" }]),
      })
    } finally {
      unsubscribe()
      GlobalBus.off("event", collectPatch)
    }
  })

  test("新会话创建直接持久化模型、推理档位和 Auto-review sentinel", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/remote-create-model",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Create Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "remote-create-model": {
                name: "Remote Create Model",
                reasoning: true,
                tool_call: true,
                limit: { context: 180_000, output: 10_000 },
                variants: { low: {}, high: {} },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })

    const created = await operations.create({
      directory: tmp.path,
      title: "Configured remote session",
      request_id: "mobile:start_configured",
      model_id: "remote-create-model",
      variant: "high",
      permission_mode: "autoReview",
    })
    const stored = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(created.id))),
        ),
      ),
    )

    expect(created).toMatchObject({
      model: {
        provider_id: "wanlaicode",
        model_id: "remote-create-model",
        variant: "high",
        context_window: 180_000,
      },
      permission_mode: "autoReview",
    })
    expect(stored.model as unknown).toEqual({
      providerID: "wanlaicode",
      id: "remote-create-model",
      variant: "high",
    })
    expect(stored.permission).toContainEqual({
      permission: remotePermissionSentinel,
      pattern: "*",
      action: "allow",
    })
  })

  test("并发 start 复用实际持久化会话并拒绝同 request_id 的另一模型", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/remote-race-model-a",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Create Race Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "remote-race-model-a": {
                name: "Remote Race A",
                reasoning: true,
                tool_call: true,
                limit: { context: 120_000, output: 10_000 },
                variants: { low: {} },
              },
              "remote-race-model-b": {
                name: "Remote Race B",
                reasoning: true,
                tool_call: true,
                limit: { context: 240_000, output: 20_000 },
                variants: { high: {} },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    const request = {
      directory: tmp.path,
      title: "Concurrent configured session",
      request_id: "mobile:start_model_race",
    }
    const results = await Promise.allSettled([
      operations.create({ ...request, model_id: "remote-race-model-a", variant: "low" }),
      operations.create({ ...request, model_id: "remote-race-model-b", variant: "high" }),
    ])
    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter((result) => result.status === "rejected")

    // 两个调用都在首次目录校验前看不到会话；最终只能有一个赢家，ACK 必须等于数据库中的赢家模型。
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: "REQUEST_ID_CONFLICT" })
    const stored = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(remoteSessionID("mobile:start_model_race")))),
        ),
      ),
    )
    expect(fulfilled[0]?.value.model).toMatchObject({
      model_id: stored.model?.id,
      variant: stored.model?.variant,
    })
    expect(fulfilled[0]?.value.model?.context_window).toBe(
      stored.model?.id === "remote-race-model-a" ? 120_000 : 240_000,
    )
  })

  test("权限模式通过 Session.permission 跨实例重载恢复并保留原生规则", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) =>
            service.create({
              title: "Persistent remote permission",
              permission: [{ permission: "bash", pattern: "git status", action: "ask" }],
            }),
          ),
        ),
      ),
    )

    await operations.setPermissionMode({ session_id: created.id, mode: "autoReview" })
    await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        Effect.gen(function* () {
          // reload 会销毁当前目录实例并从数据库重建，等价验证模式不依赖 operations 模块内存。
          yield* store.reload({ directory: tmp.path }, "remote permission persistence test")
        }),
      ),
    )
    expect(await operations.permissionMode({ session_id: created.id })).toBe("autoReview")

    await operations.setPermissionMode({ session_id: created.id, mode: "default" })
    const stored = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(created.id))),
        ),
      ),
    )
    expect(await operations.permissionMode({ session_id: created.id })).toBe("default")
    expect(stored.permission?.filter((rule) => rule.permission === remotePermissionSentinel)).toEqual([
      { permission: remotePermissionSentinel, pattern: "*", action: "deny" },
    ])
    expect(stored.permission).toContainEqual({ permission: "bash", pattern: "git status", action: "ask" })
  })

  test("权限 setter 在同一更新边界保留并发新增的原生规则", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) =>
            service.create({
              title: "Concurrent permission update",
              permission: [
                { permission: "bash", pattern: "git status", action: "ask" },
                { permission: remotePermissionSentinel, pattern: "*", action: "deny" },
              ],
            }),
          ),
        ),
      ),
    )

    await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        Effect.gen(function* () {
          // 只移除本目录实例，让 setter 的下一次 provide 必经异步重载，从而稳定暴露快照与写入之间的交错。
          const context = yield* store.load({ directory: tmp.path })
          yield* store.dispose(context, "remote permission concurrency test")
        }),
      ),
    )
    const setting = operations.setPermissionMode({ session_id: created.id, mode: "autoReview" })
    // setter 已取得会话列表快照后，桌面同步追加真实规则；事务内实现必须读取这一版而不是覆盖成旧 ruleset。
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({
          permission: [...(created.permission ?? []), { permission: "edit", pattern: "src/**", action: "allow" }],
        })
        .where(eq(SessionTable.id, created.id))
        .run(),
    )
    await setting
    const stored = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(created.id))),
        ),
      ),
    )

    expect(stored.permission).toContainEqual({ permission: "bash", pattern: "git status", action: "ask" })
    expect(stored.permission).toContainEqual({ permission: "edit", pattern: "src/**", action: "allow" })
    expect(stored.permission?.filter((rule) => rule.permission === remotePermissionSentinel)).toEqual([
      { permission: remotePermissionSentinel, pattern: "*", action: "allow" },
    ])
  })

  test("子会话沿 parentID 继承最近显式权限模式并允许自身 default 覆盖", async () => {
    await using tmp = await tmpdir({ git: true })
    const lineage = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Effect.gen(function* () {
            const service = yield* Session.Service
            const parent = yield* service.create({ title: "Remote permission parent" })
            const child = yield* service.create({ title: "Remote permission child", parentID: parent.id })
            const grandchild = yield* service.create({
              title: "Remote permission grandchild",
              parentID: child.id,
            })
            return { parent, child, grandchild }
          }),
        ),
      ),
    )

    const inheritedPending = AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Permission.Service.use((service) =>
            service.ask({
              id: PermissionID.make("per_remote_child_inheritance"),
              sessionID: lineage.child.id,
              permission: "bash",
              patterns: ["git status"],
              metadata: {},
              always: [],
              ruleset: [],
            }),
          ),
        ),
      ),
    )
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await operations.snapshot()
      if (snapshot.permissions.some((request) => request.session_id === lineage.child.id)) break
      await Bun.sleep(5)
    }
    await operations.setPermissionMode({ session_id: lineage.parent.id, mode: "autoReview" })
    expect(await inheritedPending).toBeUndefined()
    expect(await operations.permissionMode({ session_id: lineage.child.id })).toBe("autoReview")
    expect(await operations.permissionMode({ session_id: lineage.grandchild.id })).toBe("autoReview")
    expect((await operations.listSessions()).find((session) => session.id === lineage.child.id)).toMatchObject({
      permission_mode: "autoReview",
    })

    const inheritedResumePending = AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Permission.Service.use((service) =>
            service.ask({
              id: PermissionID.make("per_remote_child_same_mode_resume"),
              sessionID: lineage.child.id,
              permission: "bash",
              patterns: ["git diff"],
              metadata: {},
              always: [],
              ruleset: [],
            }),
          ),
        ),
      ),
    )
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await operations.snapshot()
      if (snapshot.permissions.some((request) => request.request_id === "per_remote_child_same_mode_resume")) break
      await Bun.sleep(5)
    }
    const childBeforeResume = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(lineage.child.id))),
        ),
      ),
    )
    const inheritedResume = await operations.resume({
      session_id: lineage.child.id,
      permission_mode: "autoReview",
    })
    expect(await inheritedResumePending).toBeUndefined()
    const childAfterResume = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.get(SessionID.make(lineage.child.id))),
        ),
      ),
    )
    // 同值恢复不能把父级继承改成子会话显式 sentinel；父级后续切换仍必须继续传递。
    expect(inheritedResume.permission_mode).toBe("autoReview")
    expect(childAfterResume.permission).toEqual(childBeforeResume.permission)
    expect(childAfterResume.time.updated).toBe(childBeforeResume.time.updated)
    await operations.setPermissionMode({ session_id: lineage.parent.id, mode: "default" })
    expect(await operations.permissionMode({ session_id: lineage.child.id })).toBe("default")
    await operations.setPermissionMode({ session_id: lineage.parent.id, mode: "autoReview" })
    expect(await operations.permissionMode({ session_id: lineage.child.id })).toBe("autoReview")

    // 子会话写入显式 deny sentinel 后，自己和更深后代都应停止继承父会话的 auto-review。
    await operations.setPermissionMode({ session_id: lineage.child.id, mode: "default" })
    expect(await operations.permissionMode({ session_id: lineage.parent.id })).toBe("autoReview")
    expect(await operations.permissionMode({ session_id: lineage.child.id })).toBe("default")
    expect(await operations.permissionMode({ session_id: lineage.grandchild.id })).toBe("default")
  })

  test("模型目录按会话目录隔离且无目录兼容目录不暴露项目独有模型", async () => {
    await using first = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/remote-shared-catalog-model",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Catalog Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "remote-shared-catalog-model": {
                name: "Shared Low",
                reasoning: true,
                tool_call: true,
                limit: { context: 120_000, output: 10_000 },
                variants: { low: {} },
              },
              "remote-first-only-model": {
                name: "First Only",
                tool_call: true,
                limit: { context: 80_000, output: 10_000 },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    await using second = await tmpdir({
      git: true,
      config: {
        model: "wanlaicode/remote-shared-catalog-model",
        provider: {
          wanlaicode: {
            name: "WanlaiCode Catalog Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "remote-shared-catalog-model": {
                name: "Shared High",
                reasoning: true,
                tool_call: true,
                limit: { context: 240_000, output: 20_000 },
                variants: { high: {}, ultra: {} },
              },
              "remote-second-only-model": {
                name: "Second Only",
                tool_call: true,
                limit: { context: 90_000, output: 10_000 },
              },
            },
            options: { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" },
          },
        },
      },
    })
    const createdIDs: string[] = []
    for (const directory of [first.path, second.path]) {
      const created = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory },
            Session.Service.use((service) => service.create({ title: `Catalog ${directory}` })),
          ),
        ),
      )
      createdIDs.push(created.id)
    }

    const firstCatalog = await operations.modelCatalog({ directory: first.path })
    const secondCatalog = await operations.modelCatalog({ directory: second.path })
    expect(firstCatalog.map((model) => model.model_id)).toEqual(
      expect.arrayContaining(["remote-shared-catalog-model", "remote-first-only-model"]),
    )
    expect(firstCatalog.map((model) => model.model_id)).not.toContain("remote-second-only-model")
    expect(secondCatalog.map((model) => model.model_id)).toEqual(
      expect.arrayContaining(["remote-shared-catalog-model", "remote-second-only-model"]),
    )
    expect(secondCatalog.map((model) => model.model_id)).not.toContain("remote-first-only-model")
    const firstShared = firstCatalog.find((model) => model.model_id === "remote-shared-catalog-model")
    expect(firstShared?.provider_id).toBe("wanlaicode")
    expect(firstShared?.model_id).toBe("remote-shared-catalog-model")
    expect(firstShared?.context_window).toBe(120_000)
    expect(JSON.stringify(firstShared?.reasoning_efforts ?? [])).toContain("low")
    expect(JSON.stringify(firstShared?.reasoning_efforts ?? [])).not.toContain("ultra")
    const secondShared = secondCatalog.find((model) => model.model_id === "remote-shared-catalog-model")
    expect(secondShared?.context_window).toBe(240_000)
    expect(JSON.stringify(secondShared?.reasoning_efforts ?? [])).toContain("high")
    expect(JSON.stringify(secondShared?.reasoning_efforts ?? [])).toContain("ultra")

    const listed = await operations.listSessions()
    const firstSession = listed.find((item) => item.id === createdIDs[0])
    const secondSession = listed.find((item) => item.id === createdIDs[1])
    // session_list 的每个 item 必须复用 setter 的同一 directory 边界，不能依赖顶层兼容目录。
    expect(firstSession?.model_catalog?.map((model) => model.model_id)).toEqual(
      expect.arrayContaining(["remote-shared-catalog-model", "remote-first-only-model"]),
    )
    expect(firstSession?.model_catalog?.map((model) => model.model_id)).not.toContain("remote-second-only-model")
    expect(secondSession?.model_catalog?.map((model) => model.model_id)).toEqual(
      expect.arrayContaining(["remote-shared-catalog-model", "remote-second-only-model"]),
    )
    expect(secondSession?.model_catalog?.map((model) => model.model_id)).not.toContain("remote-first-only-model")

    const compatible = await operations.modelCatalog()
    // 测试进程可能还保留其他 fixture 会话，因此这里只断言安全属性：任一项目独有模型都不能进入顶层目录。
    expect(compatible.map((model) => model.model_id)).not.toContain("remote-first-only-model")
    expect(compatible.map((model) => model.model_id)).not.toContain("remote-second-only-model")
  })

  test("桌面重启后补启动已落库请求并在一次终态回复后退出 loop", async () => {
    let calls = 0
    using server = Bun.serve({
      port: 0,
      fetch() {
        calls += 1
        const chunks = [
          { id: "chatcmpl-remote", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
          { id: "chatcmpl-remote", object: "chat.completion.chunk", choices: [{ delta: { content: "done" } }] },
          { id: "chatcmpl-remote", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] },
        ]
        const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: {
        prompt_suggestions: false,
        model: "test/test-model",
        provider: {
          test: {
            name: "Test",
            npm: "@ai-sdk/openai-compatible",
            models: {
              "test-model": {
                name: "Test Model",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: true,
                limit: { context: 100_000, output: 10_000 },
              },
            },
            options: { apiKey: "test-key", baseURL: `${server.url}v1` },
          },
        },
      },
    })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.create({ title: "Remote crash recovery" })),
        ),
      ),
    )
    const sessionID = SessionID.make(created.id)
    const requestID = "mobile:crash_recovery"
    const persisted = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          SessionPrompt.Service.use((service) =>
            service.prompt({
              sessionID,
              noReply: true,
              remoteRequestKey: remoteRequestKey(requestID),
              parts: [{ type: "text", text: "resume after crash" }],
            }),
          ),
        ),
      ),
    )

    const sent = await operations.send({
      session_id: created.id,
      text: "resume after crash",
      request_id: requestID,
    })
    for (let attempt = 0; attempt < ASYNC_REPLY_POLL_ATTEMPTS; attempt += 1) {
      const status = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: tmp.path },
            SessionStatus.Service.use((service) => service.get(sessionID)),
          ),
        ),
      )
      if (status.type === "idle" && calls > 0) break
      await Bun.sleep(10)
    }
    const retried = await operations.send({
      session_id: created.id,
      text: "resume after crash",
      request_id: requestID,
    })
    const history = await operations.history({ session_id: created.id, limit: 20 })
    const assistant = history.messages.find(
      (message) => message.info.role === "assistant" && message.info.parentID === persisted.info.id,
    )
    const status = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          SessionStatus.Service.use((service) => service.get(sessionID)),
        ),
      ),
    )

    expect(sent.message_id).toBe(persisted.info.id)
    expect(retried.message_id).toBe(persisted.info.id)
    expect(assistant?.info.id).toBeDefined()
    expect(persisted.info.id < assistant!.info.id).toBe(true)
    expect(status.type).toBe("idle")
    expect(calls).toBe(1)
  })

  test("Auto-review 只自动处理 permission，离线问题仍从 snapshot 恢复并等待回答", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Session.Service.use((service) => service.create({ title: "Pending requests" })),
        ),
      ),
    )
    const sessionID = SessionID.make(created.id)
    const permissionID = PermissionID.make("per_remote_reconnect")

    // 两个等待中的 Effect 保持在原实例内，模拟手机离线时桌面产生审批与 AskUserQuestion。
    const permission = AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Permission.Service.use((service) =>
            service.ask({
              id: permissionID,
              sessionID,
              permission: "bash",
              patterns: ["git status"],
              metadata: { cwd: tmp.path },
              always: [],
              ruleset: [],
            }),
          ),
        ),
      ),
    )
    const question = AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: tmp.path },
          Question.Service.use((service) =>
            service.ask({
              sessionID,
              questions: [
                {
                  question: "Choose mode",
                  header: "Mode",
                  options: [{ label: "Fast", description: "Run fast" }],
                  multiple: false,
                  custom: true,
                },
              ],
            }),
          ),
        ),
      ),
    )

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await operations.snapshot()
      if (snapshot.permissions.length > 0 && snapshot.questions.length > 0) break
      await Bun.sleep(5)
    }
    const snapshot = await operations.snapshot()
    expect(snapshot.permissions[0]).toMatchObject({ session_id: created.id, request_id: String(permissionID) })
    expect(snapshot.questions[0]).toMatchObject({ session_id: created.id, questions: [{ header: "Mode" }] })

    await operations.setPermissionMode({ session_id: created.id, mode: "autoReview" })
    expect(await permission).toBeUndefined()
    const afterAutoReview = await operations.snapshot()
    expect(afterAutoReview.permissions.filter((request) => request.session_id === created.id)).toEqual([])
    expect(afterAutoReview.questions.filter((request) => request.session_id === created.id)).toHaveLength(1)
    expect(await operations.permissionMode({ session_id: created.id })).toBe("autoReview")
    await operations.questionReply({
      session_id: created.id,
      request_id: snapshot.questions[0]!.request_id,
      answers: [["Fast"]],
    })
    expect(await question).toEqual([["Fast"]])
  })
})

afterAll(async () => {
  await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()).pipe(Effect.ignore))
})
