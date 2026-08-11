import { afterEach, describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpRouter } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { validateSession } from "../../src/cli/cmd/tui/validate-session"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Config } from "@/config/config"
import { Session as SessionNs } from "@/session/session"
import { errorMessage } from "../../src/util/error"
import { TestLLMServer } from "../lib/llm-server"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const original = {
  OPENCODE_EXPERIMENTAL_HTTPAPI: Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI,
  OPENCODE_SERVER_PASSWORD: Flag.WANLAICODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.WANLAICODE_SERVER_USERNAME,
}

type Backend = "legacy" | "httpapi"
type Sdk = ReturnType<typeof createOpencodeClient>
type SdkResult = { response: Response; data?: unknown; error?: unknown }
type Captured = { status: number; data?: unknown; error?: unknown }
type ProjectFixture = { sdk: Sdk; directory: string }
type LlmProjectFixture = ProjectFixture & { llm: TestLLMServer["Service"] }

// 异步 ACK 测试会与全仓数千个用例共享 CI runner；轮询窗口需覆盖高负载调度延迟，不能按本机速度只留约 1 秒。
const ASYNC_REPLY_POLL_ATTEMPTS = 400

function app(backend: Backend, input?: { password?: string; username?: string }) {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = backend === "httpapi"
  Flag.WANLAICODE_SERVER_PASSWORD = input?.password
  Flag.WANLAICODE_SERVER_USERNAME = input?.username
  if (backend === "legacy") return Server.Legacy().app

  const handler = HttpRouter.toWebHandler(
    ExperimentalHttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    fetch: (request: Request) => handler(request, ExperimentalHttpApiServer.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function client(
  backend: Backend,
  directory?: string,
  input?: { password?: string; username?: string; headers?: Record<string, string> },
) {
  return createOpencodeClient({
    baseUrl: "http://localhost",
    directory,
    headers: input?.headers,
    fetch: serverFetch(backend, input),
  })
}

function serverFetch(backend: Backend, input?: { password?: string; username?: string }) {
  const serverApp = app(backend, input)
  return Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) =>
      await serverApp.fetch(request instanceof Request ? request : new Request(request, init)),
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function providerConfig(url: string) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

function call<T>(request: () => Promise<T>) {
  return Effect.promise(request)
}

function capture(request: () => Promise<SdkResult>) {
  return call(request).pipe(
    Effect.map((result) => ({
      status: result.response.status,
      data: result.data,
      error: result.error,
    })),
  )
}

function captureThrown(request: () => Promise<unknown>) {
  return call(async () => {
    try {
      await request()
    } catch (error) {
      return error
    }
  })
}

function expectStatus(request: () => Promise<{ response: Response }>, status: number) {
  return call(request).pipe(
    Effect.tap((result) => Effect.sync(() => expect(result.response.status).toBe(status))),
    Effect.asVoid,
  )
}

function firstEvent(open: () => Promise<{ stream: AsyncIterator<unknown> }>) {
  return Effect.acquireRelease(call(open), (events) =>
    call(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
  ).pipe(
    Effect.flatMap((events) => call(() => events.stream.next())),
    Effect.map((result) => result.value),
  )
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function statuses(input: Record<string, Captured>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.status]))
}

function firstPartText(value: unknown) {
  return record(array(record(value).parts)[0]).text
}

function sessionTitles(value: unknown) {
  return array(value)
    .map((item) => record(item).title)
    .filter((title): title is string => typeof title === "string")
    .sort()
}

function resetState() {
  return Effect.promise(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })
}

function httpapi<A, E>(name: string, effect: Effect.Effect<A, E, Scope.Scope>) {
  it.live(name, effect)
}

function parity<A, E>(name: string, scenario: (backend: Backend) => Effect.Effect<A, E, Scope.Scope>) {
  it.live(
    name,
    Effect.gen(function* () {
      const legacy = yield* scenario("legacy")
      yield* resetState()
      const httpapi = yield* scenario("httpapi")
      expect(httpapi).toEqual(legacy)
    }),
  )
}

function withProject<A, E, R>(
  backend: Backend,
  options: { git?: boolean; config?: Partial<Config.Info>; setup?: (dir: string) => Effect.Effect<void> },
  run: (input: ProjectFixture) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireRelease(
    call(() => tmpdir({ git: options.git ?? true, config: { formatter: false, lsp: false, ...options.config } })),
    (tmp) => call(() => tmp[Symbol.asyncDispose]()).pipe(Effect.ignore),
  ).pipe(
    Effect.tap((tmp) => options.setup?.(tmp.path) ?? Effect.void),
    Effect.flatMap((tmp) => run({ sdk: client(backend, tmp.path), directory: tmp.path })),
  )
}

function standardProjectConfig(): Partial<Config.Info> {
  return {
    provider: {
      test: {
        id: "test",
        name: "Test",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: "http://127.0.0.1:1",
        },
      },
    },
  }
}

function withStandardProject<A, E, R>(backend: Backend, run: (input: ProjectFixture) => Effect.Effect<A, E, R>) {
  return withProject(backend, { setup: writeStandardFiles, config: standardProjectConfig() }, run)
}

function withFakeLlm<A, E, R>(backend: Backend, run: (input: LlmProjectFixture) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* withProject(backend, { config: providerConfig(llm.url) }, (input) => run({ ...input, llm }))
  }).pipe(Effect.provide(TestLLMServer.layer))
}

function writeStandardFiles(dir: string) {
  return Effect.all([
    call(() => Bun.write(path.join(dir, "hello.txt"), "hello")),
    call(() => Bun.write(path.join(dir, "needle.ts"), "export const needle = 'sdk-parity'\n")),
  ]).pipe(Effect.asVoid)
}

function seedMessage(directory: string, sessionID: string) {
  const id = SessionID.make(sessionID)
  return call(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () =>
          Effect.runPromise(
            SessionNs.Service.use((svc) =>
              Effect.gen(function* () {
                const message = yield* svc.updateMessage({
                  id: MessageID.ascending(),
                  sessionID: id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: "test",
                  model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
                  tools: {},
                } satisfies MessageV2.User)
                const part = yield* svc.updatePart({
                  id: PartID.ascending(),
                  sessionID: id,
                  messageID: message.id,
                  type: "text",
                  text: "seeded message",
                })
                return { message, part }
              }),
            ).pipe(Effect.provide(SessionNs.defaultLayer)),
          ),
      }),
  )
}

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original.OPENCODE_EXPERIMENTAL_HTTPAPI
  Flag.WANLAICODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.WANLAICODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi SDK", () => {
  httpapi(
    "uses the generated SDK for global and control routes",
    Effect.gen(function* () {
      const sdk = client("httpapi")
      const health = yield* call(() => sdk.global.health())
      const log = yield* call(() => sdk.app.log({ service: "httpapi-sdk-test", level: "info", message: "hello" }))

      expect(health.response.status).toBe(200)
      expect(health.data).toMatchObject({ healthy: true })
      expect(yield* firstEvent(() => sdk.global.event({ signal: AbortSignal.timeout(1_000) }))).toMatchObject({
        payload: { type: "server.connected" },
      })
      expect(log.response.status).toBe(200)
      expect(log.data).toBe(true)
      yield* expectStatus(() => sdk.auth.set({ providerID: "test" }), 400)
    }),
  )

  httpapi(
    "uses the generated SDK for safe instance routes",
    withProject("httpapi", { git: false, setup: writeStandardFiles, config: standardProjectConfig() }, ({ sdk }) =>
      Effect.gen(function* () {
        const file = yield* call(() => sdk.file.read({ path: "hello.txt" }))
        const session = yield* call(() => sdk.session.create({ title: "sdk" }))
        const listed = yield* call(() => sdk.session.list({ roots: true, limit: 10 }))

        expect(file.response.status).toBe(200)
        expect(file.data).toMatchObject({ content: "hello" })
        expect(session.response.status).toBe(200)
        expect(session.data).toMatchObject({ title: "sdk" })
        expect(listed.response.status).toBe(200)
        expect(listed.data?.map((item) => item.id)).toContain(session.data?.id)

        yield* Effect.all([
          expectStatus(() => sdk.project.current(), 200),
          expectStatus(() => sdk.config.get(), 200),
          expectStatus(() => sdk.config.providers(), 200),
          expectStatus(() => sdk.find.files({ query: "hello", limit: 10 }), 200),
        ])
      }),
    ),
  )

  parity("matches generated SDK global and control behavior across backends", (backend) =>
    Effect.gen(function* () {
      const sdk = client(backend)
      const health = yield* capture(() => sdk.global.health())
      const log = yield* capture(() => sdk.app.log({ service: "sdk-parity", level: "info", message: "hello" }))
      const invalidAuth = yield* capture(() => sdk.auth.set({ providerID: "test" }))

      return {
        statuses: statuses({ health, log, invalidAuth }),
        health: record(health.data).healthy,
        log: log.data,
      }
    }),
  )

  parity("matches generated SDK global event stream across backends", (backend) =>
    firstEvent(() => client(backend).global.event({ signal: AbortSignal.timeout(1_000) })).pipe(
      Effect.map((event) => ({ type: record(record(event).payload).type })),
    ),
  )

  parity("matches generated SDK instance event stream across backends", (backend) =>
    withStandardProject(backend, ({ sdk }) =>
      firstEvent(() => sdk.event.subscribe(undefined, { signal: AbortSignal.timeout(1_000) })).pipe(
        Effect.map((event) => ({ type: record(record(event).payload).type })),
      ),
    ),
  )

  parity("matches generated SDK missing session errors across backends", (backend) =>
    withStandardProject(backend, ({ sdk }) =>
      Effect.gen(function* () {
        const sessionID = "ses_missing"
        const expected = {
          name: "NotFoundError",
          data: { message: `Session not found: ${sessionID}` },
        }
        const missing = yield* capture(() => sdk.session.get({ sessionID }))
        const thrown = yield* captureThrown(() => sdk.session.get({ sessionID }, { throwOnError: true }))

        expect(missing.error).toEqual(expected)
        expect(thrown).toEqual(expected)
        return {
          status: missing.status,
          error: missing.error,
          thrown,
        }
      }),
    ),
  )

  parity("formats missing session validation errors for -s", (backend) =>
    withStandardProject(backend, ({ directory }) =>
      Effect.gen(function* () {
        const sessionID = "ses_206f84f18ffeZ6hhD7pFYAiW5T"
        const thrown = yield* captureThrown(() =>
          validateSession({
            url: "http://localhost",
            directory,
            sessionID,
            fetch: serverFetch(backend),
          }),
        )
        expect(errorMessage(thrown)).toBe(`Session not found: ${sessionID}`)
        return errorMessage(thrown)
      }),
    ),
  )

  parity("matches generated SDK basic auth behavior across backends", (backend) =>
    withStandardProject(backend, ({ directory }) =>
      Effect.gen(function* () {
        const missing = yield* capture(() =>
          client(backend, directory, { password: "secret" }).file.read({ path: "hello.txt" }),
        )
        const bad = yield* capture(() =>
          client(backend, directory, {
            password: "secret",
            headers: { authorization: authorization("wanlaicode", "wrong") },
          }).file.read({ path: "hello.txt" }),
        )
        const good = yield* capture(() =>
          client(backend, directory, {
            password: "secret",
            headers: { authorization: authorization("wanlaicode", "secret") },
          }).file.read({ path: "hello.txt" }),
        )

        return {
          statuses: statuses({ missing, bad, good }),
          content: record(good.data).content,
        }
      }),
    ),
  )

  parity("matches generated SDK instance read routes across backends", (backend) =>
    withStandardProject(backend, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const project = yield* capture(() => sdk.project.current())
        const projects = yield* capture(() => sdk.project.list())
        const paths = yield* capture(() => sdk.path.get())
        const config = yield* capture(() => sdk.config.get())
        const providers = yield* capture(() => sdk.config.providers())
        const file = yield* capture(() => sdk.file.read({ path: "hello.txt" }))
        const files = yield* capture(() => sdk.file.list({ path: "." }))
        const fileStatus = yield* capture(() => sdk.file.status())
        const findFiles = yield* capture(() => sdk.find.files({ query: "hello", limit: 10 }))
        const findText = yield* capture(() => sdk.find.text({ pattern: "sdk-parity" }))
        const agents = yield* capture(() => sdk.app.agents())
        const skills = yield* capture(() => sdk.app.skills())
        const tools = yield* capture(() => sdk.tool.ids())
        const vcs = yield* capture(() => sdk.vcs.get())
        const formatter = yield* capture(() => sdk.formatter.status())
        const lsp = yield* capture(() => sdk.lsp.status())

        return {
          statuses: statuses({
            project,
            projects,
            paths,
            config,
            providers,
            file,
            files,
            fileStatus,
            findFiles,
            findText,
            agents,
            skills,
            tools,
            vcs,
            formatter,
            lsp,
          }),
          project: { worktreeSelected: record(project.data).worktree === directory },
          paths: { directorySelected: record(paths.data).directory === directory },
          file: record(file.data).content,
          hasProject: array(projects.data).length > 0,
          foundFile: JSON.stringify(findFiles.data).includes("hello.txt"),
          foundText: JSON.stringify(findText.data ?? null).includes("sdk-parity"),
          listedFile: JSON.stringify(files.data).includes("hello.txt"),
        }
      }),
    ),
  )

  parity("matches generated SDK session lifecycle routes across backends", (backend) =>
    withStandardProject(backend, ({ sdk }) =>
      Effect.gen(function* () {
        const parent = yield* capture(() => sdk.session.create({ title: "parent" }))
        const parentID = String(record(parent.data).id)
        const child = yield* capture(() => sdk.session.create({ title: "child", parentID }))
        const childID = String(record(child.data).id)
        const get = yield* capture(() => sdk.session.get({ sessionID: parentID }))
        const update = yield* capture(() => sdk.session.update({ sessionID: parentID, title: "renamed" }))
        // 桌面模型菜单和手机远控都通过 session.update 写入同一个持久化模型。
        const modelUpdate = yield* capture(() =>
          sdk.session.update({
            sessionID: parentID,
            model: { providerID: "wanlaicode", id: "remote-model", variant: "high" },
          }),
        )
        const remotePermission = "__wanlai_remote_auto_review"
        const autoReview = yield* capture(() =>
          sdk.session.update({
            sessionID: parentID,
            permission: [{ permission: remotePermission, pattern: "*", action: "allow" }],
          }),
        )
        const defaultPermission = yield* capture(() =>
          sdk.session.update({
            sessionID: parentID,
            permission: [{ permission: remotePermission, pattern: "*", action: "deny" }],
          }),
        )
        const roots = yield* capture(() => sdk.session.list({ roots: true, limit: 10 }))
        const all = yield* capture(() => sdk.session.list({ roots: false, limit: 10 }))
        const children = yield* capture(() => sdk.session.children({ sessionID: parentID }))
        const todo = yield* capture(() => sdk.session.todo({ sessionID: parentID }))
        const status = yield* capture(() => sdk.session.status())
        const messages = yield* capture(() => sdk.session.messages({ sessionID: parentID }))
        const missingGet = yield* capture(() => sdk.session.get({ sessionID: "ses_missing" }))
        const missingMessages = yield* capture(() => sdk.session.messages({ sessionID: "ses_missing", limit: 2 }))
        const invalidCursor = yield* capture(() =>
          sdk.session.messages({ sessionID: parentID, limit: 2, before: "bad" }),
        )
        const deleted = yield* capture(() => sdk.session.delete({ sessionID: childID }))
        const getDeleted = yield* capture(() => sdk.session.get({ sessionID: childID }))

        return {
          statuses: statuses({
            parent,
            child,
            get,
            update,
            modelUpdate,
            autoReview,
            defaultPermission,
            roots,
            all,
            children,
            todo,
            status,
            messages,
            missingGet,
            missingMessages,
            invalidCursor,
            deleted,
            getDeleted,
          }),
          getTitle: record(get.data).title,
          updatedTitle: record(update.data).title,
          updatedModel: record(modelUpdate.data).model,
          // 两次权限切换后只允许保留最新 sentinel，避免长期使用造成规则数组增长。
          remotePermissionRules: array(record(defaultPermission.data).permission).filter(
            (rule) => record(rule).permission === remotePermission,
          ),
          rootTitles: sessionTitles(roots.data),
          allTitles: sessionTitles(all.data),
          childCount: array(children.data).length,
          todoCount: array(todo.data).length,
          messageCount: array(messages.data).length,
        }
      }),
    ),
  )

  parity("matches generated SDK session message and part routes across backends", (backend) =>
    withStandardProject(backend, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "messages" }))
        const sessionID = String(record(session.data).id)
        const seeded = yield* seedMessage(directory, sessionID)
        const list = yield* capture(() => sdk.session.messages({ sessionID }))
        const page = yield* capture(() => sdk.session.messages({ sessionID, limit: 1 }))
        const message = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partUpdate = yield* capture(() =>
          sdk.part.update({
            sessionID,
            messageID: seeded.message.id,
            partID: seeded.part.id,
            part: { ...seeded.part, text: "updated message" } as NonNullable<
              Parameters<Sdk["part"]["update"]>[0]["part"]
            >,
          }),
        )
        const updated = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const partDelete = yield* capture(() =>
          sdk.part.delete({ sessionID, messageID: seeded.message.id, partID: seeded.part.id }),
        )
        const withoutPart = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))
        const deleteMessage = yield* capture(() =>
          sdk.session.deleteMessage({ sessionID, messageID: seeded.message.id }),
        )
        const missingMessage = yield* capture(() => sdk.session.message({ sessionID, messageID: seeded.message.id }))

        return {
          statuses: statuses({
            session,
            list,
            page,
            message,
            partUpdate,
            updated,
            partDelete,
            withoutPart,
            deleteMessage,
            missingMessage,
          }),
          listCount: array(list.data).length,
          pageCount: array(page.data).length,
          initialText: firstPartText(message.data),
          updatedText: firstPartText(updated.data),
          partCountAfterDelete: array(record(withoutPart.data).parts).length,
        }
      }),
    ),
  )

  parity("matches generated SDK prompt no-reply routes across backends", (backend) =>
    withStandardProject(backend, ({ sdk }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "prompt" }))
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        )
        const asyncPrompt = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "async hello" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))

        return {
          statuses: statuses({ session, prompt, asyncPrompt, messages }),
          promptRole: record(record(prompt.data).info).role,
          messageCount: array(messages.data).length,
          messageTexts: array(messages.data)
            .flatMap((item) => array(record(item).parts))
            .map((part) => record(part).text)
            .filter((text): text is string => typeof text === "string")
            .sort(),
        }
      }),
    ),
  )

  parity("matches generated SDK prompt streaming through fake LLM across backends", (backend) =>
    withFakeLlm(backend, ({ sdk, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("fake world", { usage: { input: 11, output: 7 } })
        const session = yield* capture(() =>
          sdk.session.create({
            title: "llm prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.prompt({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello llm" }],
          }),
        )
        const messages = yield* capture(() => sdk.session.messages({ sessionID }))
        const inputs = yield* llm.inputs

        return {
          statuses: statuses({ session, prompt, messages }),
          calls: inputs.length,
          requestedModel: inputs[0]?.model,
          responseText: JSON.stringify(prompt.data).includes("fake world"),
          persistedText: JSON.stringify(messages.data).includes("fake world"),
          userText: JSON.stringify(messages.data).includes("hello llm"),
        }
      }),
    ),
  )

  parity("keeps async prompt running after the durable ACK response closes", (backend) =>
    withFakeLlm(backend, ({ sdk, llm }) =>
      Effect.gen(function* () {
        const release = Promise.withResolvers<void>()
        yield* llm.hold("async fake world", release.promise)
        const session = yield* capture(() =>
          sdk.session.create({
            title: "async llm prompt",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const prompt = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "hello async llm" }],
          }),
        )
        release.resolve()

        // 204 只确认用户消息已持久化；请求 scope 关闭后，后台 runner 仍必须继续生成并落下 assistant。
        let messages = yield* capture(() => sdk.session.messages({ sessionID }))
        for (
          let attempt = 0;
          attempt < ASYNC_REPLY_POLL_ATTEMPTS && !JSON.stringify(messages.data).includes("async fake world");
          attempt++
        ) {
          yield* Effect.sleep(10)
          messages = yield* capture(() => sdk.session.messages({ sessionID }))
        }
        const inputs = yield* llm.inputs

        return {
          statuses: statuses({ session, prompt, messages }),
          calls: inputs.length,
          requestedModel: inputs[0]?.model,
          responseText: JSON.stringify(messages.data).includes("async fake world"),
          userText: JSON.stringify(messages.data).includes("hello async llm"),
        }
      }),
    ),
  )

  parity("persists async preflight failures and recovers after switching models", (backend) =>
    withFakeLlm(backend, ({ sdk, llm }) =>
      Effect.gen(function* () {
        const session = yield* capture(() =>
          sdk.session.create({
            title: "async preflight recovery",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        )
        const sessionID = String(record(session.data).id)
        const failed = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "missing-model" },
            parts: [{ type: "text", text: "must persist the preflight failure" }],
          }),
        )

        // 模型解析发生在 assistant 创建前；即使请求已经返回 204，失败也必须形成可刷新的终态答复。
        let messages = yield* capture(() => sdk.session.messages({ sessionID }))
        for (
          let attempt = 0;
          attempt < ASYNC_REPLY_POLL_ATTEMPTS &&
          !array(messages.data).some((message) => record(record(message).info).error);
          attempt++
        ) {
          yield* Effect.sleep(10)
          messages = yield* capture(() => sdk.session.messages({ sessionID }))
        }
        const failedUser = array(messages.data).find(
          (message) => firstPartText(message) === "must persist the preflight failure",
        )
        const failedUserID = String(record(record(failedUser).info).id)
        const failureReply = array(messages.data).find((message) => {
          const info = record(record(message).info)
          return info.role === "assistant" && info.parentID === failedUserID
        })
        const failureInfo = record(record(failureReply).info)

        yield* llm.text("recovered after model switch")
        const recovered = yield* capture(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "continue with the valid model" }],
          }),
        )
        for (
          let attempt = 0;
          attempt < ASYNC_REPLY_POLL_ATTEMPTS &&
          !JSON.stringify(messages.data).includes("recovered after model switch");
          attempt++
        ) {
          yield* Effect.sleep(10)
          messages = yield* capture(() => sdk.session.messages({ sessionID }))
        }

        const result = {
          statuses: statuses({ session, failed, recovered, messages }),
          failureRole: failureInfo.role,
          failureFinish: failureInfo.finish,
          failureCompleted: typeof record(failureInfo.time).completed === "number",
          failureError: typeof record(failureInfo.error).name === "string",
          failureParent: failureInfo.parentID === failedUserID,
          failureCoversOnlyFailedUser: JSON.stringify(failureInfo.completedUserMessageIDs) === JSON.stringify([failedUserID]),
          failureModel: failureInfo.modelID,
          recoveredText: JSON.stringify(messages.data).includes("recovered after model switch"),
          calls: yield* llm.calls,
        }
        expect(result.statuses).toEqual({ session: 200, failed: 204, recovered: 204, messages: 200 })
        expect(result.failureRole).toBe("assistant")
        expect(result.failureFinish).toBe("stop")
        expect(result.failureCompleted).toBe(true)
        expect(result.failureError).toBe(true)
        expect(result.failureParent).toBe(true)
        expect(result.failureCoversOnlyFailedUser).toBe(true)
        expect(result.failureModel).toBe("missing-model")
        expect(result.recoveredText).toBe(true)
        expect(result.calls).toBe(1)
        return result
      }),
    ),
  )

  parity("matches generated SDK TUI validation and command routes across backends", (backend) =>
    withStandardProject(backend, ({ sdk }) =>
      Effect.gen(function* () {
        const session = yield* capture(() => sdk.session.create({ title: "tui" }))
        const sessionID = String(record(session.data).id)
        const appendPrompt = yield* capture(() => sdk.tui.appendPrompt({ text: "hello" }))
        const openHelp = yield* capture(() => sdk.tui.openHelp())
        const openSessions = yield* capture(() => sdk.tui.openSessions())
        const openThemes = yield* capture(() => sdk.tui.openThemes())
        const openModels = yield* capture(() => sdk.tui.openModels())
        const submitPrompt = yield* capture(() => sdk.tui.submitPrompt())
        const clearPrompt = yield* capture(() => sdk.tui.clearPrompt())
        const executeCommand = yield* capture(() => sdk.tui.executeCommand({ command: "session_new" }))
        const showToast = yield* capture(() => sdk.tui.showToast({ title: "SDK", message: "hello", variant: "info" }))
        const selectSession = yield* capture(() => sdk.tui.selectSession({ sessionID }))
        const missingSession = yield* capture(() => sdk.tui.selectSession({ sessionID: "ses_missing" }))
        const invalidSession = yield* capture(() => sdk.tui.selectSession({ sessionID: "invalid_session_id" }))

        return {
          statuses: statuses({
            session,
            appendPrompt,
            openHelp,
            openSessions,
            openThemes,
            openModels,
            submitPrompt,
            clearPrompt,
            executeCommand,
            showToast,
            selectSession,
            missingSession,
            invalidSession,
          }),
          data: {
            appendPrompt: appendPrompt.data,
            openHelp: openHelp.data,
            openSessions: openSessions.data,
            openThemes: openThemes.data,
            openModels: openModels.data,
            submitPrompt: submitPrompt.data,
            clearPrompt: clearPrompt.data,
            executeCommand: executeCommand.data,
            showToast: showToast.data,
            selectSession: selectSession.data,
          },
        }
      }),
    ),
  )

  parity("matches generated SDK project git initialization across backends", (backend) =>
    withProject(backend, { git: false }, ({ sdk, directory }) =>
      Effect.gen(function* () {
        const before = yield* capture(() => sdk.project.current())
        const init = yield* capture(() => sdk.project.initGit())
        const after = yield* capture(() => sdk.project.current())

        return {
          statuses: statuses({ before, init, after }),
          before: {
            vcs: record(before.data).vcs ?? null,
            worktree: record(before.data).worktree,
          },
          init: {
            vcs: record(init.data).vcs,
            worktreeSelected: record(init.data).worktree === directory,
          },
          after: {
            vcs: record(after.data).vcs,
            worktreeSelected: record(after.data).worktree === directory,
          },
        }
      }),
    ),
  )
})
