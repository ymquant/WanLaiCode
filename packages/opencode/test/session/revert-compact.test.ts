import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionRevert } from "../../src/session/revert"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { NotFoundError } from "../../src/storage/storage"
import * as Log from "@opencode-ai/core/util/log"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

const user = Effect.fn("test.user")(function* (sessionID: SessionID, agent = "default") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent,
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

const text = Effect.fn("test.text")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text: content,
  })
})

const tool = Effect.fn("test.tool")(function* (sessionID: SessionID, messageID: MessageID) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool" as const,
    tool: "bash",
    callID: "call-1",
    state: {
      status: "completed" as const,
      input: {},
      output: "done",
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  })
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

describe("revert + compact workflow", () => {
  it.live(
    "should properly handle compact command after revert",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sessionID = info.id

          const userMsg1 = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg1.id,
            sessionID,
            type: "text",
            text: "Hello, please help me",
          })

          const assistantMsg1: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: userMsg1.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg1)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg1.id,
            sessionID,
            type: "text",
            text: "Sure, I'll help you!",
          })

          const userMsg2 = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg2.id,
            sessionID,
            type: "text",
            text: "What's the capital of France?",
          })

          const assistantMsg2: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: userMsg2.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg2)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg2.id,
            sessionID,
            type: "text",
            text: "The capital of France is Paris.",
          })

          let messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(4)
          const messageIds = messages.map((m) => m.info.id)
          expect(messageIds).toContain(userMsg1.id)
          expect(messageIds).toContain(userMsg2.id)
          expect(messageIds).toContain(assistantMsg1.id)
          expect(messageIds).toContain(assistantMsg2.id)

          yield* revert.revert({
            sessionID,
            messageID: userMsg2.id,
          })

          let sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeDefined()
          expect(sessionInfo.revert?.messageID).toBeDefined()

          messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(4)

          yield* revert.cleanup(sessionInfo)

          messages = yield* session.messages({ sessionID })
          const remainingIds = messages.map((m) => m.info.id)
          expect(messages.length).toBeLessThan(4)
          expect(remainingIds).not.toContain(userMsg2.id)
          expect(remainingIds).not.toContain(assistantMsg2.id)

          sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeUndefined()

          yield* session.remove(sessionID)
        }),
      { git: true },
    ),
  )

  it.live(
    "should properly clean up revert state before creating compaction message",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sessionID = info.id

          const userMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg.id,
            sessionID,
            type: "text",
            text: "Hello",
          })

          const assistantMsg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: userMsg.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg.id,
            sessionID,
            type: "text",
            text: "Hi there!",
          })

          yield* revert.revert({
            sessionID,
            messageID: userMsg.id,
          })

          let sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeDefined()

          yield* revert.cleanup(sessionInfo)

          sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeUndefined()

          const messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(0)

          yield* session.remove(sessionID)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup with partID removes parts from the revert point onward",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          const p1 = yield* text(sid, u1.id, "first part")
          const p2 = yield* tool(sid, u1.id)
          yield* text(sid, u1.id, "third part")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id, partID: p2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          expect(msgs.length).toBe(1)
          expect(msgs[0].parts.length).toBe(1)
          expect(msgs[0].parts[0].id).toBe(p1.id)

          const cleared = yield* session.get(sid)
          expect(cleared.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup removes messages after revert point but keeps earlier ones",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "hi back")

          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second question")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "second answer")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          const ids = msgs.map((m) => m.info.id)
          expect(ids).toContain(u1.id)
          expect(ids).toContain(a1.id)
          expect(ids).not.toContain(u2.id)
          expect(ids).not.toContain(a2.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup follows message order when a legacy remote ID sorts after newer IDs",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const sid = (yield* session.create({})).id
          const created = Date.now()

          // 旧 remote ID 字典序大于后续标准 ID，但 time.created 明确更早。
          const legacyUser = yield* session.updateMessage({
            id: MessageID.make(`msg_remote_${"z".repeat(64)}`),
            role: "user" as const,
            sessionID: sid,
            agent: "default",
            model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
            time: { created },
          })
          yield* text(sid, legacyUser.id, "legacy question")
          const legacyAssistant = yield* session.updateMessage({
            id: MessageID.make("msg_019f0000000000000000000001"),
            role: "assistant" as const,
            sessionID: sid,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens,
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: legacyUser.id,
            time: { created: created + 1 },
            finish: "end_turn",
          })

          const newerUser = yield* session.updateMessage({
            id: MessageID.make("msg_019f0000000000000000000002"),
            role: "user" as const,
            sessionID: sid,
            agent: "default",
            model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
            time: { created: created + 2 },
          })
          yield* text(sid, newerUser.id, "new question")
          const newerAssistant = yield* session.updateMessage({
            id: MessageID.make("msg_019f0000000000000000000003"),
            role: "assistant" as const,
            sessionID: sid,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens,
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: newerUser.id,
            time: { created: created + 3 },
            finish: "end_turn",
          })

          const ordered = (yield* session.messages({ sessionID: sid })).map((message) => message.info.id)
          expect(ordered).toEqual([legacyUser.id, legacyAssistant.id, newerUser.id, newerAssistant.id])

          const reverted = yield* revert.revert({ sessionID: sid, messageID: newerUser.id })
          expect(reverted.revert?.messageID).toBe(newerUser.id)
          yield* revert.cleanup(reverted)

          const remaining = (yield* session.messages({ sessionID: sid })).map((message) => message.info.id)
          expect(remaining).toEqual([legacyUser.id, legacyAssistant.id])
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup keeps revert state and messages when the target is missing",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const sid = (yield* session.create({})).id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first question")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "first answer")

          const missing = MessageID.make("msg_missing_revert_target")
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: missing },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          // 缺失锚点时 cleanup 必须明确失败，并完整保留现场供 unrevert 恢复。
          const exit = yield* Effect.exit(revert.cleanup(yield* session.get(sid)))
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const failure = Cause.squash(exit.cause)
            expect(NotFoundError.isInstance(failure)).toBe(true)
            if (NotFoundError.isInstance(failure)) expect(failure.data.message).toContain(missing)
          }

          expect((yield* session.messages({ sessionID: sid })).map((message) => message.info.id)).toEqual([
            u1.id,
            a1.id,
          ])
          expect((yield* session.get(sid)).revert?.messageID).toBe(missing)

          // 失败后仍可显式 unrevert 解锁会话，且不会丢失任何原始消息。
          yield* revert.unrevert({ sessionID: sid })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect((yield* session.messages({ sessionID: sid })).map((message) => message.info.id)).toEqual([
            u1.id,
            a1.id,
          ])
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup follows first-seen order for reverse ids created in the same millisecond",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const created = 1_700_000_000_000

          // 三条消息共用时间戳且 ID 逆序，只有数据库记录的 first-seen 位置能表达真实先后。
          const ids = [MessageID.make("msg_z_first"), MessageID.make("msg_a_target"), MessageID.make("msg_m_after")]
          for (const id of ids) {
            yield* session.updateMessage({
              id,
              role: "user",
              sessionID: info.id,
              agent: "default",
              model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
              time: { created },
            })
          }

          yield* session.setRevert({
            sessionID: info.id,
            revert: { messageID: ids[1] },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* revert.cleanup(yield* session.get(info.id))

          // 回退点之前的 first-seen 消息保留，目标和之后的消息均被删除，不受 ID 字典序影响。
          expect((yield* session.messages({ sessionID: info.id })).map((message) => message.info.id)).toEqual([ids[0]])
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup does not partially delete messages when the part target is missing",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const sid = (yield* session.create({})).id

          const u1 = yield* user(sid)
          const p1 = yield* text(sid, u1.id, "first question")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "first answer")
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second question")

          const missing = PartID.make("prt_missing_revert_target")
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id, partID: missing },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          // part 锚点必须先于任何消息删除完成校验，失败后整个历史与 revert 状态保持原样。
          const exit = yield* Effect.exit(revert.cleanup(yield* session.get(sid)))
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const failure = Cause.squash(exit.cause)
            expect(NotFoundError.isInstance(failure)).toBe(true)
            if (NotFoundError.isInstance(failure)) expect(failure.data.message).toContain(missing)
          }

          const messages = yield* session.messages({ sessionID: sid })
          expect(messages.map((message) => message.info.id)).toEqual([u1.id, a1.id, u2.id])
          expect(messages[0]?.parts.map((part) => part.id)).toEqual([p1.id])
          expect((yield* session.get(sid)).revert).toMatchObject({ messageID: u1.id, partID: missing })

          yield* revert.unrevert({ sessionID: sid })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect((yield* session.messages({ sessionID: sid })).map((message) => message.info.id)).toEqual([
            u1.id,
            a1.id,
            u2.id,
          ])
        }),
      { git: true },
    ),
  )

  it.live(
    "revert computes the diff range from first-seen position instead of id order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const info = yield* session.create({})
          const targetID = MessageID.make("msg_z_target")

          // 目标使用较大 ID，随后写入的 assistant 使用常规较小 ID，用真实快照验证差异范围没有被字典序截断。
          yield* session.updateMessage({
            id: targetID,
            role: "user",
            sessionID: info.id,
            agent: "default",
            model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
            time: { created: 1_700_000_000_000 },
          })
          yield* text(info.id, targetID, "change a.txt")
          const reply = yield* assistant(info.id, targetID, dir)
          yield* write(path.join(dir, "a.txt"), "before\n")
          const before = yield* snapshot.track()
          if (!before) throw new Error("expected snapshot before change")
          yield* write(path.join(dir, "a.txt"), "after\n")
          const after = yield* snapshot.track()
          if (!after) throw new Error("expected snapshot after change")
          const patch = yield* snapshot.patch(before)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: info.id,
            type: "step-start",
            snapshot: before,
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: info.id,
            type: "step-finish",
            reason: "stop",
            snapshot: after,
            cost: 0,
            tokens,
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: info.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          const reverted = yield* revert.revert({ sessionID: info.id, messageID: targetID })

          // assistant 虽然 ID 更小但位置更晚，仍应参与恢复和回退摘要计算。
          expect(yield* read(path.join(dir, "a.txt"))).toBe("before\n")
          expect(reverted.summary?.files).toBe(1)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup is a no-op when session has no revert state",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")

          const state = yield* session.get(sid)
          expect(state.revert).toBeUndefined()
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          expect(msgs.length).toBe(1)
        }),
      { git: true },
    ),
  )

  it.live(
    "restore messages in sequential order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          yield* write(path.join(dir, "b.txt"), "b0")
          yield* write(path.join(dir, "c.txt"), "c0")

          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.turn")(function* (file: string, next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `${file}:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, file), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          const first = yield* turn("a.txt", "a1")
          const second = yield* turn("b.txt", "b2")
          const third = yield* turn("c.txt", "c3")

          yield* revert.revert({
            sessionID: sid,
            messageID: first,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(first)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.revert({
            sessionID: sid,
            messageID: second,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(second)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.revert({
            sessionID: sid,
            messageID: third,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(third)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b2")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.unrevert({
            sessionID: sid,
          })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b2")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c3")
        }),
      { git: true },
    ),
  )

  it.live(
    "restore same file in sequential order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "a0")

          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.turnSame")(function* (next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `a.txt:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, "a.txt"), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          const first = yield* turn("a1")
          const second = yield* turn("a2")
          const third = yield* turn("a3")
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a3")

          yield* revert.revert({
            sessionID: sid,
            messageID: first,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(first)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")

          yield* revert.revert({
            sessionID: sid,
            messageID: second,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(second)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")

          yield* revert.revert({
            sessionID: sid,
            messageID: third,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(third)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a2")

          yield* revert.unrevert({
            sessionID: sid,
          })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a3")
        }),
      { git: true },
    ),
  )
})
