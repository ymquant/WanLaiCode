import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { randomBytes } from "node:crypto"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Log from "@opencode-ai/core/util/log"

const root = path.join(__dirname, "../..")
void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
  fork(input: { sessionID: SessionID; messageID?: MessageID }) {
    return run(SessionNs.Service.use((svc) => svc.fork(input)))
  },
}

async function fill(sessionID: SessionID, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

async function addUser(sessionID: SessionID, text?: string) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  if (text) {
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
}

async function addAssistant(
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string; error?: MessageV2.Assistant["error"] },
) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
    error: opts?.error,
  } as unknown as MessageV2.Info)
  return id
}

async function addCompactionPart(sessionID: SessionID, messageID: MessageID, tailStartID?: MessageID) {
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as any)
}

describe("MessageV2.page", () => {
  test("returns sync result", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 2)

        const result = MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(result).toBeDefined()
        expect(result.items).toBeArray()

        await svc.remove(session.id)
      },
    })
  })

  test("pages backward with opaque cursors", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 6)

        const a = MessageV2.page({ sessionID: session.id, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.items.every((item) => item.parts.length === 1)).toBe(true)
        expect(a.more).toBe(true)
        expect(a.cursor).toBeTruthy()

        const b = MessageV2.page({ sessionID: session.id, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
        expect(b.more).toBe(true)
        expect(b.cursor).toBeTruthy()

        const c = MessageV2.page({ sessionID: session.id, limit: 2, before: b.cursor! })
        expect(c.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(c.more).toBe(false)
        expect(c.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("returns items in chronological order within a page", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 4)

        const result = MessageV2.page({ sessionID: session.id, limit: 4 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)

        await svc.remove(session.id)
      },
    })
  })

  test("keeps a same-millisecond legacy remote parent before its assistant across cursors", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const created = Date.now()
        // 每次生成唯一的远控 ID，避免失败重跑时命中上次残留在其他测试会话中的全局消息主键。
        const parentID = MessageID.make(`msg_remote_${randomBytes(32).toString("hex")}`)
        const assistantID = MessageID.ascending()
        expect(assistantID < parentID).toBe(true)

        await svc.updateMessage({
          id: parentID,
          sessionID: session.id,
          role: "user",
          time: { created },
          agent: "test",
          // 测试消息同样使用正式品牌类型，避免绕开生产接口的 ID 契约。
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        const savedAssistant = await svc.updateMessage({
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          time: { created },
          parentID,
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "default",
          agent: "default",
          path: { cwd: root, root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })

        // 写入层把 assistant 提升到 parent 之后，普通历史与远控历史的所有游标方向必须得到同一因果顺序。
        expect(savedAssistant.time.created).toBe(created + 1)
        const latest = MessageV2.page({ sessionID: session.id, limit: 1 })
        expect(latest.items.map((item) => item.info.id)).toEqual([assistantID])
        const previous = MessageV2.page({ sessionID: session.id, limit: 1, before: latest.cursor })
        expect(previous.items.map((item) => item.info.id)).toEqual([parentID])

        const forward = MessageV2.remoteHistoryPage({
          sessionID: session.id,
          direction: "forward",
          limit: 1,
        })
        expect(forward.items.map((item) => (item.type === "message" ? item.message.info.id : item.messageID))).toEqual([
          parentID,
        ])
        const forwardNext = MessageV2.remoteHistoryPage({
          sessionID: session.id,
          direction: "forward",
          limit: 1,
          cursor: forward.nextCursor,
          highWater: forward.highWater,
        })
        expect(
          forwardNext.items.map((item) => (item.type === "message" ? item.message.info.id : item.messageID)),
        ).toEqual([assistantID])

        const backward = MessageV2.remoteHistoryPage({
          sessionID: session.id,
          direction: "backward",
          limit: 1,
        })
        expect(
          backward.items.map((item) => (item.type === "message" ? item.message.info.id : item.messageID)),
        ).toEqual([assistantID])
        const backwardNext = MessageV2.remoteHistoryPage({
          sessionID: session.id,
          direction: "backward",
          limit: 1,
          cursor: backward.nextCursor,
          highWater: backward.highWater,
        })
        expect(
          backwardNext.items.map((item) => (item.type === "message" ? item.message.info.id : item.messageID)),
        ).toEqual([parentID])

        await svc.remove(session.id)
      },
    })
  })

  test("returns empty items for session with no messages", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const result = MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(result.items).toEqual([])
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("throws NotFoundError for non-existent session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const fake = "non-existent-session" as SessionID
        expect(() => MessageV2.page({ sessionID: fake, limit: 10 })).toThrow("NotFoundError")
      },
    })
  })

  test("handles exact limit boundary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 3)

        const result = MessageV2.page({ sessionID: session.id, limit: 3 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("limit of 1 returns single newest message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const result = MessageV2.page({ sessionID: session.id, limit: 1 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].info.id).toBe(ids[ids.length - 1])
        expect(result.more).toBe(true)

        await svc.remove(session.id)
      },
    })
  })

  test("hydrates multiple parts per message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].parts).toHaveLength(2)

        await svc.remove(session.id)
      },
    })
  })

  test("accepts cursors from fractional timestamps", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 4, (i) => 1000.5 + i)

        const a = MessageV2.page({ sessionID: session.id, limit: 2 })
        const b = MessageV2.page({ sessionID: session.id, limit: 2, before: a.cursor! })

        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))

        await svc.remove(session.id)
      },
    })
  })

  test("messages with the same timestamp keep their first-seen order instead of id order", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = Array.from({ length: 4 }, () => MessageID.ascending())
        const inserted = ids.slice().reverse()
        for (const id of inserted) {
          await svc.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            time: { created: 1000 },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
          } as MessageV2.User)
        }

        const a = MessageV2.page({ sessionID: session.id, limit: 2 })
        // ID 字典序与插入顺序相反；分页仍必须还原官方 turn.items 的 push 顺序。
        expect(a.items.map((item) => item.info.id)).toEqual(inserted.slice(-2))
        expect(a.more).toBe(true)

        const b = MessageV2.page({ sessionID: session.id, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(inserted.slice(0, 2))
        expect(b.more).toBe(false)

        await svc.remove(session.id)
      },
    })
  })

  test("legacy time cursor resolves to first-seen sequence", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const inserted = Array.from({ length: 4 }, () => MessageID.ascending()).reverse()
        for (const id of inserted) {
          await svc.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            time: { created: 1000 },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
          } as MessageV2.User)
        }

        // 旧游标只带 time/id；锚点存在时必须按其 sequence 继续，不能按相反的 ID 字典序漏掉旧页。
        const result = MessageV2.page({
          sessionID: session.id,
          limit: 2,
          before: MessageV2.cursor.encode({ id: inserted[2], time: 1000 }),
        })
        expect(result.items.map((item) => item.info.id)).toEqual(inserted.slice(0, 2))

        await svc.remove(session.id)
      },
    })
  })

  test("does not return messages from other sessions", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const a = await svc.create({})
        const b = await svc.create({})
        await fill(a.id, 3)
        await fill(b.id, 2)

        const resultA = MessageV2.page({ sessionID: a.id, limit: 10 })
        const resultB = MessageV2.page({ sessionID: b.id, limit: 10 })
        expect(resultA.items).toHaveLength(3)
        expect(resultB.items).toHaveLength(2)
        expect(resultA.items.every((item) => item.info.sessionID === a.id)).toBe(true)
        expect(resultB.items.every((item) => item.info.sessionID === b.id)).toBe(true)

        await svc.remove(a.id)
        await svc.remove(b.id)
      },
    })
  })

  test("large limit returns all messages without cursor", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 10)

        const result = MessageV2.page({ sessionID: session.id, limit: 100 })
        expect(result.items).toHaveLength(10)
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.stream", () => {
  test("yields items newest first", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const items = Array.from(MessageV2.stream(session.id))
        expect(items.map((item) => item.info.id)).toEqual(ids.slice().reverse())

        await svc.remove(session.id)
      },
    })
  })

  test("yields nothing for empty session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const items = Array.from(MessageV2.stream(session.id))
        expect(items).toHaveLength(0)

        await svc.remove(session.id)
      },
    })
  })

  test("yields single message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 1)

        const items = Array.from(MessageV2.stream(session.id))
        expect(items).toHaveLength(1)
        expect(items[0].info.id).toBe(ids[0])

        await svc.remove(session.id)
      },
    })
  })

  test("hydrates parts for each yielded message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 3)

        const items = Array.from(MessageV2.stream(session.id))
        for (const item of items) {
          expect(item.parts).toHaveLength(1)
          expect(item.parts[0].type).toBe("text")
        }

        await svc.remove(session.id)
      },
    })
  })

  test("handles sets exceeding internal page size", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 60)

        const items = Array.from(MessageV2.stream(session.id))
        expect(items).toHaveLength(60)
        expect(items[0].info.id).toBe(ids[ids.length - 1])
        expect(items[59].info.id).toBe(ids[0])

        await svc.remove(session.id)
      },
    })
  })

  test("is a sync generator", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 1)

        const gen = MessageV2.stream(session.id)
        const first = gen.next()
        // sync generator returns { value, done } directly, not a Promise
        expect(first).toHaveProperty("value")
        expect(first).toHaveProperty("done")
        expect(first.done).toBe(false)

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.parts", () => {
  test("returns parts for a message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const result = MessageV2.parts(id)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe("text")
        expect((result[0] as MessageV2.TextPart).text).toBe("m0")

        await svc.remove(session.id)
      },
    })
  })

  test("returns empty array for message with no parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const id = await addUser(session.id)

        const result = MessageV2.parts(id)
        expect(result).toEqual([])

        await svc.remove(session.id)
      },
    })
  })

  test("returns multiple parts in order", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "second",
        })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "third",
        })

        const result = MessageV2.parts(id)
        expect(result).toHaveLength(3)
        expect((result[0] as MessageV2.TextPart).text).toBe("m0")
        expect((result[1] as MessageV2.TextPart).text).toBe("second")
        expect((result[2] as MessageV2.TextPart).text).toBe("third")

        await svc.remove(session.id)
      },
    })
  })

  test("returns empty for non-existent message id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        await svc.create({})
        const result = MessageV2.parts(MessageID.ascending())
        expect(result).toEqual([])
      },
    })
  })

  test("parts contain sessionID and messageID", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const result = MessageV2.parts(id)
        expect(result[0].sessionID).toBe(session.id)
        expect(result[0].messageID).toBe(id)

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.get", () => {
  test("returns message with hydrated parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const result = MessageV2.get({ sessionID: session.id, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.info.sessionID).toBe(session.id)
        expect(result.info.role).toBe("user")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as MessageV2.TextPart).text).toBe("m0")

        await svc.remove(session.id)
      },
    })
  })

  test("throws NotFoundError for non-existent message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        expect(() => MessageV2.get({ sessionID: session.id, messageID: MessageID.ascending() })).toThrow(
          "NotFoundError",
        )

        await svc.remove(session.id)
      },
    })
  })

  test("scopes by session id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const a = await svc.create({})
        const b = await svc.create({})
        const [id] = await fill(a.id, 1)

        expect(() => MessageV2.get({ sessionID: b.id, messageID: id })).toThrow("NotFoundError")
        const result = MessageV2.get({ sessionID: a.id, messageID: id })
        expect(result.info.id).toBe(id)

        await svc.remove(a.id)
        await svc.remove(b.id)
      },
    })
  })

  test("returns message with multiple parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = MessageV2.get({ sessionID: session.id, messageID: id })
        expect(result.parts).toHaveLength(2)

        await svc.remove(session.id)
      },
    })
  })

  test("returns assistant message with correct role", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const uid = await addUser(session.id, "hello")
        const aid = await addAssistant(session.id, uid)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: aid,
          type: "text",
          text: "response",
        })

        const result = MessageV2.get({ sessionID: session.id, messageID: aid })
        expect(result.info.role).toBe("assistant")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as MessageV2.TextPart).text).toBe("response")

        await svc.remove(session.id)
      },
    })
  })

  test("returns message with zero parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const id = await addUser(session.id)

        const result = MessageV2.get({ sessionID: session.id, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.parts).toEqual([])

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.filterCompacted", () => {
  test("returns all messages when no compaction", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(result).toHaveLength(5)
        // reversed from newest-first to chronological
        expect(result.map((item) => item.info.id)).toEqual(ids)

        await svc.remove(session.id)
      },
    })
  })

  test("stops at compaction boundary and returns chronological order", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        // Chronological: u1(+compaction part), a1(summary, parentID=u1), u2, a2
        // Stream (newest first): a2, u2, a1(adds u1 to completed), u1(in completed + compaction) -> break
        const u1 = await addUser(session.id, "first question")
        const a1 = await addAssistant(session.id, u1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "summary",
        })
        await addCompactionPart(session.id, u1)

        const u2 = await addUser(session.id, "new question")
        const a2 = await addAssistant(session.id, u2)
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "new response",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        // Includes compaction boundary: u1, a1, u2, a2
        expect(result[0].info.id).toBe(u1)
        expect(result.length).toBe(4)

        await svc.remove(session.id)
      },
    })
  })

  test("handles empty iterable", () => {
    const result = MessageV2.filterCompacted([])
    expect(result).toEqual([])
  })

  test("does not break on compaction part without matching summary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "hello")
        await addCompactionPart(session.id, u1)
        await addUser(session.id, "world")

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(result).toHaveLength(2)

        await svc.remove(session.id)
      },
    })
  })

  test("skips assistant with error even if marked as summary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "hello")
        await addCompactionPart(session.id, u1)

        const error = new MessageV2.APIError({
          message: "boom",
          isRetryable: true,
        }).toObject() as MessageV2.Assistant["error"]
        await addAssistant(session.id, u1, { summary: true, finish: "end_turn", error })
        await addUser(session.id, "retry")

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        // Error assistant doesn't add to completed, so compaction boundary never triggers
        expect(result).toHaveLength(3)

        await svc.remove(session.id)
      },
    })
  })

  test("skips assistant without finish even if marked as summary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "hello")
        await addCompactionPart(session.id, u1)

        // summary=true but no finish
        await addAssistant(session.id, u1, { summary: true })
        await addUser(session.id, "next")

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(result).toHaveLength(3)

        await svc.remove(session.id)
      },
    })
  })

  test("retains original tail when compaction stores tail_start_id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, u2)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = await addUser(session.id, "third")
        const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])

        await svc.remove(session.id)
      },
    })
  })

  test("fork remaps compaction tail_start_id for filterCompacted", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, u2)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = await addUser(session.id, "third")
        const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const parentFiltered = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(parentFiltered.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])

        const forked = await svc.fork({ sessionID: session.id })
        const childFiltered = MessageV2.filterCompacted(MessageV2.stream(forked.id))
        expect(childFiltered).toHaveLength(parentFiltered.length)

        const tailPart = childFiltered.flatMap((m) => m.parts).find((p) => p.type === "compaction")
        expect(tailPart?.type).toBe("compaction")
        if (!tailPart || tailPart.type !== "compaction") throw new Error("Expected forked compaction part")
        expect(tailPart.tail_start_id).toBeDefined()
        expect(childFiltered.some((m) => m.info.id === tailPart.tail_start_id)).toBe(true)

        await svc.remove(forked.id)
        await svc.remove(session.id)
      },
    })
  })

  test("fork preserves complete history across three nested forks", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const sessions = [await svc.create({})]

        for (const index of [1, 2, 3]) {
          const current = sessions.at(-1)!
          const userID = await addUser(current.id, `question ${index}`)
          const assistantID = await addAssistant(current.id, userID, { finish: "end_turn" })
          await svc.updatePart({
            id: PartID.ascending(),
            sessionID: current.id,
            messageID: assistantID,
            type: "text",
            text: `answer ${index}`,
          })

          sessions.push(await svc.fork({ sessionID: current.id }))
        }

        const messages = Array.from(MessageV2.stream(sessions.at(-1)!.id)).reverse()
        const users = messages.filter((message) => message.info.role === "user")
        const assistants = messages.filter((message) => message.info.role === "assistant")
        const userIDs = new Set(users.map((message) => message.info.id))
        expect(users).toHaveLength(3)
        expect(assistants).toHaveLength(3)
        expect(
          users.flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text)),
        ).toEqual(["question 1", "question 2", "question 3"])
        expect(
          assistants.flatMap((message) =>
            message.parts.filter((part) => part.type === "text").map((part) => part.text),
          ),
        ).toEqual(["answer 1", "answer 2", "answer 3"])
        expect(
          assistants.every((message) => message.info.role === "assistant" && userIDs.has(message.info.parentID)),
        ).toBe(true)

        for (const session of sessions.reverse()) await svc.remove(session.id)
      },
    })
  })

  test("fork preserves a nested reply whose legacy parent points outside the source session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const rootSession = await svc.create({})
        const rootUserID = await addUser(rootSession.id, "hello")
        const nestedSession = await svc.fork({ sessionID: rootSession.id })
        const nestedUser = Array.from(MessageV2.stream(nestedSession.id)).find(
          (message) => message.info.role === "user",
        )
        expect(nestedUser?.info.role).toBe("user")
        if (!nestedUser || nestedUser.info.role !== "user") throw new Error("Expected nested user message")

        const assistantID = MessageID.ascending()
        await svc.updateMessage({
          id: assistantID,
          sessionID: nestedSession.id,
          role: "assistant",
          parentID: rootUserID,
          turnID: nestedUser.info.id,
          instructionThrough: nestedUser.info.id,
          time: { created: Date.now(), completed: Date.now() },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "",
          agent: "general",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "end_turn",
        } satisfies MessageV2.Assistant)
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: nestedSession.id,
          messageID: assistantID,
          type: "text",
          text: "complete reply",
        })

        const forked = await svc.fork({ sessionID: nestedSession.id })
        const messages = Array.from(MessageV2.stream(forked.id))
        const clonedUser = messages.find((message) => message.info.role === "user")
        const clonedAssistant = messages.find((message) => message.info.role === "assistant")
        expect(clonedUser?.info.role).toBe("user")
        expect(clonedAssistant?.info.role).toBe("assistant")
        if (clonedUser?.info.role !== "user" || clonedAssistant?.info.role !== "assistant") {
          throw new Error("Expected complete nested fork history")
        }
        expect(clonedAssistant.info.parentID).toBe(clonedUser.info.id)
        expect(clonedAssistant.parts.find((part) => part.type === "text")?.text).toBe("complete reply")

        await svc.remove(forked.id)
        await svc.remove(nestedSession.id)
        await svc.remove(rootSession.id)
      },
    })
  })

  test("fork remaps forward references and clears references outside the copied range", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const created = Date.now()
        const futureUserID = MessageID.ascending()
        const futureSubtaskID = PartID.ascending()
        const assistantID = MessageID.ascending()

        // 故意让 assistant 在排序上早于它引用的 user/part，模拟导入历史或同毫秒异构 ID 的前向引用。
        await svc.updateMessage({
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          parentID: futureUserID,
          instructionThrough: futureUserID,
          time: { created, completed: created + 1 },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "",
          agent: "general",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "tool-calls",
        } satisfies MessageV2.Assistant)
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistantID,
          type: "tool",
          callID: "forward-subtask-marker",
          tool: "task",
          state: {
            status: "completed",
            input: { prompt: "forward task", description: "forward task", subagent_type: "general" },
            output: "done",
            title: "forward task",
            metadata: { internalSubtaskPartID: futureSubtaskID },
            time: { start: created, end: created + 1 },
          },
        } satisfies MessageV2.ToolPart)
        await svc.updateMessage({
          id: futureUserID,
          sessionID: session.id,
          role: "user",
          time: { created: created + 10 },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        } satisfies MessageV2.User)
        await svc.updatePart({
          id: futureSubtaskID,
          sessionID: session.id,
          messageID: futureUserID,
          type: "subtask",
          prompt: "forward task",
          description: "forward task",
          agent: "general",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        } satisfies MessageV2.SubtaskPart)

        const fullFork = await svc.fork({ sessionID: session.id })
        const fullMessages = Array.from(MessageV2.stream(fullFork.id))
        const clonedUser = fullMessages.find((message) => message.info.role === "user")
        const clonedAssistant = fullMessages.find((message) => message.info.role === "assistant")
        const clonedSubtask = fullMessages.flatMap((message) => message.parts).find((part) => part.type === "subtask")
        const clonedTool = fullMessages.flatMap((message) => message.parts).find((part) => part.type === "tool")
        expect(clonedUser?.info.role).toBe("user")
        expect(clonedAssistant?.info.role).toBe("assistant")
        expect(clonedSubtask?.type).toBe("subtask")
        expect(clonedTool?.type).toBe("tool")
        if (
          clonedUser?.info.role === "user" &&
          clonedAssistant?.info.role === "assistant" &&
          clonedSubtask?.type === "subtask" &&
          clonedTool?.type === "tool" &&
          "metadata" in clonedTool.state
        ) {
          expect(clonedAssistant.info.parentID).toBe(clonedUser.info.id)
          expect(clonedAssistant.info.instructionThrough).toBe(clonedUser.info.id)
          expect(clonedTool.state.metadata?.internalSubtaskPartID).toBe(clonedSubtask.id)
        }

        const truncatedFork = await svc.fork({ sessionID: session.id, messageID: futureUserID })
        const truncatedMessages = Array.from(MessageV2.stream(truncatedFork.id))
        // parent 位于截断范围外时 assistant 无法形成合法记录，必须连同其 tool part 一起跳过。
        expect(truncatedMessages).toHaveLength(0)

        await svc.remove(truncatedFork.id)
        await svc.remove(fullFork.id)
        await svc.remove(session.id)
      },
    })
  })

  // fork 会重写消息主键，回合身份、引导目标和完成集合也必须全部指向子会话的新主键。
  test("fork remaps persisted logical turn links", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const rootID = MessageID.ascending()
        const steerID = MessageID.ascending()
        await svc.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          turnID: rootID,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await svc.updateMessage({
          id: steerID,
          sessionID: session.id,
          role: "user",
          turnID: rootID,
          steerTargetTurnID: rootID,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await svc.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          turnID: rootID,
          parentID: steerID,
          completedUserMessageIDs: [rootID, steerID],
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "",
          agent: "default",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })

        const forked = await svc.fork({ sessionID: session.id })
        const child = [...MessageV2.stream(forked.id)]
        // 相同毫秒落库的消息不依赖数组顺序，以角色和持久化链接识别各自身份。
        const childRoot = child.find(
          (message) => message.info.role === "user" && !message.info.steerTargetTurnID,
        )?.info
        const childSteer = child.find(
          (message) => message.info.role === "user" && !!message.info.steerTargetTurnID,
        )?.info
        const childAssistant = child.find((message) => message.info.role === "assistant")?.info
        expect(childRoot?.role).toBe("user")
        expect(childSteer?.role).toBe("user")
        expect(childAssistant?.role).toBe("assistant")
        // 显式收窄角色后再校验品牌化 MessageID，避免可选链把 undefined 混入期望集合。
        if (childRoot?.role !== "user" || childSteer?.role !== "user" || childAssistant?.role !== "assistant") {
          throw new Error("Expected forked turn messages")
        }
        expect(childRoot.turnID).toBe(childRoot.id)
        expect(childSteer.turnID).toBe(childRoot.id)
        expect(childSteer.steerTargetTurnID).toBe(childRoot.id)
        expect(childAssistant.turnID).toBe(childRoot.id)
        expect(childAssistant.parentID).toBe(childSteer.id)
        expect(childAssistant.completedUserMessageIDs).toEqual([childRoot.id, childSteer.id])

        await svc.remove(forked.id)
        await svc.remove(session.id)
      },
    })
  })

  // 早期历史只有 text marker，没有结构化 turn 字段；fork 仍需保持引导目标在子会话内闭合。
  test("fork remaps legacy manual steer marker", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const rootID = MessageID.ascending()
        await svc.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: rootID,
          type: "text",
          text: "root",
        })
        const steerID = MessageID.ascending()
        await svc.updateMessage({
          id: steerID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() + 1 },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: steerID,
          type: "text",
          text: "legacy steer context",
          synthetic: true,
          metadata: { manual_steer_target_turn_id: rootID },
        })

        const forked = await svc.fork({ sessionID: session.id })
        const child = [...MessageV2.stream(forked.id)]
        const childRoot = child.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "root"),
        )
        const childMarker = child
          .flatMap((message) => message.parts)
          .find(
            (part) =>
              part.type === "text" && typeof part.metadata?.manual_steer_target_turn_id === "string",
          )
        expect(childRoot?.info.role).toBe("user")
        expect(childMarker?.type).toBe("text")
        if (!childRoot || childRoot.info.role !== "user" || childMarker?.type !== "text") {
          throw new Error("Expected forked legacy steer history")
        }
        expect(childRoot.info.id).not.toBe(rootID)
        expect(childMarker.metadata?.manual_steer_target_turn_id).toBe(childRoot.info.id)

        const sourceMarker = [...MessageV2.stream(session.id)]
          .flatMap((message) => message.parts)
          .find((part) => part.type === "text" && part.text === "legacy steer context")
        // 克隆时只改子会话 metadata，源会话 marker 必须保持原始目标。
        expect(sourceMarker?.type).toBe("text")
        if (sourceMarker?.type === "text") {
          expect(sourceMarker.metadata?.manual_steer_target_turn_id).toBe(rootID)
        }

        await svc.remove(forked.id)
        await svc.remove(session.id)
      },
    })
  })

  test("retains an assistant tail when compaction starts inside a turn", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })
        const a3 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "tail reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, a3)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = await addUser(session.id, "third")
        const a4 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a4,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, a3, u3, a4])

        await svc.remove(session.id)
      },
    })
  })

  test("prefers latest compaction boundary when repeated compactions exist", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, u2)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary one",
        })

        const u3 = await addUser(session.id, "third")
        const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const c2 = await addUser(session.id)
        await addCompactionPart(session.id, c2, u3)
        const s2 = await addAssistant(session.id, c2, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s2,
          type: "text",
          text: "summary two",
        })

        const u4 = await addUser(session.id, "fourth")
        const a4 = await addAssistant(session.id, u4, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a4,
          type: "text",
          text: "fourth reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))

        expect(result.map((item) => item.info.id)).toEqual([c2, s2, u3, a3, u4, a4])

        await svc.remove(session.id)
      },
    })
  })

  test("works with array input", () => {
    // filterCompacted accepts any Iterable, not just generators
    const id = MessageID.ascending()
    const items: MessageV2.WithParts[] = [
      {
        info: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as unknown as MessageV2.Info,
        parts: [{ type: "text", text: "hello" }] as unknown as MessageV2.Part[],
      },
    ]
    const result = MessageV2.filterCompacted(items)
    expect(result).toHaveLength(1)
    expect(result[0].info.id).toBe(id)
  })
})

describe("MessageV2.cursor", () => {
  test("encode/decode roundtrip", () => {
    const input = { id: MessageID.ascending(), sequence: 42 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(input.id)
    expect("sequence" in decoded ? decoded.sequence : undefined).toBe(input.sequence)
  })

  test("decodes legacy cursors with fractional time", () => {
    const input = { id: MessageID.ascending(), time: 1234567890.5 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect("time" in decoded ? decoded.time : undefined).toBe(1234567890.5)
  })

  test("encoded cursor is base64url", () => {
    const encoded = MessageV2.cursor.encode({ id: MessageID.ascending(), sequence: 0 })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("MessageV2 consistency", () => {
  test("page hydration matches get for each message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 3)

        const paged = MessageV2.page({ sessionID: session.id, limit: 10 })
        for (const item of paged.items) {
          const got = MessageV2.get({ sessionID: session.id, messageID: item.info.id as MessageID })
          expect(got.info).toEqual(item.info)
          expect(got.parts).toEqual(item.parts)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("parts from get match standalone parts call", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const got = MessageV2.get({ sessionID: session.id, messageID: id })
        const standalone = MessageV2.parts(id)
        expect(got.parts).toEqual(standalone)

        await svc.remove(session.id)
      },
    })
  })

  test("stream collects same messages as exhaustive page iteration", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 7)

        const streamed = Array.from(MessageV2.stream(session.id))

        const paged = [] as MessageV2.WithParts[]
        let cursor: string | undefined
        while (true) {
          const result = MessageV2.page({ sessionID: session.id, limit: 3, before: cursor })
          for (let i = result.items.length - 1; i >= 0; i--) {
            paged.push(result.items[i])
          }
          if (!result.more || !result.cursor) break
          cursor = result.cursor
        }

        expect(streamed.map((m) => m.info.id)).toEqual(paged.map((m) => m.info.id))

        await svc.remove(session.id)
      },
    })
  })

  test("filterCompacted of full stream returns same as Array.from when no compaction", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 4)

        const filtered = MessageV2.filterCompacted(MessageV2.stream(session.id))
        const all = Array.from(MessageV2.stream(session.id)).reverse()

        expect(filtered.map((m) => m.info.id)).toEqual(all.map((m) => m.info.id))

        await svc.remove(session.id)
      },
    })
  })
})
