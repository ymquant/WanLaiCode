import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { NotFoundError, Storage } from "@/storage/storage"
import { SyncEvent } from "../sync"
import * as Log from "@opencode-ai/core/util/log"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID })
      let lastUser: MessageV2.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      // messages() 已按 first-seen 顺序恢复；旧 msg_remote_<hash> 与后发引导的 ID 字典序都不代表真实先后，
      // diff 必须从 revert 锚点在数组中的位置开始计算。
      const revertIndex = all.findIndex((msg) => msg.info.id === rev.messageID)
      const range = revertIndex < 0 ? [] : all.slice(revertIndex)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID })
      const messageID = session.revert.messageID
      const partID = session.revert.partID
      // 清理边界沿用 messages() 的 first-seen 顺序：有 partID 时保留锚点消息并删除其后消息，
      // 否则连锚点消息一起删除。不能用 ID 大小判断，否则远控消息或后发引导会被误删。
      const targetIndex = msgs.findIndex((msg) => msg.info.id === messageID)
      // 锚点缺失通常表示数据损坏或并发删除；必须保留 revert 与消息原状，让用户仍可 unrevert，
      // 同时用可检索的会话/消息 ID 失败，不能静默 clearRevert 后把本应删除的尾部留在历史中。
      if (targetIndex < 0) {
        log.error("revert cleanup target missing", {
          sessionID,
          messageID,
          partID,
        })
        throw new NotFoundError({ message: `Revert target not found: ${messageID} (session ${sessionID})` })
      }
      const target = msgs[targetIndex]!
      const partIndex = partID ? target.parts.findIndex((part) => part.id === partID) : undefined
      // part 也是 revert 边界的一部分；必须在删除后续消息前完成校验，避免失败时只清理了一半。
      if (partIndex !== undefined && partIndex < 0) {
        log.error("revert cleanup part target missing", {
          sessionID,
          messageID,
          partID,
        })
        throw new NotFoundError({
          message: `Revert part target not found: ${partID} (message ${messageID}, session ${sessionID})`,
        })
      }
      const remove = msgs.slice(targetIndex + (partID ? 1 : 0))
      for (const msg of remove) {
        yield* sync.run(MessageV2.Event.Removed, {
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (partIndex !== undefined) {
        const removeParts = target.parts.slice(partIndex)
        target.parts = target.parts.slice(0, partIndex)
        for (const part of removeParts) {
          yield* sync.run(MessageV2.Event.PartRemoved, {
            sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
