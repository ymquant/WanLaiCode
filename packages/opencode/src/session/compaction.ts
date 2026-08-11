import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { languageName } from "./system"
import z from "zod"
import { Token } from "@/util/token"
import * as Log from "@opencode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, isOverflowSize as overflowSize, usable } from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[]; language?: string }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  // 摘要跟随客户端显示语言：把表头与正文都写成该语言（模板仅用作结构/顺序参考）。
  const lang = input.language
    ? `Write the entire summary in ${languageName(input.language)}, including translating the section titles. Keep the structure and section order shown in the template.`
    : undefined
  return [anchor, SUMMARY_TEMPLATE, ...input.context, ...(lang ? [lang] : [])].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  const seen = new Set<MessageID>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    // 普通队列可能先落在 active 根消息与后续 steer 之间；同一物理回合无论是否连续都只能建立一个压缩分段。
    const turnID = MessageV2.userTurnID(msg.info)
    if (seen.has(turnID)) continue
    seen.add(turnID)
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly isOverflowMessages: (input: {
    messages: MessageV2.WithParts[]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly shouldCompact: (input: {
    lastFinished: MessageV2.Assistant
    messages: MessageV2.WithParts[]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
    continuationTurnID?: MessageID
    preserveTailStartID?: MessageID
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const isOverflowMessages = Effect.fn("SessionCompaction.isOverflowMessages")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const size = yield* estimate(input)
      return overflowSize({ cfg: yield* config.get(), size, model: input.model })
    })

    // 是否应在本轮请求前主动压缩。
    // estimate 始终兜底：按当前实际要发送的消息体积预估，即使上游 usage 缺失/失真也能判定溢出
    // （线上曾出现网关未透传 usage 致 isOverflow 恒为 false，上下文撑到模型上限数倍仍不压缩）。
    // 同模型时上一轮 usage 自报值可比，额外用它在 estimate 之外更早/更准触发。
    const shouldCompact = Effect.fn("SessionCompaction.shouldCompact")(function* (input: {
      lastFinished: MessageV2.Assistant
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      if (yield* isOverflowMessages({ messages: input.messages, model: input.model })) return true
      const sameModel =
        input.lastFinished.providerID === input.model.providerID && input.lastFinished.modelID === input.model.id
      if (sameModel) return yield* isOverflow({ tokens: input.lastFinished.tokens, model: input.model })
      return false
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      const seenTurnIDs = new Set<MessageID>()
      const turnIDByUserMessageID = new Map(
        msgs.flatMap((message) =>
          message.info.role === "user" ? [[message.info.id, MessageV2.userTurnID(message.info)] as const] : [],
        ),
      )
      const protectedTurnIDs = new Set<MessageID>()
      // prune 原本至少保护最新两个 user 边界；先按物理身份取两个回合，后续即可跨过插队消息保护同回合的早期工具输出。
      for (let msgIndex = msgs.length - 1; msgIndex >= 0 && protectedTurnIDs.size < 2; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") protectedTurnIDs.add(MessageV2.userTurnID(msg.info))
      }

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        // 倒序计数全局按物理回合去重，A → 队列 B → steer A 不能把 A 错算两次。
        if (msg.info.role === "user") {
          const turnID = MessageV2.userTurnID(msg.info)
          seenTurnIDs.add(turnID)
        }
        if (seenTurnIDs.size < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        // 新历史直接读取 assistant.turnID，旧历史则由 parent user 回推；两个受保护回合即使交错也不能被裁剪。
        const turnID =
          msg.info.role === "user"
            ? MessageV2.userTurnID(msg.info)
            : (msg.info.turnID ?? turnIDByUserMessageID.get(msg.info.parentID))
        if (turnID && protectedTurnIDs.has(turnID)) continue
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
      // 压缩触发消息(带 compaction part)不带客户端语言/翻译设置；从历史里最近一条真实用户消息取，
      // 让摘要与 reasoning 都跟随客户端的显示语言与「翻译推理」设置。
      const clientUser = (() => {
        for (let i = input.messages.length - 1; i >= 0; i--) {
          const info = input.messages[i].info
          if (info.role === "user" && info.language) return info
        }
        return undefined
      })()
      const summaryLanguage = clientUser?.language

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // 普通队列会从当前回合的压缩输入中剔除，因此必须以 marker 上的锚点参与截断边界计算。
      // 在自然保留尾部和待执行队列之间取时间线上更早者，既不把队列写进摘要，也不遗漏自然尾部上下文。
      const timeline = new Map(
        (yield* session.messages({ sessionID: input.sessionID })).map((message, index) => [message.info.id, index]),
      )
      const tailStartID = [compactionPart?.tail_start_id, selected.tail_start_id]
        .filter((id): id is MessageID => id !== undefined && timeline.has(id))
        .reduce<MessageID | undefined>((earliest, id) => {
          if (!earliest) return id
          return timeline.get(id)! < timeline.get(earliest)! ? id : earliest
        }, undefined)
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt =
        compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context, language: summaryLanguage })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        // 压缩摘要是当前逻辑回合的内部步骤，必须与触发压缩的用户消息保持同一回合身份。
        turnID: MessageV2.userTurnID(userMessage),
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        // 摘要与 reasoning 跟随客户端显示语言；reasoning 是否翻译跟随客户端「翻译推理」设置
        user: { ...userMessage, language: summaryLanguage, translateContent: clientUser?.translateContent },
      })
      const result = yield* processor.process({
        // 不给系统级语言指令(否则模型原生用该语言思考→中英混杂且跳过翻译丢失原文)；
        // 摘要语言由 buildPrompt 指令保证，reasoning 由 translateContent 翻译(保留原文+可切换)
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && tailStartID && compactionPart.tail_start_id !== tailStartID) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: tailStartID,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            // overflow replay 重新创建消息但不创建新回合，后续 assistant 仍归原活动 turn。
            turnID: MessageV2.userTurnID(userMessage),
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
            continuationTurnID: MessageV2.userTurnID(userMessage),
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              // 自动续跑只是压缩后的内部输入，持久化身份必须沿用压缩前的逻辑回合。
              turnID: MessageV2.userTurnID(userMessage),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
              continuationTurnID: MessageV2.userTurnID(userMessage),
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID })).find((item) => item.info.id === msg.id) ?? {
            info: msg,
            parts: [],
          },
        )
        EventV2.run(SessionEvent.Compaction.Ended.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          text: summary ?? "",
          include: tailStartID,
        })
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
      continuationTurnID?: MessageID
      preserveTailStartID?: MessageID
    }) {
      const messageID = MessageID.ascending()
      const msg = yield* session.updateMessage({
        id: messageID,
        role: "user",
        // 自动压缩沿用触发它的回合；手动压缩没有上游身份时以自身消息 ID 开启回合。
        turnID: input.continuationTurnID ?? messageID,
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
        // 自动压缩属于触发它的模型回合；持久化关联后，恢复与引导都不会把它误当成独立请求。
        continuationTurnID: input.continuationTurnID,
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        // 提前持久化待执行队列锚点；即使压缩结果不需要自然尾部，filterCompacted 也不能截断未回答消息。
        tail_start_id: input.preserveTailStartID,
      })
      EventV2.run(SessionEvent.Compaction.Started.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        reason: input.auto ? "auto" : "manual",
      })
    })

    return Service.of({
      isOverflow,
      isOverflowMessages,
      shouldCompact,
      estimate,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    preserveTailStartID: MessageID.zod.optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
