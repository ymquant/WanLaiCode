import { Cause, Deferred, Effect, Layer, Context, Scope, Fiber } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow, usable } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { mergeToolMetadata } from "./tool-permission-review"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { SystemPrompt } from "./system"
import { isLikelyLanguage } from "@/util/language-detect"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { Modelv2 } from "@/v2/model"
import * as DateTime from "effect/DateTime"
import { Token } from "@/util/token"

const DOOM_LOOP_THRESHOLD = 3
const EMPTY_RESPONSE_CONTEXT_PRESSURE_RATIO = 0.75
const EMPTY_RESPONSE_LARGE_REQUEST_TOKENS = 500_000
// 空回复重试用独立上限：模型持续不给可显示内容时重试同一个请求几乎不会自愈，
// 不能沿用通用错误的「12 小时无次数上限」策略在后台空转。
export const EMPTY_RESPONSE_MAX_RETRIES = 3
const log = Log.create({ service: "session.processor" })
const DELTA_FLUSH_MS = 24
const DELTA_FLUSH_INTERVAL = "24 millis"
const DELTA_FLUSH_CHARS = 384
// 文件编辑类工具在生成入参(内容/补丁)阶段，把累积的原始参数串节流写回 pending part 的 raw，
// 供前端实时估算「已写入行数」做里程表逐行跳动。仅这三个工具，且节流发布避免拖累流式热路径。
const TOOL_INPUT_STREAM_TOOLS = new Set(["edit", "write", "apply_patch"])
const TOOL_INPUT_STREAM_FLUSH_MS = 80

// 官方 Responses 把 phase 放在具体 provider 的 metadata 中；这里不绑定 provider 名，兼容 OpenAI、Copilot 与后续实现。
export function textPartPhaseFromProviderMetadata(metadata: unknown): MessageV2.TextPart["phase"] {
  if (!isRecord(metadata)) return undefined
  const candidates = [metadata, ...Object.values(metadata)]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    if (candidate.phase === "commentary" || candidate.phase === "final_answer") return candidate.phase
  }
  return undefined
}

// 兼容接口没有 phase 时按步骤终止原因补齐：工具步骤仍是活动流，其余真正结束的步骤才是最终回复。
export function textPartPhaseForFinish(finish: string): NonNullable<MessageV2.TextPart["phase"]> {
  if (finish === "tool-calls" || finish === "unknown") return "commentary"
  return "final_answer"
}

function emptyStreamError(retry: boolean) {
  return new MessageV2.APIError({
    message: retry ? "模型本次没有返回可显示内容，正在重试" : "模型连续多次没有返回可显示内容。请重试或切换模型。",
    // isRetryable 为假时 SessionRetry.retryable 会直接判停，重试就此收敛为错误卡片。
    isRetryable: retry,
    metadata: { code: "EMPTY_RESPONSE" },
  })
}

export function emptyResponseLikelyContextOverflow(input: { streamInput: LLM.StreamInput; cfg: Config.Info }) {
  // 上游在上下文接近上限时可能只返回空 stop，不带明确的 context_length_exceeded。
  // 这里按真实请求体做保守预估，避免把必失败的超长上下文当成普通空响应反复重试。
  const size = Token.estimateRequest(
    JSON.stringify({
      system: input.streamInput.system,
      messages: input.streamInput.messages,
      tools: input.streamInput.tools,
      toolChoice: input.streamInput.toolChoice,
      maxOutputTokens: input.streamInput.maxOutputTokens,
    }),
  )
  // Codex 会对超长单条输入做长度保护；WanlaiCode 网关目前可能只回空流。
  // 绝对体积已经很大时直接进入上下文溢出处理，不再依赖模型上报的 context_length。
  if (size >= EMPTY_RESPONSE_LARGE_REQUEST_TOKENS) return true
  if (input.streamInput.model.limit.context === 0) return false
  const capacity = usable({ cfg: input.cfg, model: input.streamInput.model })
  if (capacity <= 0) return false
  return size >= Math.floor(capacity * EMPTY_RESPONSE_CONTEXT_PRESSURE_RATIO)
}

function emptyStreamErrorFor(input: { streamInput: LLM.StreamInput; cfg: Config.Info; retry: boolean }) {
  if (!emptyResponseLikelyContextOverflow(input)) return emptyStreamError(input.retry)
  return new MessageV2.ContextOverflowError({
    message: "当前对话上下文过长，模型没有返回内容。请等待自动压缩完成，或开启新会话后再试。",
  })
}

export function providerImageGenerationOutput(input: unknown) {
  if (!input || typeof input !== "object") return
  if (!("result" in input) || typeof input.result !== "string") return
  const raw = input.result.trim()
  if (!raw) return
  return {
    title: "Generated 1 image",
    output: "Generated 1 image.",
    metadata: { imageCount: 1, providerExecuted: true },
    attachments: [
      {
        type: "file" as const,
        mime: raw.startsWith("data:image/") ? (raw.match(/^data:([^;,]+)/)?.[1] ?? "image/png") : "image/png",
        filename: "generated-image.png",
        url: raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`,
      },
    ],
  }
}

function sanitizeToolAttachments(attachments: MessageV2.FilePart[] | undefined) {
  return attachments?.filter((item) => !item.filename?.startsWith("wanlai-image-loading-"))
}

export function imageGenerationCountLimitText(metadata: Record<string, any> | undefined, fallbackCount?: number) {
  const requested =
    typeof metadata?.requestedImageCount === "number" && Number.isFinite(metadata.requestedImageCount)
      ? Math.max(1, Math.floor(metadata.requestedImageCount))
      : undefined
  const count =
    typeof metadata?.imageCount === "number" && Number.isFinite(metadata.imageCount)
      ? Math.max(1, Math.floor(metadata.imageCount))
      : fallbackCount && Number.isFinite(fallbackCount)
        ? Math.max(1, Math.floor(fallbackCount))
        : undefined
  if (!requested || !count || requested <= count) return undefined
  const max =
    typeof metadata?.maxImageCount === "number" && Number.isFinite(metadata.maxImageCount)
      ? Math.max(1, Math.floor(metadata.maxImageCount))
      : count
  const suffix = count > 1 ? `${count}张独立图片` : "图片"
  return `当前最多一次生成${max}张图片，所以已先生成${suffix}。`
}

function imageGenerationFinalText(
  input: Record<string, any> | undefined,
  output: { metadata?: Record<string, any>; attachments?: MessageV2.FilePart[] },
) {
  const attachmentCount = output.attachments?.filter((item) => item.mime.startsWith("image/")).length
  const inputCount = typeof input?.count === "number" ? input.count : undefined
  const count =
    typeof output.metadata?.imageCount === "number" ? output.metadata.imageCount : inputCount || attachmentCount
  const suffix = count && count > 1 ? `${count}张独立图片` : "图片"
  if (input?.action === "edit") return "已按你的要求完成图片编辑。"
  const limitText = imageGenerationCountLimitText(output.metadata, count)
  if (limitText) return limitText
  return `已按你的要求生成${suffix}。`
}

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  // steer 只能中止纯模型采样；工具 part 已进入 pending/running 后必须等待真实执行自然收尾。
  readonly steerInterruptible?: boolean
  readonly startToolCall: (
    toolCallID: string,
    toolName: string,
    input: Record<string, any>,
    metadata?: Record<string, any>,
  ) => Effect.Effect<MessageV2.ToolPart>
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
    options?: { appendImageGenerationText?: boolean },
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly failToolCall: (toolCallID: string, error: unknown) => Effect.Effect<boolean>
  readonly fail: (error: unknown) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
  user: MessageV2.User
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  // 文件编辑类工具入参流式阶段的累积原始串与节流时间戳（供 raw 增量回写）
  tool?: string
  raw?: string
  rawFlushedAt?: number
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  responseCompleted: boolean
  imageGenerationStarted: boolean
  imageGenerationCompleted: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  stepStartMs: number | undefined
  hasStreamedContent: boolean
  // 「这一轮有没有可见输出」：commentary/final_answer、工具、图片算，只有纯思考不算。
  // 注意与前端 partState 的差别——那边把思考也当成可渲染内容（showReasoningSummaries 默认开），
  // 但思考不是回答：模型只吐思考就 stop 时用户拿不到任何结论，必须重试而不是收工。
  hasVisibleOutput: boolean
  emptyResponseAttempts: number
  // 当前模型 step 产生的正文，用于在工具事件或 finish-step 到达后为无 phase 的兼容接口补阶段。
  stepTextParts: MessageV2.TextPart[]
  // 本次 attempt 写入的思考与正文 part。reasoning-end 会把思考从 reasoningMap 摘掉、
  // text-end 会把正文从 currentText 摘掉；空回复重试靠这份清单只删除纯空白占位，
  // 已经展示过的 reasoning item 必须原位保留，避免刷新前后内容不一致。
  attemptParts: (MessageV2.ReasoningPart | MessageV2.TextPart)[]
}

type StreamEvent = Event
type BufferedDelta = Parameters<Session.Interface["updatePartDelta"]>[0]

function deltaKey(input: BufferedDelta) {
  return `${input.sessionID}:${input.messageID}:${input.partID}:${input.field}`
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        user: input.user,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        responseCompleted: false,
        imageGenerationStarted: false,
        imageGenerationCompleted: false,
        currentText: undefined,
        reasoningMap: {},
        stepStartMs: undefined,
        hasStreamedContent: false,
        hasVisibleOutput: false,
        emptyResponseAttempts: 0,
        stepTextParts: [],
        attemptParts: [],
      }
      let aborted = false
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)
      const pendingDeltas = new Map<string, BufferedDelta>()
      let pendingDeltaChars = 0
      let lastDeltaFlush = 0
      let cancelScheduledDeltaFlush: Effect.Effect<void> | undefined

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const flushDeltas = Effect.fnUntraced(function* () {
        const cancel = cancelScheduledDeltaFlush
        cancelScheduledDeltaFlush = undefined
        if (cancel) yield* cancel
        if (pendingDeltas.size === 0) return

        const items = Array.from(pendingDeltas.values())
        pendingDeltas.clear()
        pendingDeltaChars = 0
        lastDeltaFlush = Date.now()

        yield* Effect.forEach(items, (item) => session.updatePartDelta(item), { discard: true })
      })

      const scheduleDeltaFlush = Effect.fnUntraced(function* () {
        if (cancelScheduledDeltaFlush) return
        const fiber = yield* Effect.gen(function* () {
          yield* Effect.sleep(DELTA_FLUSH_INTERVAL)
          cancelScheduledDeltaFlush = undefined
          yield* flushDeltas()
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void
            slog.error("delta flush failed", { error: Cause.squash(cause) })
            return Effect.void
          }),
          Effect.forkIn(scope),
        )
        cancelScheduledDeltaFlush = Fiber.interrupt(fiber).pipe(Effect.ignore)
      })

      const enqueueDelta = Effect.fnUntraced(function* (input: BufferedDelta) {
        if (!input.delta) return

        const now = Date.now()
        if (pendingDeltas.size === 0 && now - lastDeltaFlush >= DELTA_FLUSH_MS) {
          lastDeltaFlush = now
          yield* session.updatePartDelta(input)
          return
        }

        const key = deltaKey(input)
        const pending = pendingDeltas.get(key)
        if (pending) pending.delta += input.delta
        else pendingDeltas.set(key, { ...input })
        pendingDeltaChars += input.delta.length

        if (pendingDeltaChars >= DELTA_FLUSH_CHARS) {
          yield* flushDeltas()
          return
        }

        yield* scheduleDeltaFlush()
      })

      const setUnphasedStepTextParts = Effect.fnUntraced(function* (phase: NonNullable<MessageV2.TextPart["phase"]>) {
        const parts = ctx.stepTextParts.filter((part) => !part.phase)
        if (!parts.length) return
        // 先提交正文增量再写完整 part，避免待发送 delta 在阶段快照之后重复追加同一段文本。
        yield* flushDeltas()
        yield* Effect.forEach(
          parts,
          (part) => {
            // 这里只填补缺失值；provider 在 text-start/text-end 给出的官方 phase 始终拥有最高优先级。
            part.phase = phase
            return session.updatePart(part)
          },
          { discard: true },
        )
        // commentary 也是官方可见 item，不能被空回复重试删除；phase 只决定展示位置，不决定内容是否存在。
        if (parts.some((part) => !!part.text.trim())) ctx.hasVisibleOutput = true
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const startToolCall = Effect.fn("SessionProcessor.startToolCall")(function* (
        toolCallID: string,
        toolName: string,
        input: Record<string, any>,
        metadata?: Record<string, any>,
      ) {
        // 直接工具入口没有 LLM tool-input-start 事件，也要把工具前说明立即固定为 commentary。
        yield* setUnphasedStepTextParts("commentary")
        // 直接执行内置工具时没有 LLM 的 tool-input-start/tool-call 事件，
        // 这里补齐同样的工具 part，让前端立即显示进度而不是停在"正在思考"。
        ctx.hasStreamedContent = true
        ctx.hasVisibleOutput = true
        EventV2.run(SessionEvent.Tool.Input.Started.Sync, {
          sessionID: ctx.sessionID,
          callID: toolCallID,
          name: toolName,
          timestamp: DateTime.makeUnsafe(Date.now()),
        })
        EventV2.run(SessionEvent.Tool.Called.Sync, {
          sessionID: ctx.sessionID,
          callID: toolCallID,
          tool: toolName,
          input,
          provider: { executed: false },
          timestamp: DateTime.makeUnsafe(Date.now()),
        })
        const part = yield* session.updatePart({
          id: ctx.toolcalls[toolCallID]?.partID ?? PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: toolName,
          callID: toolCallID,
          state: {
            status: "running",
            input,
            metadata,
            time: { start: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
        ctx.toolcalls[toolCallID] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
        options?: { appendImageGenerationText?: boolean },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        const attachments = sanitizeToolAttachments(output.attachments)
        let part = yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: mergeToolMetadata(match.part.state.metadata, output.metadata),
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments,
          },
        })
        if (part.tool === "image_generation" && attachments?.some((item) => item.mime.startsWith("image/"))) {
          // 图片和确定性正文已经构成最终交付；持久化标记供断线恢复跳过普通工具回灌，避免重复回复。
          part = yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              metadata: { ...part.state.metadata, responseComplete: true },
            },
          })
          // 官方 Codex 把 imageGeneration 事件直接落成 generated-image item。
          // 图片已经可见时，本轮到此结束，避免普通模型自检后再次调用生图。
          if (
            options?.appendImageGenerationText &&
            !MessageV2.parts(ctx.assistantMessage.id).some(
              (item) => item.type === "text" && !item.synthetic && !item.ignored,
            )
          ) {
            // 普通模型工具生图会在图片完成后直接 stop；这里补最终正文，避免前端只剩图片没有回复文字。
            const end = Date.now()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: imageGenerationFinalText(part.state.input, {
                metadata: part.state.metadata,
                attachments: part.state.attachments,
              }),
              phase: "final_answer",
              time: { start: end, end },
            } satisfies MessageV2.TextPart)
          }
          ctx.imageGenerationCompleted = true
          ctx.responseCompleted = true
          ctx.assistantMessage.finish = "stop"
        }
        yield* settleToolCall(toolCallID)
        return part
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        const attachments = sanitizeToolAttachments(match.part.state.attachments)
        const message =
          error instanceof Permission.ReviewDeniedError
            ? `${error.message} Do not retry, rephrase, or use another tool to circumvent this decision.`
            : errorMessage(error)
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: message,
            title: match.part.state.title,
            metadata: match.part.state.metadata,
            attachments,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        if (error instanceof Permission.ReviewDeniedError && error.halt) {
          ctx.blocked = true
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      // 翻译开关开时：把英文推理整段翻译为目标语言，并将译文逐块流式写入 part（隐藏英文、中文逐句显现）。
      // 返回是否产出了译文（失败/空则由调用方回退显示原文）。
      const streamReasoningTranslation = Effect.fn("SessionProcessor.streamReasoningTranslation")(function* (
        part: MessageV2.ReasoningPart,
        text: string,
        tag: string,
      ) {
        const carrier = yield* agents.get("title")
        if (!carrier) return false
        const name = SystemPrompt.languageName(tag)
        yield* llm
          .stream({
            agent: {
              ...carrier,
              prompt: "You are a precise translation engine. Output only the translation, nothing else.",
            },
            // 清掉 language，避免 llm.ts 再追加一条"用某语言思考/回复"指令与翻译指令重复、浪费 prompt token
            user: { ...ctx.user, language: undefined },
            system: [],
            small: true,
            tools: {},
            model: ctx.model,
            sessionID: ctx.sessionID,
            retries: 1,
            messages: [
              {
                role: "user",
                content: `Translate the text between <r></r> into ${name}. Preserve markdown formatting. Output ONLY the translation with no preamble.\n<r>\n${text}\n</r>`,
              },
            ],
          })
          .pipe(
            Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
            Stream.runForEach((e) =>
              Effect.gen(function* () {
                part.text += e.text
                yield* enqueueDelta({
                  sessionID: part.sessionID,
                  messageID: part.messageID,
                  partID: part.id,
                  field: "text",
                  delta: e.text,
                })
              }),
            ),
          )
        return part.text.trim().length > 0
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        if (ctx.imageGenerationCompleted) return
        if (
          ctx.imageGenerationStarted &&
          ["text-start", "text-delta", "text-end", "reasoning-start", "reasoning-delta", "reasoning-end"].includes(
            value.type,
          )
        ) {
          return
        }
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" })
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Reasoning.Started.Sync, {
              sessionID: ctx.sessionID,
              reasoningID: value.id,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            ctx.attemptParts.push(ctx.reasoningMap[value.id])
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta": {
            if (!(value.id in ctx.reasoningMap)) return
            const rp = ctx.reasoningMap[value.id]
            if (value.providerMetadata) rp.metadata = value.providerMetadata
            // 翻译模式：英文原文实时流入 originalText（先出英文，长推理不空窗）；结束后再流式翻译进 text。
            // 否则按原样把英文流入 text。
            const field = ctx.user.translateContent && ctx.user.language ? "originalText" : "text"
            const current = field === "originalText" ? (rp.originalText ?? "") : rp.text
            // provider 未提供重放标记时，每个 delta 都是权威内容；不能仅凭文本重复外形裁掉合法推理。
            const delta = value.text
            if (!delta) return
            ctx.hasStreamedContent = true
            if (field === "originalText") rp.originalText = current + delta
            else rp.text = current + delta
            yield* enqueueDelta({
              sessionID: rp.sessionID,
              messageID: rp.messageID,
              partID: rp.id,
              field,
              delta,
            })
            return
          }

          case "reasoning-end": {
            if (!(value.id in ctx.reasoningMap)) return
            const part = ctx.reasoningMap[value.id]
            yield* flushDeltas()
            const translateMode = !!(ctx.user.translateContent && ctx.user.language)
            // 翻译模式下英文实时流入 originalText；否则在 text
            // 完整正文严格保留 provider 原始输出；没有协议级 replay 身份时不做基于内容形状的推断。
            const english = (translateMode ? part.originalText : part.text) ?? ""
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Reasoning.Ended.Sync, {
              sessionID: ctx.sessionID,
              reasoningID: value.id,
              text: english,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            if (value.providerMetadata) part.metadata = value.providerMetadata
            delete ctx.reasoningMap[value.id]

            const tag = ctx.user.language
            if (translateMode && tag && english.trim() && !isLikelyLanguage(english, tag)) {
              // 原文已实时流入 originalText；此处流式翻译进 text（非对照：中文覆盖英文；对照：原文在上、译文在下）。
              // 翻译是纯展示层：text 存译文仅供 UI，originalText 保留模型产出的带签名英文原文；
              // 回放模型时用 originalText+签名（见 message-v2.toModelMessages），故此处不再清空 metadata，
              // 否则带 tool_use 的轮次会丢失签名思考块，interleaved 模式下被 Anthropic 持续拒绝(400)。
              part.text = ""
              yield* session.updatePart(part)
              const ok = yield* streamReasoningTranslation(part, english, tag).pipe(
                Effect.catchCause((cause) => {
                  slog.error("reasoning translate failed", { error: Cause.squash(cause) })
                  return Effect.succeed(false)
                }),
              )
              yield* flushDeltas()
              if (!ok || !part.text.trim()) {
                // 回退：text 即原文，去掉对照；保留原 metadata（与原文匹配，签名/加密推理仍有效）
                part.text = english
                part.originalText = undefined
              } else {
                // 翻译成功：originalText 即带签名的英文原文，保留它与 metadata(签名) 供回放
                part.originalText = english
              }
            } else if (translateMode) {
              // 翻译模式但跳过翻译（原文已是目标语言）：把流入 originalText 的内容移回 text，不展示对照
              part.text = english
              part.originalText = undefined
            }
            part.time = { ...part.time, end: Date.now() }
            yield* session.updatePart(part)
            return
          }

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            // 工具已经开始时，之前没有显式 phase 的文字只能是工具前进度说明，立即留在活动流原位。
            yield* setUnphasedStepTextParts("commentary")
            if (value.toolName === "image_generation") ctx.imageGenerationStarted = true
            // 工具调用也是模型的有效输出；否则纯工具轮次会被空响应兜底误判成需要重试。
            ctx.hasStreamedContent = true
            ctx.hasVisibleOutput = true
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Input.Started.Sync, {
              sessionID: ctx.sessionID,
              callID: value.id,
              name: value.toolName,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
              tool: value.toolName,
              raw: "",
            }
            return

          case "tool-input-delta": {
            // 仅文件编辑类工具在入参流式阶段累积 raw 并节流回写 pending part，供前端逐行跳动。
            const call = ctx.toolcalls[value.id]
            if (call && call.tool && TOOL_INPUT_STREAM_TOOLS.has(call.tool)) {
              call.raw = (call.raw ?? "") + value.delta
              const now = Date.now()
              if (now - (call.rawFlushedAt ?? 0) >= TOOL_INPUT_STREAM_FLUSH_MS) {
                call.rawFlushedAt = now
                yield* session.updatePart({
                  id: call.partID,
                  messageID: call.messageID,
                  sessionID: call.sessionID,
                  type: "tool",
                  tool: call.tool,
                  callID: value.id,
                  state: { status: "pending", input: {}, raw: call.raw },
                } satisfies MessageV2.ToolPart)
              }
            }
            return
          }

          case "tool-input-end": {
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Input.Ended.Sync, {
              sessionID: ctx.sessionID,
              callID: value.id,
              text: "",
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            // provider-executed 工具可能跳过 tool-input-start；仍需在工具事件到达时固定前置 commentary。
            yield* setUnphasedStepTextParts("commentary")
            if (value.toolName === "image_generation") ctx.imageGenerationStarted = true
            ctx.hasStreamedContent = true
            ctx.hasVisibleOutput = true
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Called.Sync, {
              sessionID: ctx.sessionID,
              callID: value.toolCallId,
              tool: value.toolName,
              input: value.input,
              provider: {
                executed: toolCall?.part.metadata?.providerExecuted === true,
                ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.toolName],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.toolName, input: value.input },
              always: [value.toolName],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            ctx.hasStreamedContent = true
            ctx.hasVisibleOutput = true
            const toolCall = yield* readToolCall(value.toolCallId)
            const output =
              toolCall?.part.metadata?.providerExecuted === true && value.toolName === "image_generation"
                ? (providerImageGenerationOutput(value.output) ?? value.output)
                : value.output
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Success.Sync, {
              sessionID: ctx.sessionID,
              callID: value.toolCallId,
              structured: output.metadata,
              content: [
                {
                  type: "text",
                  text: output.output,
                },
                ...(output.attachments?.map((item: MessageV2.FilePart) => ({
                  type: "file",
                  uri: item.url,
                  mime: item.mime,
                  name: item.filename,
                })) ?? []),
              ],
              provider: {
                executed: toolCall?.part.metadata?.providerExecuted === true,
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            yield* completeToolCall(value.toolCallId, output, { appendImageGenerationText: true })
            return
          }

          case "tool-error": {
            ctx.hasStreamedContent = true
            ctx.hasVisibleOutput = true
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Failed.Sync, {
              sessionID: ctx.sessionID,
              callID: value.toolCallId,
              structured: toolCall?.part.state.status === "running" ? (toolCall.part.state.metadata ?? {}) : {},
              content:
                toolCall?.part.state.status === "running"
                  ? [
                      ...(toolCall.part.state.title
                        ? [{ type: "text" as const, text: toolCall.part.state.title }]
                        : []),
                      ...(sanitizeToolAttachments(toolCall.part.state.attachments)?.map((item) => ({
                        type: "file" as const,
                        uri: item.url,
                        mime: item.mime,
                        name: item.filename,
                      })) ?? []),
                    ]
                  : [],
              error: {
                type: "unknown",
                message: errorMessage(value.error),
              },
              provider: {
                executed: toolCall?.part.metadata?.providerExecuted === true,
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "error":
            throw value.error

          case "start-step":
            // 每个 step 单独推断 phase，防止后一步的终止原因改写前一步已经确定的正文归属。
            ctx.stepTextParts = []
            ctx.stepStartMs = Date.now()
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Step.Started.Sync, {
                sessionID: ctx.sessionID,
                agent: input.assistantMessage.agent,
                model: {
                  id: Modelv2.ID.make(ctx.model.id),
                  providerID: Modelv2.ProviderID.make(ctx.model.providerID),
                  variant: Modelv2.VariantID.make(input.assistantMessage.variant ?? "default"),
                },
                snapshot: ctx.snapshot,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            const completedSnapshot = yield* snapshot.track()
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Step.Ended.Sync, {
                sessionID: ctx.sessionID,
                finish: value.finishReason,
                cost: usage.cost,
                tokens: usage.tokens,
                snapshot: completedSnapshot,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            // OpenAI Responses 的显式 phase 已在 text 事件落库；这里只为兼容接口补齐旧版 part 的缺失阶段。
            yield* setUnphasedStepTextParts(textPartPhaseForFinish(value.finishReason))
            const stepElapsedMs = ctx.stepStartMs !== undefined ? Date.now() - ctx.stepStartMs : 0
            ctx.stepStartMs = undefined
            // compaction/summary 轮是系统开销，不计入目标进度（与上面 Step.Ended 同样的 !summary 守卫）
            if (!ctx.assistantMessage.summary) {
              yield* session.addGoalUsage({
                sessionID: ctx.sessionID,
                // getUsage 已把 cache 读写从 input 扣除，这里不能再减 cache.read（否则长会话恒为负、被钳成 0）；
                // output 已剔除 reasoning，需单独加回，否则推理模型的目标用量系统性偏低
                tokens: usage.tokens.input + usage.tokens.output + usage.tokens.reasoning,
                seconds: Math.trunc(stepElapsedMs / 1000),
              })
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            ctx.responseCompleted = true
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start": {
            const start = Date.now()
            const phase = textPartPhaseFromProviderMetadata(value.providerMetadata)
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Text.Started.Sync, {
                sessionID: ctx.sessionID,
                phase,
                timestamp: DateTime.makeUnsafe(start),
              })
            }
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              phase,
              time: { start },
              metadata: value.providerMetadata,
            }
            ctx.stepTextParts.push(ctx.currentText)
            ctx.attemptParts.push(ctx.currentText)
            yield* session.updatePart(ctx.currentText)
            return
          }

          case "text-delta":
            if (!ctx.currentText) return
            // 这里只记「写过 part」。是否算回答要等 text-end：experimental.text.complete
            // 还会重写最终落库的正文，而且纯空白正文在前端 trim 之后同样不可见。
            if (value.text) ctx.hasStreamedContent = true
            ctx.currentText.text += value.text
            if (value.providerMetadata) {
              ctx.currentText.metadata = value.providerMetadata
              // 少数 provider 会到 delta 才补 phase；显式值可以纠正此前由工具事件做出的兼容推断。
              ctx.currentText.phase = textPartPhaseFromProviderMetadata(value.providerMetadata) ?? ctx.currentText.phase
            }
            yield* enqueueDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            yield* flushDeltas()
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            if (value.providerMetadata) {
              ctx.currentText.metadata = value.providerMetadata
              // Responses 通常在 text-end 再给最终 metadata；以这里的官方 phase 覆盖任何兼容回退。
              ctx.currentText.phase = textPartPhaseFromProviderMetadata(value.providerMetadata) ?? ctx.currentText.phase
            }
            const end = Date.now()
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Text.Ended.Sync, {
                sessionID: ctx.sessionID,
                text: ctx.currentText.text,
                phase: ctx.currentText.phase,
                timestamp: DateTime.makeUnsafe(end),
              })
            }
            // 以最终落库正文判断是否有可见输出；commentary 与 final_answer 都是官方可见 item，
            // 只能按 phase 改变展示位置，不能把 commentary 当空回复删除。hook 与纯空白仍按最终值判断。
            if (ctx.currentText.text.trim()) {
              ctx.hasVisibleOutput = true
              // phase 未定或 commentary 也已经是持久内容；随后的中途断流若重试会把新 attempt 叠在它后面。
              // hook 可能在原始 delta 全空时补出正文，那时 text-delta 没机会置过这个防重复标志。
              ctx.hasStreamedContent = true
            }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            ctx.responseCompleted = true
            return

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        yield* flushDeltas()

        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        const parts = MessageV2.parts(ctx.assistantMessage.id)
        const completedImageGeneration = parts.find(
          (part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted } =>
            part.type === "tool" &&
            part.tool === "image_generation" &&
            part.state.status === "completed" &&
            part.state.attachments?.some((item) => item.mime.startsWith("image/")) === true,
        )
        if (
          completedImageGeneration &&
          !parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored)
        ) {
          // provider-executed 生图可能不经过本地 tool-result 分支；收尾时统一补最终正文。
          const end = Date.now()
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: ctx.assistantMessage.id,
            sessionID: ctx.assistantMessage.sessionID,
            type: "text",
            text: imageGenerationFinalText(completedImageGeneration.state.input, {
              metadata: completedImageGeneration.state.metadata,
              attachments: completedImageGeneration.state.attachments,
            }),
            phase: "final_answer",
            time: { start: end, end },
          } satisfies MessageV2.TextPart)
        }

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          const attachments =
            part.state.status === "running" || part.state.status === "completed"
              ? sanitizeToolAttachments(part.state.attachments)
              : undefined
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              attachments,
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Step.Failed.Sync, {
            sessionID: ctx.sessionID,
            error: {
              type: "unknown",
              message: errorMessage(e),
            },
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        // 模型步骤失败只结束当前 assistant；整个 runner 是否空闲由 SessionRunState.onIdle 统一发布。
        // 若同一 turn 已收到 steer，循环会继续消费它，期间绝不能出现 idle -> busy 的伪回合边界。
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        // 以下四个都是「一个模型步骤」级别的，只在这里重置，不随重试 attempt 重置：
        //   imageGenerationCompleted：出图即本条消息终结（takeUntil 收流 + finish=stop）；
        //   hasStreamedContent：对应当前传输 attempt 是否已经收到内容，用于阻止中途断流后重试造成重复；
        //   空回复重试会保留 reasoning，但为下一次尚未产生 token 的新传输清零该标志。
        //   hasVisibleOutput：这一步到目前为止有没有给出 commentary、最终正文或工具等有效输出。
        //   某次 attempt 已经产出这些内容后，后面 attempt 的空 stop 不能再被判成空回复。
        //   emptyResponseAttempts：空回复重试次数按模型步骤计，不跨步累加，
        //   否则长任务里各步偶发的空回复会互相挤占同一份重试额度。
        ctx.imageGenerationCompleted = false
        ctx.hasStreamedContent = false
        ctx.hasVisibleOutput = false
        ctx.emptyResponseAttempts = 0
        const cfg = yield* config.get()
        ctx.shouldBreak = cfg.experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            // 以下两个只描述「本次 attempt 的这条流」，必须逐次重置，否则上一轮的残留会污染下一轮：
            //   responseCompleted：空流的 stop 会把它留成真，让下一轮的 5xx 被重试门控当成终态直接标红；
            //   imageGenerationStarted：残留会让 handleEvent 整段丢弃新一轮的 text-*/reasoning-*，
            //   用户只看到空回复。
            ctx.responseCompleted = false
            ctx.imageGenerationStarted = false
            yield* flushDeltas()
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.stepTextParts = []
            ctx.attemptParts = []
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction || ctx.imageGenerationCompleted),
              Stream.runDrain,
            )
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !!streamInput.stepAbortSignal?.aborted && !Cause.hasInterrupts(cause),
              () => {
                // steer 是同一 turn 内的正常采样分界，不写错误、不重试；cleanup 只冻结已有正文和推理。
                return Effect.void
              },
            ),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                // 区分用户主动停止与被动中断（实例 scope 关闭 / 重启）：
                // 只有用户点击停止（SessionRunState.cancel 打了标记）才落成 MessageAbortedError；
                // 被动中断静默恢复，不写错误、不显示「已中断」。
                const userAbort = yield* status.takeUserAbort(ctx.sessionID)
                if (!userAbort) return
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            // 没有回答的 stop 都是空回复（完全空流，以及只吐思考的推理模型），不应落成成功回答；
            // 转成可重试错误，到 EMPTY_RESPONSE_MAX_RETRIES 后才显示错误卡片。
            Effect.flatMap(() =>
              Effect.gen(function* () {
                // hasVisibleOutput 通常在 text-end / finish-step 结算；极端事件顺序下正文仍可能留在
                // currentText。commentary 同样是官方可见 item，不能被空回复恢复逻辑撤回。
                const answered = ctx.hasVisibleOutput || !!ctx.currentText?.text.trim()
                if (!ctx.responseCompleted || answered || ctx.assistantMessage.error || ctx.needsCompaction) return
                // length 是输出预算被思考吃光，重发同一个请求只会再截断一次；
                // 交给主循环的 length 续跑（带着已产出内容继续生成）才可能拿到正文。
                if (ctx.assistantMessage.finish === "length") return
                ctx.emptyResponseAttempts++
                const retry = ctx.emptyResponseAttempts <= EMPTY_RESPONSE_MAX_RETRIES
                const error = emptyStreamErrorFor({ streamInput, cfg, retry })
                if (retry && MessageV2.APIError.isInstance(error)) {
                  // finish-step 已经把这次 attempt 的 stop 落库；不清掉的话前端 assistantTurnTerminal
                  // 立刻把消息当终态——重试期间既不显示「正在重试」，还会误报「没有收到可显示的回复」。
                  ctx.assistantMessage.finish = undefined
                  yield* session.updateMessage(ctx.assistantMessage)
                  // 官方 item 一旦产生就原位保留；重试只能清理纯空白占位，不能撤回用户已经看到的 reasoning。
                  // 这样 V1/V2 投影也不会因缺少 remove 事件而在刷新前后出现两套不同内容。
                  yield* flushDeltas()
                  const unfinishedReasoning = Object.entries(ctx.reasoningMap).filter(
                    ([, part]) => !!part.text.trim() || !!part.originalText?.trim(),
                  )
                  if (unfinishedReasoning.length) {
                    const end = Date.now()
                    yield* Effect.forEach(
                      unfinishedReasoning,
                      ([reasoningID, part]) => {
                        // provider 已结束 response 却漏发 reasoning-end 时，本地必须补终态，否则最终回复会一直被 running reasoning 阻挡。
                        part.time = { ...part.time, end }
                        EventV2.run(SessionEvent.Reasoning.Ended.Sync, {
                          sessionID: ctx.sessionID,
                          reasoningID,
                          text: part.originalText ?? part.text,
                          timestamp: DateTime.makeUnsafe(end),
                        })
                        return session.updatePart(part)
                      },
                      { discard: true },
                    )
                  }
                  const rollback = ctx.attemptParts.filter((part) => {
                    if (part.type === "text") return !part.text.trim()
                    return !part.text.trim() && !part.originalText?.trim()
                  })
                  ctx.attemptParts = []
                  ctx.reasoningMap = {}
                  ctx.currentText = undefined
                  yield* Effect.forEach(
                    rollback,
                    (part) =>
                      session.removePart({
                        sessionID: part.sessionID,
                        messageID: part.messageID,
                        partID: part.id,
                      }),
                    { discard: true },
                  )
                  // 下一次 retry 是新的传输 attempt，尚未收到它自己的内容；保留的 reasoning 属于前一 attempt，
                  // 不能阻止新 attempt 在首 token 前断流时继续自愈。新内容一到达会再次把该标志置真。
                  ctx.hasStreamedContent = false
                }
                return yield* Effect.fail(error)
              }),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                retry: (error) =>
                  SessionRetry.isEmptyResponse(error) ||
                  (!ctx.responseCompleted && !(ctx.hasStreamedContent && SessionRetry.isMidStreamInterruption(error))),
                set: (info) => {
                  // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                  EventV2.run(SessionEvent.Retried.Sync, {
                    sessionID: ctx.sessionID,
                    attempt: info.attempt,
                    error: {
                      message: info.message,
                      isRetryable: true,
                    },
                    timestamp: DateTime.makeUnsafe(Date.now()),
                  })
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    // retry 仍在原逻辑回合内；显式携带 assistant 的固定 turnID，避免不同运行时状态层无法继承目标时，
                    // 前端失去活动锚点并把仍在退避的任务误显示为空闲。
                    turnID: ctx.assistantMessage.turnID,
                    attempt: info.attempt,
                    message: info.message,
                    next: info.next,
                    code: info.code,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.imageGenerationCompleted) return "stop"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get steerInterruptible() {
          return Object.keys(ctx.toolcalls).length === 0
        },
        startToolCall,
        updateToolCall,
        completeToolCall,
        failToolCall,
        fail: halt,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
