import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      // 会话运行只需要消息与快照边界；读取层会把历史异常巨型 diff 降级，避免总结任务再次撑爆主进程。
      const all = yield* sessions.messages({ sessionID: input.sessionID })
      if (!all.length) return

      const diffs = yield* computeDiff({ messages: all })
      // 新摘要在写库和发事件前统一裁掉超量 patch；文件路径与增删统计仍完整保留。
      const compactDiffs = MessageV2.compactSummaryDiffs(diffs)
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], compactDiffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: compactDiffs })

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const msgDiffs = yield* computeDiff({ messages })
      // 单回合摘要沿用同一体积契约，防止 session_diff 已压缩但 message.data 仍写入完整巨型 patch。
      target.info.summary = { ...target.info.summary, diffs: MessageV2.compactSummaryDiffs(msgDiffs) }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (input.messageID) {
        const all = yield* sessions.messages({ sessionID: input.sessionID })
        const user = all.find((m) => m.info.id === input.messageID && m.info.role === "user")
        if (user?.info.role === "user" && user.info.summary?.diffs?.length)
          return MessageV2.compactSummaryDiffs(user.info.summary.diffs)
        const turn = all.filter(
          (m) =>
            m.info.id === input.messageID ||
            (m.info.role === "assistant" && m.info.parentID === input.messageID),
        )
        // 旧单回合摘要被读取硬门禁清空后会重新计算；重算结果也必须遵守同一元数据条数上限。
        return MessageV2.compactSummaryDiffs(yield* computeDiff({ messages: turn }))
      }

      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      // 兼容旧 session_diff 文件：首次读取即压缩并回写，后续进入会话不再重复解析近两万条元数据。
      const compacted = MessageV2.compactSummaryDiffs(next)
      if (changed || compacted !== next)
        yield* storage.write(["session_diff", input.sessionID], compacted).pipe(Effect.ignore)
      return compacted
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
