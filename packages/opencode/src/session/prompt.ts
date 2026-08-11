import path from "path"
import os from "os"
import * as EffectZod from "@/util/effect-zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Log from "@opencode-ai/core/util/log"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "@/tool/registry"
import { RUN_BLOCKED_TOOLS, runContract } from "@/automation/message"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { SessionSuggestion } from "./suggestion"
import { NamedError } from "@opencode-ai/core/util/error"
import { imageGenerationCountLimitText, SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { PermissionMode } from "@/permission/mode"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { createShellOutputDecoder, withWindowsUtf8ShellEnv } from "@/shell/output"
import { ShellID } from "@/tool/shell/id"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Scope,
  Context,
  Schema,
  Schedule,
  Semaphore,
  Struct,
  Types,
} from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { Modelv2 } from "@/v2/model"
import { AgentAttachment, FileAttachment, Source } from "@/v2/session-prompt"
import { MemoryContext, MemoryStore } from "@/memory"
import * as DateTime from "effect/DateTime"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { SessionTable } from "./session.sql"
import { Addon } from "@/addon"
import { buildCapabilityText, parsePluginMentions } from "./plugin-capabilities"
import {
  imageGenerationGroupDisabledText,
  maxImageGenerationCount,
  readableImageGenerationErrorWithMessages,
} from "@/provider/wanlaicode-image-generation"
import { ErrorMessageMapSchema } from "@opencode-ai/core/error/message-map"
import { ApprovalReviewer } from "./approval-reviewer"
import { applyToolPermissionReview, mergeToolMetadata } from "./tool-permission-review"
import { createReplyGenerationTracker } from "./reply-generation"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })
const wanlaiCodeProviderID = ProviderID.make("wanlaicode")
const imageModelPattern = /(?:^|[-_/])(?:gpt-image|dall-e)(?:[-_/]|$)/i
const subtaskSummaryInstruction = "Summarize the task tool output above and continue with your task."
// 领域错误携带预期与实际回合，HTTP 层据此稳定返回 409，让客户端恢复草稿而不是静默改绑。
export class SteerTurnInactiveError extends Schema.TaggedErrorClass<SteerTurnInactiveError>()(
  "SteerTurnInactiveError",
  {
    message: Schema.String,
    sessionID: SessionID,
    expectedTurnID: MessageID,
    actualTurnID: Schema.optional(MessageID),
  },
) {}

// 官方 turn/steer 会先校验活动回合，再拒绝没有任何输入项的请求；该错误由 HTTP 边界稳定映射为 400。
export class SteerEmptyInputError extends Schema.TaggedErrorClass<SteerEmptyInputError>()("SteerEmptyInputError", {}) {
  override get message() {
    // 与官方 turn/steer 协议保持完全一致，客户端可据此识别统一的空输入错误。
    return "input must not be empty"
  }
}

function steerTurnInactiveError(sessionID: SessionID, expectedTurnID: MessageID, actualTurnID?: MessageID) {
  // 领域层保留预期与实际回合；两个 HTTP 边界再把同一 typed error 映射成稳定的 409 响应。
  return new SteerTurnInactiveError({
    message: actualTurnID
      ? `expected active turn id \`${expectedTurnID}\` but found \`${actualTurnID}\``
      : `Expected active turn ${expectedTurnID}, but the session is idle`,
    sessionID,
    expectedTurnID,
    actualTurnID,
  })
}

export interface Interface {
  readonly cancel: (sessionID: SessionID, options?: CancelOptions) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly promptAsync: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly steer: (input: SteerInput) => Effect.Effect<SteerAck, SteerTurnInactiveError | SteerEmptyInputError>
  readonly loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

export type CancelOptions = {
  resumeQueued?: boolean
  // 桌面端停止按钮携带当前回合，防止旧页面的迟到请求误杀新回合。
  turnID?: MessageID
  // 仅在 turnID 闸门命中后、runner 结束前执行关联副作用；goal 暂停必须与停止认领保持同一线性化点。
  onAccepted?: Effect.Effect<void>
}

export type SteerInput = Schema.Schema.Type<typeof SteerInput>
export type SteerAck = Schema.Schema.Type<typeof SteerAck>

/**
 * 待回答的真实用户消息：比「已回答到的位置」(high-water mark)更新的、非 compaction/subtask/synthetic 的用户消息。
 * 新回复用 instructionThrough 精确记录实际覆盖到的位置；旧数据仅在 parent 本身是普通输入时回退使用 parent。
 * 「已终结」= 已写 completed、终态 finish(非 tool-calls/unknown) 或带 error（含被 ESC 中断的回合）。位置必须按
 * parent 用户的真实创建顺序比较，不能直接比较 ID：旧远控消息使用 msg_remote_<hash>，字典序不代表到达顺序。
 * 待回答的真实用户消息：未被终态 assistant 精确完成、且比旧式位置 high-water 更新的非 compaction/subtask/synthetic 用户消息。
 * terminal parent 与 completedUserMessageIDs 都属于精确完成；没有显式列表的旧 assistant 才用 parent 位置推进 high-water。
 * 这样连续 steer 可以跨过中间的普通 noReply 精确覆盖，而旧格式历史仍能按到达顺序避免重复回复。
 */
// 本回合里有没有「用户手输的插话」(steer)。
// **必须按 turnID 收窄到当前回合**:传进来的 messages 是整个会话历史
// (filterCompactedEffect(sessionID)),thread 模式的自动化跑在用户自己的对话里,
// 历史里必然有用户以前发的消息 —— 不收窄就恒为真,等于把无人值守契约与工具屏蔽全程关掉。
// 自动化的触发消息是回合根且带 automationID;压缩续跑/子任务等内部合成消息只有
// synthetic/ignored 的 part。两者都不算插话 —— 只有用户在本回合真敲进来的文本才算。
// 用途:自动化回合被真人插话后,「当前没有用户在场」的契约与 question 工具屏蔽必须让开,
// 否则模型在用户明明在屏幕前时不敢反问。
export function hasUserInterjection(messages: MessageV2.WithParts[], turnRoot: MessageV2.User | undefined): boolean {
  if (!turnRoot) return false
  const turnID = MessageV2.userTurnID(turnRoot)
  return messages.some(
    (message) =>
      message.info.role === "user" &&
      MessageV2.userTurnID(message.info) === turnID &&
      message.info.id !== turnRoot.id &&
      !message.info.automationID &&
      message.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && part.text?.trim()),
  )
}

function assistantTerminal(info: MessageV2.Assistant) {
  // completed 是实际收尾时间；图片/工具回合可能保留 tool-calls finish，但已经不能再当作在途回合续跑。
  if (info.error) return true
  if (typeof info.time.completed === "number") return true
  return !!info.finish && !["tool-calls", "unknown"].includes(info.finish)
}

function compareMessageOrder(left: MessageV2.User, right: MessageV2.User) {
  // 数据库以创建时间排序；同一毫秒内继续沿用 ID 作为稳定次序，兼容现有时间有序消息。
  if (left.time.created !== right.time.created) return left.time.created < right.time.created ? -1 : 1
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1
}

function isSubtaskSummaryUser(message: MessageV2.WithParts | undefined) {
  if (!message || message.info.role !== "user") return false
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      part.synthetic === true &&
      (part.metadata?.subtask_summary === true || part.text === subtaskSummaryInstruction),
  )
}

function assistantCompletesInstruction(info: MessageV2.Assistant) {
  if (!assistantTerminal(info)) return false
  // processor 会给工具步骤和被动中断写 completed；只有错误或明确的最终非工具 finish 才能完成用户指令。
  if (info.error) return true
  if (!info.finish) return false
  return !["tool-calls", "unknown"].includes(info.finish)
}

function completedInstructionUserIDs(msgs: MessageV2.WithParts[]) {
  const completed = new Set<MessageID>()
  const manualSteerIDs = new Set(msgs.filter(isManualSteerCandidate).map((message) => message.info.id))
  msgs.forEach((message) => {
    if (message.info.role !== "assistant" || !message.info.parentID) return
    // 无正文但附件已落库的图片回合也算交付完成，避免下一条普通消息触发一次多余模型调用。
    const completesInstruction = assistantCompletesInstruction(message.info) || assistantImageGenerationEnded(message)
    if (!completesInstruction) return
    if (message.info.summary === true) {
      // 摘要只结算自己的内部 compaction 用户，不推进普通用户 high-water，防止吞掉后续队列。
      completed.add(message.info.parentID)
      return
    }
    // 独立 task assistant 只完成子任务；父用户仍需一次模型回灌，不能提前推进完成集合。
    if (!isStandaloneInternalTaskAssistant(message) && !manualSteerIDs.has(message.info.parentID)) {
      completed.add(message.info.parentID)
    }
    message.info.completedUserMessageIDs?.forEach((id) => {
      if (!isStandaloneInternalTaskAssistant(message) && (completesInstruction || !manualSteerIDs.has(id))) {
        completed.add(id)
      }
    })
  })
  return completed
}

function assistantHasToolCall(message: MessageV2.WithParts) {
  // assistant 错误已经是终态；其失败 tool 只用于 UI 展示，不能再次进入模型回灌循环。
  if (message.info.role === "assistant" && message.info.error) return false
  const legacyImageResponseComplete =
    message.info.role === "assistant" &&
    message.info.finish === "stop" &&
    typeof message.info.time.completed === "number" &&
    message.parts.some(
      (part) => part.type === "text" && part.synthetic !== true && part.ignored !== true && part.text.trim().length > 0,
    )
  // 已完成工具结果仍需要一次模型回灌；provider 可能返回 stop 但同时附带 tool call。
  return message.parts.some((part) => {
    if (part.type !== "tool") return false
    if (part.metadata?.providerExecuted) return false
    // 直接生图已经追加确定性正文并完成整轮回复，恢复 loop 时不能再次交给普通模型。
    if (part.tool === "image_generation" && "metadata" in part.state && part.state.metadata?.responseComplete === true)
      return false
    // 兼容升级前没有 responseComplete 的成功图片记录；条件必须完整，防止跳过崩溃在正文落库前的半成品。
    if (
      legacyImageResponseComplete &&
      part.tool === "image_generation" &&
      part.state.status === "completed" &&
      part.state.attachments?.some((attachment) => attachment.mime.startsWith("image/"))
    )
      return false
    return true
  })
}

function isStandaloneInternalTaskAssistant(message: MessageV2.WithParts) {
  // 内部 task 的子回合通常只落一个 task 工具 part；它代表子任务结果，不代表父用户指令已经完成。
  return (
    message.info.role === "assistant" &&
    message.parts.length === 1 &&
    message.parts[0]?.type === "tool" &&
    message.parts[0].tool === TaskTool.id
  )
}

type AssistantWithParts = Omit<MessageV2.WithParts, "info"> & { info: MessageV2.Assistant }

function isAssistantWithParts(message: MessageV2.WithParts): message is AssistantWithParts {
  // 运行时按 role 分流后同步收窄静态类型，确保终态判断不会接收普通用户消息。
  return message.info.role === "assistant"
}

function internalContinuationOwnerIDs(msgs: MessageV2.WithParts[]) {
  // 已落库的独立 task 结果优先触发父回灌；父回灌完成后才继续同一用户剩余的内部任务。
  const latestAssistantByParent = new Map<MessageID, AssistantWithParts>()
  msgs.forEach((message) => {
    if (isAssistantWithParts(message) && message.info.parentID) {
      latestAssistantByParent.set(message.info.parentID, message)
    }
  })
  return new Set(
    [...latestAssistantByParent.entries()].flatMap(([parentID, message]) =>
      assistantTerminal(message.info) && isStandaloneInternalTaskAssistant(message) ? [parentID] : [],
    ),
  )
}

function assistantImageGenerationEnded(message: MessageV2.WithParts | undefined) {
  // 已完成图片且没有正文时，附件本身就是交付结果；旧记录若已有正文仍需继续回灌，避免吞掉正文后的模型步骤。
  if (!message || !isAssistantWithParts(message)) return false
  const hasVisibleText = message.parts.some(
    (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
  )
  if ((message.info.finish === "tool-calls" && hasVisibleText) || (message.info.finish !== "tool-calls" && !hasVisibleText))
    return false
  return message.parts.some((part) => {
    if (part.type !== "tool" || part.tool !== "image_generation") return false
    if (part.state.status === "error") return message.info.role === "assistant" && !!message.info.error
    return (
      part.state.status === "completed" &&
      (part.state.attachments?.some((attachment) => attachment.mime.startsWith("image/")) === true ||
        (message.info.finish === "tool-calls" && !hasVisibleText))
    )
  })
}


const imageGenerationEditPatterns = [
  /(?:改|修改|编辑|美化|优化|重画|重绘|换风格|换成|修复|去掉|删除|添加|加上).{0,20}(?:图片|图像|图画|插图|配图|这张|上图|海报|卡片|头像|壁纸|封面)/i,
  /(?:edit|modify|restyle|redraw|improve|remove|add).{0,24}(?:image|picture|poster|card|avatar|wallpaper|cover)/i,
]

const terseImageGenerationRequest =
  /^(?:请|帮我|给我|再给我|把|将|把上面|将上面|把上一条|将上一条|把这些|将这些)?\s*(?:做成|生成|转成|输出成|整理成|制作成|画成|出)?\s*(?:一张|1张)?\s*(?:图片|图|海报|卡片|信息图)\s*(?:吧|一下|出来|给我)?[。.!！?？]*$/i

const ambiguousImagegenFollowupPattern =
  /^(?:[?？!.。…]+|啥|什么|什么情况|啥情况|怎么回事|什么意思|啥意思|呢|然后呢|继续呢|再呢|why|what|huh|ok|好的|好|嗯|啊|哦)$/i

function latestUserSkillName(messages: MessageV2.WithParts[], userID: MessageID) {
  return messages
    .findLast((message) => message.info.role === "user" && message.info.id === userID)
    ?.parts.flatMap((part) => {
      if (part.type !== "text") return []
      const skill = part.metadata?.skill
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) return []
      const name = (skill as Record<string, unknown>).name
      return typeof name === "string" ? [name] : []
    })[0]
}

function latestVisibleUserText(messages: MessageV2.WithParts[], userID: MessageID) {
  return messages
    .findLast((message) => message.info.role === "user" && message.info.id === userID)
    ?.parts.flatMap((part) => {
      const text = MessageV2.visibleUserTextPart(part)
      return text ? [text] : []
    })
    .join("\n")
    .trim()
}

function latestVisibleAssistantTextBefore(messages: MessageV2.WithParts[], userID: MessageID) {
  const userIndex = messages.findIndex((message) => message.info.role === "user" && message.info.id === userID)
  const before = userIndex < 0 ? messages : messages.slice(0, userIndex)
  return before
    .findLast((message) => message.info.role === "assistant")
    ?.parts.flatMap((part) => {
      if (part.type !== "text" || part.synthetic || part.ignored) return []
      const text = part.text.trim()
      return text ? [text] : []
    })
    .join("\n")
    .trim()
}

function shouldForceImageGenerationTool(messages: MessageV2.WithParts[], userID: MessageID) {
  const text = latestVisibleUserText(messages, userID)
  if (!text) return false
  // 普通自然语言始终交给当前 Codex 模型做语义判断；只有用户显式选择 imagegen skill 才强制工具调用。
  return latestUserSkillName(messages, userID) === "imagegen" && !ambiguousImagegenFollowupPattern.test(text)
}

function isImageGenerationModel(model: Provider.Model) {
  return (
    imageModelPattern.test(model.id) ||
    imageModelPattern.test(model.name) ||
    (model.capabilities.output.image && !model.capabilities.output.text && !model.capabilities.toolcall)
  )
}

function imageGenerationAction(messages: MessageV2.WithParts[], userID: MessageID) {
  const text = latestVisibleUserText(messages, userID)
  if (!text) return "generate" as const
  return imageGenerationEditPatterns.some((pattern) => pattern.test(text)) ? ("edit" as const) : ("generate" as const)
}

function imageGenerationRequestedCount(messages: MessageV2.WithParts[], userID: MessageID) {
  const text = latestVisibleUserText(messages, userID)
  if (!text) return undefined
  const digit = text.match(
    /(\d{1,2})\s*(?:张|幅|个)\s*(?:图片|图像|图|海报|卡片|插图|插画|头像|壁纸|封面|信息图)?/i,
  )?.[1]
  const zh = text.match(/([一二两三四五六七八九十])\s*(?:张|幅|个)/)?.[1]
  const value = digit
    ? Number(digit)
    : zh
      ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as const)[
          zh as "一" | "二" | "两" | "三" | "四" | "五" | "六" | "七" | "八" | "九" | "十"
        ]
      : undefined
  if (!value) return undefined
  return Math.max(1, value)
}

function imageGenerationConfigRequestedCount(config: PromptInput["imageGeneration"] | undefined) {
  if (!config?.count || !Number.isFinite(config.count)) return undefined
  return Math.max(1, Math.floor(config.count))
}

function imageGenerationEffectiveCount(count: number | undefined) {
  if (!count || !Number.isFinite(count)) return undefined
  return Math.min(maxImageGenerationCount, Math.max(1, Math.floor(count)))
}

function imageGenerationRequestedCountLimitMetadata(
  messages: MessageV2.WithParts[],
  userID: MessageID,
  config?: PromptInput["imageGeneration"],
) {
  const requested = imageGenerationConfigRequestedCount(config) ?? imageGenerationRequestedCount(messages, userID)
  const count = imageGenerationEffectiveCount(requested)
  if (!requested || !count || requested <= count) return {}
  return {
    requestedImageCount: requested,
    maxImageCount: maxImageGenerationCount,
  }
}

function imageGenerationContextPart(part: MessageV2.Part) {
  if (part.type === "text") {
    return MessageV2.visibleUserTextPart(part)
  }
  if (part.type !== "file") return undefined
  if (part.mime.startsWith("image/")) return `[Image: ${part.filename || part.mime}]`
  return `[File: ${part.filename || "file"} (${part.mime})]`
}

function imageGenerationToolContextPart(part: MessageV2.Part) {
  if (part.type !== "tool" || part.tool !== "image_generation") return undefined
  if (part.state.status !== "running" && part.state.status !== "completed" && part.state.status !== "error")
    return undefined
  const prompt = typeof part.state.input.prompt === "string" ? part.state.input.prompt.trim() : undefined
  const context = typeof part.state.input.context_text === "string" ? part.state.input.context_text.trim() : undefined
  const output = part.state.status === "completed" ? part.state.output.trim() : undefined
  const revisedPrompts =
    part.state.status === "completed" && Array.isArray(part.state.metadata.revisedPrompts)
      ? part.state.metadata.revisedPrompts
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .join("\n")
          .trim()
      : undefined
  const images = (part.state.attachments ?? [])
    .filter(
      (attachment) => attachment.mime.startsWith("image/") && !attachment.filename?.startsWith("wanlai-image-loading-"),
    )
    .map((attachment) => `[Generated image: ${attachment.filename || attachment.mime}]`)
    .join("\n")
  const body = [
    prompt ? `previous_image_request:\n${prompt}` : undefined,
    context ? `previous_image_context:\n${context}` : undefined,
    output ? `previous_image_output:\n${output}` : undefined,
    revisedPrompts ? `previous_revised_prompts:\n${revisedPrompts}` : undefined,
    images || undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .trim()
  return body || undefined
}

function imageGenerationContext(messages: MessageV2.WithParts[]) {
  const text = messages
    .slice(-10)
    .flatMap((message) => {
      const body = message.parts
        .map(imageGenerationContextPart)
        .filter((item): item is string => !!item)
        .join("\n")
        .trim()
      if (!body) return []
      return [`${message.info.role === "assistant" ? "Assistant" : "User"}:\n${body}`]
    })
    .join("\n\n")
    .trim()
  if (text.length <= 12_000) return text || undefined
  const marker = "\n\n[Middle context omitted for image generation]\n\n"
  const budget = Math.max(0, 12_000 - marker.length)
  const head = Math.floor(budget * 0.25)
  const tail = budget - head
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-tail).trimStart()}`
}

function latestImageGenerationContextBefore(messages: MessageV2.WithParts[], userID: MessageID) {
  const userIndex = messages.findIndex((message) => message.info.role === "user" && message.info.id === userID)
  const before = userIndex < 0 ? messages : messages.slice(0, userIndex)
  const context = before
    .slice()
    .reverse()
    .flatMap((message) =>
      message.parts
        .slice()
        .reverse()
        .flatMap((part) => {
          const text = imageGenerationToolContextPart(part)
          return text ? [text] : []
        }),
    )[0]
  if (!context) return undefined
  return [
    "Prior generated image state:",
    "Use the latest generated image as the edit source.",
    "Preserve all previously achieved text, names, layout, style, and visual constraints unless the latest user request explicitly changes them.",
    "Only apply the latest requested change; do not invent a different target image.",
    "",
    context,
  ].join("\n")
}

function imageGenerationToolInput(
  messages: MessageV2.WithParts[],
  userID: MessageID,
  config?: PromptInput["imageGeneration"],
) {
  const latestText = latestVisibleUserText(messages, userID)
  const previousAssistantText =
    latestText && terseImageGenerationRequest.test(latestText)
      ? latestVisibleAssistantTextBefore(messages, userID)
      : undefined
  const action = imageGenerationAction(messages, userID)
  const requestedCount = imageGenerationConfigRequestedCount(config) ?? imageGenerationRequestedCount(messages, userID)
  const count = imageGenerationEffectiveCount(requestedCount)
  const priorGenerated = action === "edit" ? latestImageGenerationContextBefore(messages, userID) : undefined
  const context = imageGenerationContext(messages)
  return {
    prompt: previousAssistantText
      ? "把上一条 assistant 回答排版成一张清晰的中文信息卡/文档卡图片。逐字保留上一条回答的主要文本、结构、列表、题干、选项、答案和解析；只使用 context_text 中 immediate_previous_assistant_answer 的内容，不要使用更早的图片、截图或旧的生图任务。"
      : priorGenerated
        ? `继续编辑上一张已生成图片：${latestText || "按用户最新要求编辑图片"}。保留上一轮已经达成的文字、昵称、布局、风格和截图内容，只应用本次明确要求的变化。`
        : latestText || "Generate an image from the recent conversation context.",
    context_text: previousAssistantText
      ? [
          "Image generation source priority:",
          "Use only the immediate_previous_assistant_answer below as the image content source.",
          "Ignore older chat images, screenshots, generated-image results, revised prompts, and unrelated previous visual tasks.",
          "Output requirement:",
          "Create a readable Chinese information card / document card / worksheet layout from the answer content. Do not illustrate nouns, characters, animals, scenery, products, or objects mentioned inside the answer as the main subject unless the latest user explicitly asks for an illustration.",
          "All visible text must come from immediate_previous_assistant_answer unless minor layout labels are needed.",
          "",
          "latest_user_request:",
          latestText,
          "",
          "immediate_previous_assistant_answer:",
          previousAssistantText,
        ].join("\n")
      : [
          priorGenerated,
          requestedCount && count && requestedCount > count
            ? `image_count_limit:\nrequested_image_count: ${requestedCount}\neffective_image_count: ${count}\nmax_image_count: ${maxImageGenerationCount}`
            : undefined,
          "latest_user_request:",
          latestText,
          "",
          context ? `recent_conversation:\n${context}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .trim(),
    action,
    ...(action === "edit" ? { use_recent_images: true } : {}),
    // 尺寸/格式/文案等客户端配置不进工具参数：它们已随用户消息持久化，工具执行时按会话读取权威值。
    ...(count ? { count } : {}),
  }
}

function imageGenerationContextValue(contextText: string | undefined, label: string) {
  if (!contextText) return undefined
  const marker = `${label}:`
  const start = contextText.indexOf(marker)
  if (start < 0) return undefined
  const rest = contextText.slice(start + marker.length)
  return rest
    .split(/\n(?:image_count_limit|latest_user_request|immediate_previous_assistant_answer|recent_conversation):/)[0]
    ?.trim()
}

function compactImageGenerationSnippet(text: string | undefined, maxLength = 48) {
  const normalized = text?.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function imageGenerationLooksLikeQuestionCard(text: string | undefined) {
  if (!text) return false
  return /选择题|答案[:：]|解析[:：]|(?:^|\s)[A-D][.、]/.test(text)
}

function preservedImageLabel(contextText: string | undefined) {
  const prior = contextText?.split("latest_user_request:")[0]
  const quoted = prior?.match(/[「“"]([^」”"]{2,20})[」”"]/)
  if (quoted?.[1]) return quoted[1].trim()
  const changedTo = prior?.match(/(?:改成|改为|昵称改成|昵称改为)([^\n，。,.]{2,20})/)
  return changedTo?.[1]?.trim()
}

function imageGenerationResultText(
  args: ReturnType<typeof imageGenerationToolInput>,
  result: { metadata: Record<string, any> },
) {
  const count = typeof result.metadata.imageCount === "number" ? result.metadata.imageCount : args.count
  const suffix = count && count > 1 ? `${count}张独立图片` : "图片"
  const limitText = imageGenerationCountLimitText(result.metadata, count)
  const latestRequest = compactImageGenerationSnippet(
    imageGenerationContextValue(args.context_text, "latest_user_request") ?? args.prompt,
  )
  const previousAnswer = imageGenerationContextValue(args.context_text, "immediate_previous_assistant_answer")
  const contextLooksLikeQuestionCard = imageGenerationLooksLikeQuestionCard(previousAnswer ?? args.context_text)

  if (previousAnswer) {
    if (contextLooksLikeQuestionCard) return `已把上一条回答里的选择题整理成${suffix}，包含题干、选项、答案和解析。`
    return `已根据上一条回答生成${suffix}，保留了原文重点和结构。`
  }

  if (args.action === "edit") {
    const label = preservedImageLabel(args.context_text)
    if (label && latestRequest?.includes("头像"))
      return `已在上一张生成图基础上继续编辑，保留「${label}」和原有布局，只按这次要求调整头像。`
    return latestRequest ? `已在上一张生成图基础上完成图片编辑：${latestRequest}。` : `已按你的要求完成图片编辑。`
  }

  if (contextLooksLikeQuestionCard)
    return `已把上下文里的选择题内容生成${suffix}，每张单独成图，包含题干、选项、答案和解析。`
  if (limitText) return limitText
  return `已按你的要求生成${suffix}。`
}

function isInstructionUser(message: MessageV2.WithParts): message is MessageV2.WithParts & { info: MessageV2.User } {
  return (
    message.info.role === "user" &&
    !message.parts.some((part) => part.type === "compaction" || part.type === "subtask") &&
    message.parts.some(
      (part) =>
        (part.type === "text" && !part.ignored && !part.synthetic && part.text.trim().length > 0) ||
        part.type === "file",
    )
  )
}

function withoutDeferredUsers(msgs: MessageV2.WithParts[], deferred: Set<MessageID>) {
  // 延期 user 时同步移除其直属 assistant，避免恢复快照把尚未轮到的完整/半完整回合泄漏进当前模型上下文。
  return msgs.filter((message) => {
    if (message.info.role === "user") return !deferred.has(message.info.id)
    return !deferred.has(message.info.parentID)
  })
}

type PendingInternalTask = {
  part: MessageV2.CompactionPart | MessageV2.SubtaskPart
  owner: MessageV2.User
  partIndex: number
}

function pendingInternalTasks(msgs: MessageV2.WithParts[]): PendingInternalTask[] {
  const completed = new Map<
    MessageID,
    {
      subtaskPartIDs: Set<string>
      legacySubtasks: { tool: MessageV2.ToolPart; agent: string; standalone: boolean }[]
      compaction: number
    }
  >()
  for (const message of msgs) {
    if (message.info.role !== "assistant" || !message.info.parentID || !assistantTerminal(message.info)) continue
    const count = completed.get(message.info.parentID) ?? {
      subtaskPartIDs: new Set<string>(),
      legacySubtasks: [],
      compaction: 0,
    }
    // 新任务按来源 SubtaskPart ID 精确确认；无标记的旧数据保留输入签名兼容，不能把父模型自行调用 task 算进去。
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== TaskTool.id) continue
      // assistant 终态可能早于 tool part 最终落库；running/pending 仍需恢复，不能提前计为完成。
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      const sourceID = "metadata" in part.state ? part.state.metadata?.internalSubtaskPartID : undefined
      if (typeof sourceID === "string") count.subtaskPartIDs.add(sourceID)
      else {
        count.legacySubtasks.push({
          tool: part,
          agent: message.info.agent,
          // 旧 handleSubtask assistant 只含一个 task tool；父模型调用通常还包含 step/reasoning/text part。
          standalone: message.parts.length === 1,
        })
      }
    }
    if (message.info.summary === true) count.compaction += 1
    completed.set(message.info.parentID, count)
  }

  const pending: PendingInternalTask[] = []
  for (const message of msgs) {
    if (message.info.role !== "user") continue
    const state = completed.get(message.info.id) ?? {
      subtaskPartIDs: new Set<string>(),
      legacySubtasks: [] as { tool: MessageV2.ToolPart; agent: string; standalone: boolean }[],
      compaction: 0,
    }
    const legacySubtasks = [...state.legacySubtasks]
    let remainingCompactions = state.compaction
    for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
      const part = message.parts[partIndex]
      if (part.type !== "subtask" && part.type !== "compaction") continue
      if (part.type === "subtask") {
        if (state.subtaskPartIDs.has(part.id)) continue
        // 旧版内部任务用 assistant 形态 + 输入签名兼容；即使同一 user 已出现新标记，也不能把旧完成记录重新入队。
        const legacyIndex = legacySubtasks.findIndex((candidate) => {
          const input = candidate.tool.state.input
          return (
            candidate.standalone &&
            candidate.agent === part.agent &&
            input.prompt === part.prompt &&
            input.description === part.description &&
            input.subagent_type === part.agent &&
            input.command === part.command
          )
        })
        if (legacyIndex >= 0) {
          legacySubtasks.splice(legacyIndex, 1)
          continue
        }
      } else if (remainingCompactions > 0) {
        remainingCompactions -= 1
        continue
      }
      pending.push({ part, owner: message.info, partIndex })
    }
  }

  // 跨 user 按真实创建顺序、同一 user 按 part 顺序执行，兼容 msg_remote_<hash> 旧消息 ID。
  return pending.sort((left, right) => {
    const ownerOrder = compareMessageOrder(left.owner, right.owner)
    return ownerOrder !== 0 ? ownerOrder : left.partIndex - right.partIndex
  })
}
function hasManualSteerMarker(message: MessageV2.WithParts) {
  if (message.info.role !== "user") return false
  // marker 是 steer 完整落库的最后凭据；普通 noReply、目标续跑和自动队列不能被误判为引导。
  return message.parts.some(
    (part) => part.type === "text" && part.synthetic === true && part.metadata?.manual_steer_context === true,
  )
}

function isManualSteerUser(message: MessageV2.WithParts) {
  // 幂等 ACK 只认完整 marker，避免 info 已落库但 parts 尚未写完的半条消息被错误确认。
  return hasManualSteerMarker(message)
}

function isManualSteerCandidate(message: MessageV2.WithParts) {
  if (message.info.role !== "user") return false
  // info 会先于 marker part 持久化；runner 先按权威 target 识别候选，覆盖两次写入之间的竞态窗口。
  if (message.info.steerTargetTurnID !== undefined) return true
  // 兼容旧数据库：没有显式 target 的 steer 只能靠 marker 判断。
  return hasManualSteerMarker(message)
}

function manualSteerTargetTurnID(message: MessageV2.WithParts) {
  if (message.info.role !== "user") return
  if (message.info.steerTargetTurnID) return message.info.steerTargetTurnID
  const marker = message.parts.find(
    (part) => part.type === "text" && part.synthetic === true && part.metadata?.manual_steer_context === true,
  )
  const target = marker?.type === "text" ? marker.metadata?.manual_steer_target_turn_id : undefined
  return typeof target === "string" && MessageID.zod.safeParse(target).success ? MessageID.make(target) : undefined
}

function awaitingInstructionUsers(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
  // 消息 ID 可能来自远控/导入，不能用字典序推断先后；stream 已按数据库创建时间排好序，直接使用数组位置。
  const indexes = new Map(msgs.map((message, index) => [message.info.id, index]))
  const completed = completedInstructionUserIDs(msgs)
  const respondedThrough = msgs.reduce((max, message) => {
    if (message.info.role !== "assistant" || !assistantCompletesInstruction(message.info) || !message.info.parentID)
      return max
    // 压缩摘要只完成内部 compaction user，不能用它的位置吞掉更早仍待处理的普通队列。
    if (message.info.summary) return max
    if (message.info.completedUserMessageIDs) {
      // steer 的显式完成列表允许跨过中间的普通 noReply；这些 ID 已按精确集合消费，不能再推进位置 high-water。
      return max
    }
    const parentIndex = indexes.get(message.info.parentID)
    // parent 被压缩掉时不能拿 assistant 自身位置代替：旧回合终态可能晚于新引导落库，否则会误把新引导标成已回答。
    return parentIndex === undefined ? max : Math.max(max, parentIndex)
  }, -1)
  return msgs.filter(
    (m, index) =>
      m.info.role === "user" &&
      !m.parts.some((p) => p.type === "compaction" || p.type === "subtask") &&
      m.parts.some(
        (p) => (p.type === "text" && !p.ignored && !p.synthetic && p.text.trim().length > 0) || p.type === "file",
      ) &&
      index > respondedThrough &&
      !completed.has(m.info.id),
  )
}

type ActiveTurn = {
  id: MessageID
  rootMessageID?: MessageID
  runID: MessageID
  steerEpoch: number
  // 活动身份必须绑定创建它的取消代次；旧 runner 的迟到清理状态不能冒充当前回合。
  cancelEpoch: number
}
type ScheduledTurn = {
  id: MessageID
  generation: number
  // pending 身份与 durable user 提交时的取消代次一致，供 stop 排除已经失效的旧调度。
  cancelEpoch: number
  fibers?: ReadonlySet<Fiber.Fiber<unknown, unknown>>
}

/** @internal 只导出给会话竞态测试；生产停止与提交必须共用同一个当前代次判据。 */
export function currentTurnIDAtEpoch(input: {
  active?: { id: MessageID; cancelEpoch: number }
  scheduled?: { id: MessageID; cancelEpoch: number }
  cancelEpoch: number
}) {
  if (input.active?.cancelEpoch === input.cancelEpoch) return input.active.id
  if (input.scheduled?.cancelEpoch === input.cancelEpoch) return input.scheduled.id
  return undefined
}

type ActiveStep = {
  turnID: MessageID
  runID: MessageID
  steerEpoch: number
  controller: AbortController
  interruptible: () => boolean
}

// HTTP 服务端与 AppRuntime 会各自构建 SessionPrompt Layer，但同一会话只能有一套提交顺序和活动回合身份。
// 这些控制状态必须跨 Layer 共享，才能让 HTTP 的 steer/cancel 命中 AppRuntime 启动的目标回合；会话 ID 全局唯一，
// 活动回合在 runner 收尾时删除，取消代次与回复代次只保留轻量数字状态。
const promptLocks = new Map<SessionID, Semaphore.Semaphore>()
const turnLocks = new Map<SessionID, Semaphore.Semaphore>()
const activeTurns = new Map<SessionID, ActiveTurn>()
// runner 回到 idle 后，新回合可能先登记并覆盖 activeTurns；失败收尾必须仍能按 runID 找回自己的 turn，
// 否则旧错误会结算到新引导回合，留下没有终态的空 assistant。
const turnByRunID = new Map<MessageID, { sessionID: SessionID; turnID: MessageID }>()
// 同步/异步 prompt 在 durable user 与 runner 登记之间都发布权威 turn 身份，停止才能精确结算尚未启动的回合。
const scheduledTurns = new Map<SessionID, ScheduledTurn>()
// 当前采样控制器跨 Layer 共享，让 HTTP steer 能精确命中 AppRuntime 中同一 session/turn/runner 的旧模型步骤。
const activeSteps = new Map<SessionID, ActiveStep>()
const cancelEpochs = new Map<SessionID, number>()
const replyGenerations = createReplyGenerationTracker()

/** @internal 只读快照用于验证会话结束后没有遗留可执行身份；稳定锁与取消 token 不属于在途工作。 */
export function sessionPromptLifecycleState(sessionID: SessionID) {
  return {
    activeTurn: activeTurns.has(sessionID),
    scheduledTurn: scheduledTurns.has(sessionID),
    activeStep: activeSteps.has(sessionID),
    replyGeneration: replyGenerations.active(sessionID),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    // 取消代次独立于 runner 生命周期：即使 ACK 后 runner 尚未创建，停止操作也能废止已调度的回复任务。
    const cancelEpoch = (sessionID: SessionID) => cancelEpochs.get(sessionID) ?? 0
    const replyCancelled = (sessionID: SessionID, epoch: number) => cancelEpoch(sessionID) !== epoch
    // 每个真实回复只在存活期间持有代次；失败去重仍覆盖 runner 与共享 waiter，完成后立即释放长会话状态。
    const beginReplyGeneration = (sessionID: SessionID) => replyGenerations.begin(sessionID)
    const finishReplyGeneration = (sessionID: SessionID, generation: number) =>
      replyGenerations.finish(sessionID, generation)
    const markReplyFailureHandled = (sessionID: SessionID, generation: number | undefined) =>
      replyGenerations.markHandled(sessionID, generation)
    const promptLock = (sessionID: SessionID) => {
      const existing = promptLocks.get(sessionID)
      if (existing) return existing
      // 同一会话的 prompt、prompt_async、steer 与 cancel 共用提交顺序；HTTP ACK 后下一条请求才能稳定排在它后面。
      const created = Semaphore.makeUnsafe(1)
      promptLocks.set(sessionID, created)
      return created
    }
    const turnLock = (sessionID: SessionID) => {
      const existing = turnLocks.get(sessionID)
      if (existing) return existing
      // 引导接收与 runner 收尾共用这把锁，确保“接收到当前回合”和“回合已经结束”只有一个先发生。
      const created = Semaphore.makeUnsafe(1)
      turnLocks.set(sessionID, created)
      return created
    }
    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID, options?: CancelOptions) => cancel(sessionID, options),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input),
      } satisfies TaskPromptOps
    })

    const consumeStoppedSteers = Effect.fn("SessionPrompt.consumeStoppedSteers")(function* (
      sessionID: SessionID,
      turnID: MessageID,
    ) {
      const messages = yield* MessageV2.filterCompactedEffect(sessionID)
      const turnUsers = messages.filter(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
          message.info.role === "user" &&
          (MessageV2.userTurnID(message.info) === turnID || manualSteerTargetTurnID(message) === turnID),
      )
      const turnUserIDs = new Set(turnUsers.map((message) => message.info.id))
      const turnAssistant = messages.findLast(
        (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
          message.info.role === "assistant" &&
          (message.info.turnID === turnID ||
            (message.info.turnID === undefined && turnUserIDs.has(message.info.parentID))),
      )
      const latestTurnUser = turnUsers.at(-1)
      const assistantCoversLatestUser =
        !!turnAssistant &&
        !!latestTurnUser &&
        messages.indexOf(turnAssistant) > messages.indexOf(latestTurnUser)
      if (turnAssistant && assistantCoversLatestUser && assistantCompletesInstruction(turnAssistant.info)) {
        // 官方停止会清空当前 turn 的 pending input；本地 durable 气泡继续保留。
        // 同时把整回合精确结算，防止刷新后重放 root 或 steer。
        const previousCompletedUserMessageIDs = turnAssistant.info.completedUserMessageIDs ?? []
        const completedUserMessageIDs = [...new Set([...previousCompletedUserMessageIDs, ...turnUserIDs])]
        // 不能只比较长度：旧数据可能含重复 ID，集合内容变化但长度不变时也必须持久化新的精确完成集合。
        const completionSetChanged =
          completedUserMessageIDs.length !== previousCompletedUserMessageIDs.length ||
          completedUserMessageIDs.some((id, index) => id !== previousCompletedUserMessageIDs[index])
        if (completionSetChanged) {
          turnAssistant.info.completedUserMessageIDs = completedUserMessageIDs
          yield* sessions.updateMessage(turnAssistant.info)
        }
        return
      }

      const root = messages.find(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
          message.info.role === "user" && MessageV2.userTurnID(message.info) === turnID,
      )
      const now = Date.now()
      if (turnAssistant && assistantCoversLatestUser && !assistantCompletesInstruction(turnAssistant.info)) {
        // assistant 已经覆盖最新用户输入、但还没有真正完成指令时，停止直接补写中断错误。
        // 这里也包含被动 teardown 只写 completed、未写 finish/error 的半成品；复用它可避免再造重复 tombstone。
        turnAssistant.info.error = new MessageV2.AbortedError({ message: "Aborted" }).toObject()
        turnAssistant.info.finish = turnAssistant.info.finish ?? "stop"
        turnAssistant.info.time.completed = turnAssistant.info.time.completed ?? now
        turnAssistant.info.completedUserMessageIDs = [
          ...new Set([...(turnAssistant.info.completedUserMessageIDs ?? []), ...turnUserIDs]),
        ]
        yield* sessions.updateMessage(turnAssistant.info)
        return
      }
      if (!root) return

      // active 或 scheduled turn 尚未创建 assistant 时，cancel 仍必须留下一个持久终态。
      // 这个 tombstone 同时结束 root 与已 ACK 的 steer，防止默认 resumeQueued 或后续新 prompt 再次启动同一回合。
      const ctx = yield* InstanceState.context
      const model = root.info.model
      const tombstone: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        // 旧工具步骤可能已经收尾，但最新 steer 仍没有回复；tombstone 必须挂在最后一条 turn user 后面。
        parentID: latestTurnUser?.info.id ?? root.info.id,
        turnID,
        sessionID,
        mode: root.info.agent,
        agent: root.info.agent,
        variant: root.info.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
        finish: "stop",
        // root 和本回合 steer 一起结算；普通排队消息使用自己的 turnID，不会被这个 tombstone 吞掉。
        completedUserMessageIDs: [...turnUserIDs],
        time: { created: now, completed: now },
      }
      yield* sessions.updateMessage(tombstone)
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID, options?: CancelOptions) {
      yield* elog.info("cancel", { sessionID })
      yield* promptLock(sessionID).withPermits(1)(
        Effect.gen(function* () {
          const durableMessages = yield* MessageV2.filterCompactedEffect(sessionID)
          // awaitingInstructionUsers 的运行语义只返回 user；显式收窄让恢复 turnID 不依赖联合类型猜测。
          const durablePendingUser = awaitingInstructionUsers(durableMessages).find(
            (message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user",
          )
          const latestDurableAssistant = durableMessages.findLast(
            (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
              message.info.role === "assistant",
          )
          // 只有时间线最后一条 assistant 自身仍未终态时才允许恢复；历史 tool-calls 步不能让空闲会话的 stop 误伤旧回合。
          const durableAssistant =
            latestDurableAssistant && !assistantTerminal(latestDurableAssistant.info)
              ? latestDurableAssistant
              : undefined
          const durableAssistantParent = durableAssistant
            ? durableMessages.find(
                (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
                  message.info.role === "user" && message.info.id === durableAssistant.info.parentID,
              )
            : undefined
          // 异常可能发生在 assistant 已落库、runner 身份已拆除的窗口；显式停止仍要从持久化消息恢复回合，
          // 把空 assistant 收成 aborted 终态，避免这个会话永久卡在“处理中”。
          const durableTurnID = durableAssistant
            ? (durableAssistant.info.turnID ??
              (durableAssistantParent ? MessageV2.userTurnID(durableAssistantParent.info) : undefined))
            : options?.resumeQueued === false && durablePendingUser
              ? MessageV2.userTurnID(durablePendingUser.info)
              : undefined
          // 回合标识必须在提交锁内校验；旧页面的迟到停止不能递增新回合的取消代次。
          const stoppedTurn = yield* turnLock(sessionID).withPermits(1)(
            Effect.sync(() => {
              const epoch = cancelEpoch(sessionID)
              const current = activeTurns.get(sessionID)
              const scheduled = scheduledTurns.get(sessionID)
              // runner 拆卸可能晚于同步 waiter 返回；只有仍属于当前取消代次的身份才能接受这次停止。
              const scheduledTurn = scheduled?.cancelEpoch === epoch ? scheduled : undefined
              const turnID = currentTurnIDAtEpoch({ active: current, scheduled, cancelEpoch: epoch }) ?? durableTurnID
              if (options?.turnID !== undefined && turnID !== options.turnID) {
                // 带旧 turnID 的停止只做幂等无操作，避免误杀后来启动的回合。
                return undefined
              }
              // 显式停止没有任何可恢复目标时保持幂等；默认 cancel 仍要进入后续恢复流程，唤醒已有普通队列。
              if (!turnID && options?.resumeQueued === false) return undefined
              cancelEpochs.set(sessionID, epoch + 1)
              // 校验与摘除身份必须在同一个 turnLock 临界区完成；goal 写库期间即使旧 runner 收尾，
              // 后续停止也只能结算这里认领的回合，不能二次取值后误伤刚切换的新回合。
              activeTurns.delete(sessionID)
              scheduledTurns.delete(sessionID)
              return { turnID, fibers: [...(scheduledTurn?.fibers ?? [])] }
            }),
          )
          if (!stoppedTurn) return false

          // goal 暂停等关联写入只能在当前回合停止被接受后执行；同时必须早于 state.cancel，
          // 防止 runner 发布 idle 时仍读到 active goal 并抢先启动自动续跑。
          if (options?.onAccepted) yield* options.onAccepted

          // cancel 与 prompt/steer 共用提交锁：返回前既终止旧 runner，也收掉已经 durable ACK 但尚未回答的 steer。
          replyGenerations.invalidate(sessionID)
          // pending 窗口内的 root 与后续异步队列 waiter 都可能越过早期 epoch 检查；先全部中断，避免抢走续跑 runner。
          yield* Effect.forEach(stoppedTurn.fibers, (fiber) => Fiber.interrupt(fiber), {
            concurrency: "unbounded",
            discard: true,
          })
          yield* state.cancel(sessionID)
          if (stoppedTurn.turnID) yield* consumeStoppedSteers(sessionID, stoppedTurn.turnID)
          if (options?.resumeQueued === false) {
            // 完全停止只终止当前 runner；已经 durable ACK 的 steering 是同一 turn 的历史，不能因停止而删除。
            return true
          }

          // ESC 只中断当前在途任务：普通排队消息和已经持久化的内部任务都必须由新 runner 接续处理。
          const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
          if (awaitingInstructionUsers(msgs).length > 0 || pendingInternalTasks(msgs).length > 0) {
            yield* joinLoop({ sessionID, cancelEpoch: cancelEpoch(sessionID) }).pipe(
              Effect.catchCause((cause) => elog.error("post-cancel resume failed", { error: Cause.squash(cause) })),
              Effect.forkIn(scope),
            )
          }
          return true
        }),
      )
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) {
        yield* elog.warn("title generation skipped: no 'title' agent")
        return
      }
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      // 标题流：失败（限流/网络/etc）时指数退避重试，最多 3 次（间隔 2s / 4s）
      const streamTitle = llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [
            {
              role: "user",
              content:
                "Generate a title for this conversation. CRITICAL: write the title in the SAME natural language the user used (中文→中文 / 日本語→日本語 / English→English). Do NOT translate, do NOT describe the language.\n",
            },
            ...msgs,
          ],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.tapError((cause) =>
            elog.warn("title stream attempt failed, will retry", {
              error: typeof cause === "object" ? JSON.stringify(cause).slice(0, 300) : String(cause),
            }),
          ),
        )
      const text = yield* streamTitle.pipe(
        Effect.retry({
          schedule: Schedule.both(Schedule.exponential("2 seconds"), Schedule.recurs(2)),
        }),
        Effect.orDie,
      )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    const suggestion = Effect.fn("SessionPrompt.suggestion")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (cfg.prompt_suggestions === false) return
      const session = yield* sessions.get(input.sessionID)
      if (session.parentID) return
      const history = yield* sessions.messages({ sessionID: input.sessionID, limit: 24 })
      const lastUser = history.findLast((m) => m.info.role === "user")?.info
      if (!lastUser || lastUser.role !== "user") return
      if (lastUser.agent === "plan") return
      if (lastUser.format?.type === "json_schema") return
      const lastAssistant = history.findLast((m) => m.info.role === "assistant")?.info
      if (lastAssistant?.role === "assistant" && lastAssistant.error) return
      const context = SessionSuggestion.transcript(history)
      if (!context) return
      const ag = yield* agents.get("suggestion")
      if (!ag) {
        yield* elog.warn("suggestion generation skipped: no 'suggestion' agent")
        return
      }
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(lastUser.model.providerID)) ??
          (yield* provider.getModel(lastUser.model.providerID, lastUser.model.modelID)))
      let finish: string | undefined
      const text = yield* llm
        .stream({
          agent: ag,
          user: lastUser,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.sessionID,
          retries: 1,
          maxOutputTokens: SessionSuggestion.MAX_OUTPUT_TOKENS,
          messages: [
            {
              role: "user",
              content: "Here is the recent conversation:\n\n" + context + "\n\nPredict the user's next prompt.",
            },
          ],
        })
        .pipe(
          // 流中 error 事件直接失败，避免把半截文本发布成建议
          Stream.tap((e) => {
            if (e.type === "error") return Effect.fail(e.error)
            if (e.type === "finish-step") finish = e.finishReason
            return Effect.void
          }),
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
        )
      // 流被截断时（连接中断等）不会有正常的 stop finish，同样丢弃；
      // finish=length 多见于推理型小模型把 token 预算耗在思考上，记录便于诊断
      if (finish !== "stop") {
        yield* elog.info("suggestion discarded: stream finished without stop", { finish })
        return
      }
      const cleaned = SessionSuggestion.clean(text)
      if (!cleaned) return
      // 防过期：生成期间用户已发新消息则丢弃（窗口与生成时一致）
      const latest = yield* sessions.messages({ sessionID: input.sessionID, limit: 24 })
      if (SessionSuggestion.hasNewerUserMessage(latest, lastUser.id)) return
      yield* bus.publish(Session.Event.Suggestion, { sessionID: input.sessionID, text: cleaned })
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
      // 自动化运行标记取自回合根：多步回合里最后一条 user 消息可能是压缩续跑/子任务的内部合成消息，
      // 它不带 automationID，若按它判断会让无人值守契约在回合中途丢失。
      automationID?: string
      turnRoot?: MessageV2.User
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      // 语言提醒：把母语指令作为合成 part 追加到最新用户消息末尾（不展示给用户）。
      // 模型对最新用户轮的语言权重更高，比仅放 system 更能带动其思考(reasoning)使用目标语言。
      // 用 <system-reminder> 包裹：标记为系统背景约束而非用户发言，避免模型在正文里
      // 复述确认（如「我会用中文回复/不展示推理过程」）。
      const userInfo = userMessage.info
      if (userInfo.role === "user" && userInfo.language) {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userInfo.id,
          sessionID: userInfo.sessionID,
          type: "text",
          text: `<system-reminder>${SystemPrompt.language(userInfo.language)}</system-reminder>`,
          synthetic: true,
        })
      }

      // 自动化运行契约：告诉模型这是无人值守的计划运行，要直接执行任务而不是把它当成
      // 一次可以反问、需要立项的新请求。必须放在 plan 分支的提前 return 之前，
      // 保证任何 agent 下的自动化运行都拿得到；只入模型输入不落库，不污染会话历史与展示。
      // 真人插话后不再注入契约:用户就在屏幕前,再告诉模型「没有用户在场、不要提问」是错的
      if (input.automationID && !hasUserInterjection(input.messages, input.turnRoot)) {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userInfo.id,
          sessionID: userInfo.sessionID,
          type: "text",
          text: `<system-reminder>${runContract(input.automationID)}</system-reminder>`,
          synthetic: true,
        })
      }

      if (!Flag.WANLAICODE_EXPERIMENTAL_PLAN_MODE) {
        if (input.agent.name === "plan") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: PROMPT_PLAN,
            synthetic: true,
          })
        }
        const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
        if (wasPlan && input.agent.name === "build") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: BUILD_SWITCH,
            synthetic: true,
          })
        }
        return input.messages
      }

      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
        const ctx = yield* InstanceState.context
        const plan = Session.plan(input.session, ctx)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

      const ctx = yield* InstanceState.context
      const plan = Session.plan(input.session, ctx)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const insertPluginCapabilities = Effect.fn("SessionPrompt.insertPluginCapabilities")(function* (input: {
      messages: MessageV2.WithParts[]
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      // 只扫用户真实输入的 text part(排除我们/其它逻辑注入的 synthetic part)。
      const text = userMessage.parts
        .filter((p) => p.type === "text" && !("synthetic" in p && p.synthetic))
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("\n")
      // 无 mention 时不触碰 Addon service，零开销。
      const mentionKeys = parsePluginMentions(text)
      if (mentionKeys.length === 0) return input.messages

      const addonOpt = yield* Effect.serviceOption(Addon.Service)
      if (Option.isNone(addonOpt)) return input.messages
      const addons = yield* addonOpt.value.getAddons()

      const capabilityText = buildCapabilityText(mentionKeys, addons)
      if (!capabilityText) return input.messages

      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: capabilityText,
        synthetic: true,
      })
      return input.messages
    })

    const memoryBlock = Effect.fn("SessionPrompt.memoryBlock")(function* (input: {
      messages: MessageV2.WithParts[]
      session: Session.Info
      lastUser: MessageV2.User
    }) {
      const cfg = yield* config.getGlobal()
      if (cfg.memory?.enabled === false) return undefined
      const mode = cfg.memory?.default_mode ?? "auto"
      if (mode === "off") return undefined

      const store = yield* Effect.serviceOption(MemoryStore.Service)
      if (Option.isNone(store)) return undefined

      const entries = yield* store.value.list({ limit: 100 }).pipe(Effect.catch(() => Effect.succeed([])))
      const maxChars = cfg.memory?.max_prompt_chars ?? 4000
      const selected = MemoryContext.select({
        entries,
        query: latestVisibleUserText(input.messages, input.lastUser.id),
        maxEntries: cfg.memory?.max_prompt_entries ?? 8,
        maxChars,
      })
      const block = MemoryContext.format(selected)
      return block || undefined
    })

    const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      session: Session.Info
      tools?: Record<string, boolean>
      processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
      bypassAgentCheck: boolean
      messages: MessageV2.WithParts[]
      automationID?: string
      turnRoot?: MessageV2.User
      // 透传给子代理(task 工具)的展示语言与推理翻译开关，使子 session 与主 session 行为一致
      language?: string
      translateContent?: boolean
    }) {
      using _ = log.time("resolveTools")
      const tools: Record<string, AITool> = {}
      const run = yield* runner()
      const promptOps = yield* ops()
      // 真人插话后按普通回合处理:恢复 question / automation_create。
      // 用户既然在屏幕前敲了字,模型就该能反问、也该能应他的要求建自动化。
      const automationID = hasUserInterjection(input.messages, input.turnRoot) ? undefined : input.automationID

      const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: {
          model: input.model,
          cwd: input.session.directory,
          root: input.session.directory,
          bypassAgentCheck: input.bypassAgentCheck,
          promptOps,
          language: input.language,
          translateContent: input.translateContent,
          automationID,
        },
        agent: input.agent.name,
        messages: input.messages,
        metadata: (val) =>
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            const attachments = val.attachments?.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
            }))
            return {
              ...match,
              state: {
                title: val.title,
                metadata: mergeToolMetadata(match.state.status === "running" ? match.state.metadata : undefined, val.metadata),
                attachments,
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
        ask: (req) =>
          permission
            .ask(
              {
                ...req,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
              },
              {
                onReview: (review) =>
                  input.processor
                    .updateToolCall(options.toolCallId, (match) => applyToolPermissionReview(match, review))
                    .pipe(Effect.asVoid),
              },
            )
            .pipe(Effect.orDie),
      })

      for (const item of yield* registry.tools({
        modelID: ModelID.make(input.model.api.id),
        providerID: input.model.providerID,
        agent: input.agent,
      })) {
        if (automationID && RUN_BLOCKED_TOOLS.has(item.id)) continue
        const schema = ProviderTransform.schema(input.model, EffectZod.toJsonSchema(item.parameters))
        tools[item.id] = tool({
          description: item.description,
          inputSchema: jsonSchema(schema),
          execute(args, options) {
            return run.promise(
              Effect.gen(function* () {
                const ctx = context(args, options)
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                  { args },
                )
                const result = yield* item.execute(args, ctx)
                const output = {
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                  output,
                )
                // 带图片/文件的工具结果必须先落库；AI SDK 后续 tool-result 事件只稳定承诺模型可见输出，
                // 普通模型调用 image_generation 时若丢了扩展 attachments，前端就只会看到 "Generated images" 文本。
                if (output.attachments?.length) {
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                } else if (options.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                }
                return output
              }),
            )
          },
        })
      }

      for (const [key, item] of Object.entries(yield* mcp.tools())) {
        const execute = item.execute
        if (!execute) continue

        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        const transformed = ProviderTransform.schema(input.model, schema)
        item.inputSchema = jsonSchema(transformed)
        item.execute = (args, opts) =>
          run.promise(
            Effect.gen(function* () {
              const ctx = context(args, opts)
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                { args },
              )
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
                yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
                return yield* Effect.promise(() => execute(args, opts))
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": key,
                    "tool.call_id": opts.toolCallId,
                    "session.id": ctx.sessionID,
                    "message.id": input.processor.message.id,
                  },
                }),
              )
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                result,
              )

              const textParts: string[] = []
              const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
              for (const contentItem of result.content) {
                if (contentItem.type === "text") textParts.push(contentItem.text)
                else if (contentItem.type === "image") {
                  attachments.push({
                    type: "file",
                    mime: contentItem.mimeType,
                    url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                  })
                } else if (contentItem.type === "resource") {
                  const { resource } = contentItem
                  if (resource.text) textParts.push(resource.text)
                  if (resource.blob) {
                    attachments.push({
                      type: "file",
                      mime: resource.mimeType ?? "application/octet-stream",
                      url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                      filename: resource.uri,
                    })
                  }
                }
              }

              const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
              const metadata = {
                ...result.metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              }

              const output = {
                title: "",
                metadata,
                output: truncated.content,
                attachments: attachments.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
                content: result.content,
              }
              if (opts.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(opts.toolCallId, output)
              }
              return output
            }),
          )
        tools[key] = item
      }

      return tools
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
      // 自动化标记由调用方按回合根兜底：subtask 的 owner 可能是压缩续跑产生的内部
      // user 消息（不带 automationID），只读 owner 会让子代理丢掉无人值守护栏。
      automationID?: string
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        // 子任务是当前逻辑回合中的工具步骤，不能因拥有独立 assistant 消息而被前端拆成新回合。
        turnID: MessageV2.userTurnID(lastUser),
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          // 将内部调度 part 与落库工具结果一一关联，防止父模型自己的 task 工具误消费后续 SubtaskPart。
          metadata: { internalSubtaskPartID: task.id },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: {
            bypassAgentCheck: true,
            promptOps,
            language: lastUser.language,
            translateContent: lastUser.translateContent,
            automationID: input.automationID ?? lastUser.automationID,
          },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              const current = part
              // TaskTool 只会在 running 阶段推送 metadata；终态回调直接忽略，避免把状态重新打开。
              if (current.state.status !== "running") return
              part = yield* sessions.updatePart({
                ...current,
                type: "tool",
                state: {
                  ...current.state,
                  ...val,
                  // TaskTool 会持续回写子会话 metadata；合并时必须保留内部调度来源，避免覆盖精确完成标记。
                  metadata: { ...current.state.metadata, ...val.metadata, internalSubtaskPartID: task.id },
                },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    // 取消可能发生在任意 metadata 回调之后；终态仍必须保留 SubtaskPart 外键供恢复去重。
                    metadata: { ...part.state.metadata, internalSubtaskPartID: task.id },
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: { ...result.metadata, internalSubtaskPartID: task.id },
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: {
              ...(part.state.status === "pending" ? {} : part.state.metadata),
              internalSubtaskPartID: task.id,
            },
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        // 子任务命令的总结提示仍由原回合继续执行，刷新后也必须保持相同归属。
        turnID: MessageV2.userTurnID(lastUser),
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: subtaskSummaryInstruction,
        synthetic: true,
        // 明确标记已进入父回合上下文的子任务摘要，恢复时不能把任意 synthetic user 都视为已消费。
        metadata: { subtask_summary: true },
      } satisfies MessageV2.TextPart)
    })

    const handleDirectImageGeneration = Effect.fn("SessionPrompt.handleDirectImageGeneration")(function* (input: {
      handle: SessionProcessor.Handle
      tools: Record<string, AITool>
      messages: MessageV2.WithParts[]
      lastUser: MessageV2.User
      model: Provider.Model
      imageGeneration?: PromptInput["imageGeneration"]
    }) {
      const imageTool = input.tools.image_generation
      if (!imageTool?.execute) return false

      const args = imageGenerationToolInput(input.messages, input.lastUser.id, input.imageGeneration)
      const errorMessages = {
        ...input.imageGeneration?.error_messages,
        group_disabled:
          input.imageGeneration?.error_messages?.group_disabled ??
          imageGenerationGroupDisabledText(input.lastUser.language),
      }
      const countLimitMetadata = imageGenerationRequestedCountLimitMetadata(
        input.messages,
        input.lastUser.id,
        input.imageGeneration,
      )
      const initialMetadata =
        Object.keys(countLimitMetadata).length > 0
          ? { ...countLimitMetadata, imageCount: 0, totalImageCount: args.count }
          : undefined
      const callID = `image_generation_${ulid()}`
      const controller = new AbortController()
      yield* input.handle.startToolCall(callID, "image_generation", args, initialMetadata)
      yield* input.handle.updateToolCall(callID, (part) => {
        if (part.state.status !== "running") return part
        return {
          ...part,
          // 直接路径无论成功或失败都自行写入最终 UI 状态，恢复时不需要普通模型再次回灌。
          state: {
            ...part.state,
            metadata: { ...part.state.metadata, responseComplete: true },
          },
        }
      })

      const result = yield* Effect.tryPromise({
        try: () =>
          imageTool.execute?.(args, {
            toolCallId: callID,
            abortSignal: controller.signal,
          } as ToolExecutionOptions) ?? Promise.reject(new Error("image_generation tool is not executable")),
        catch: (cause) => cause,
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            controller.abort()
            yield* input.handle.failToolCall(callID, new DOMException("Aborted", "AbortError"))
          }),
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            // 直接生图失败会同时显示工具卡片和 assistant 错误卡片；两处都必须写入本地化后的文案。
            const readable = readableImageGenerationErrorWithMessages(cause, errorMessages)
            yield* input.handle.failToolCall(callID, readable)
            // 图片生成工具失败已经写入 error tool part；显式结束本轮 assistant，
            // 避免前端在 message.completed 事件延迟或丢失时继续把会话判成运行中。
            input.handle.message.finish = "stop"
            input.handle.message.time.completed = Date.now()
            yield* input.handle.fail(new Error(readable, { cause }))
            return undefined
          }),
        ),
      )

      if (result && typeof result === "object" && "title" in result && "metadata" in result && "output" in result) {
        const output = result as {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        }
        const completed = {
          ...output,
          metadata: {
            ...output.metadata,
            ...countLimitMetadata,
            responseComplete: true,
          },
        }
        yield* input.handle.completeToolCall(callID, completed)
        // 图片完成后只追加确定性的正文说明，不再把结果交回普通模型自检，避免“发现不对再重试”的循环。
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: input.handle.message.id,
          sessionID: input.handle.message.sessionID,
          type: "text",
          text: imageGenerationResultText(args, completed),
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        } satisfies MessageV2.TextPart)
        input.handle.message.finish = "stop"
      }
      input.handle.message.time.completed = Date.now()
      yield* sessions.updateMessage(input.handle.message)
      return true
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
            const userMessageID = input.messageID ?? MessageID.ascending()
            const userMsg: MessageV2.User = {
              id: userMessageID,
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              // Shell 提交是独立逻辑回合，用户消息与其工具 assistant 共用同一个稳定身份。
              turnID: userMessageID,
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: MessageV2.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              // Shell 工具结果必须跟随触发它的用户回合，不能依赖 parentID 在刷新后猜测。
              turnID: userMsg.turnID,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const callID = ulid()
            const started = Date.now()
            const part: MessageV2.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            EventV2.run(SessionEvent.Shell.Started.Sync, {
              sessionID: input.sessionID,
              timestamp: DateTime.makeUnsafe(started),
              callID,
              command: input.command,
            })
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              EventV2.run(SessionEvent.Shell.Ended.Sync, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(completed),
                callID: part.callID,
                output,
              })
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output, description: "" },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: withWindowsUtf8ShellEnv({ ...shellEnv.env, TERM: "dumb" }),
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              const outputDecoder = createShellOutputDecoder()
              const recordOutput = (chunk: string) =>
                Effect.gen(function* () {
                  if (!chunk) return
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output, description: "" }
                    yield* sessions.updatePart(part)
                  }
                })
              yield* Stream.runForEach(handle.all, (chunk) => recordOutput(outputDecoder.decode(chunk)))
              yield* recordOutput(outputDecoder.flush())
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel()
    })

    type UserMessageInput = PromptInput & { steerTargetTurnID?: MessageID; turnID?: MessageID }

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: UserMessageInput) {
      const agentName = input.agent || (yield* agents.defaultAgent())
      const ag = yield* agents.get(agentName)
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* lastModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)
      const messageID = input.messageID ?? MessageID.ascending()
      // HTTP/测试调用可能传入 plain JSON；先解码成 MessageV2 的 class 实例，保证事件编码与刷新后的消息一致。
      const format = input.format === undefined ? undefined : Schema.decodeUnknownSync(MessageV2.Format)(input.format)

      const info: MessageV2.User = {
        id: messageID,
        role: "user",
        // 普通消息以自身 ID 开启回合；steer 则直接绑定服务端已校验的活动回合。
        turnID: input.turnID ?? input.steerTargetTurnID ?? messageID,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        language: input.language,
        translateContent: input.translateContent,
        imageGeneration: input.imageGeneration,
        // 远控幂等字段随消息持久化，但仍沿用已经归一化的 format 配置。
        format,
        remoteRequestKey: input.remoteRequestKey,
        remoteClientMessageID: input.remoteClientMessageID,
        automationID: input.automationID,
        steerTargetTurnID: input.steerTargetTurnID,
      }

      const current = Database.use((db) =>
        db
          .select({ agent: SessionTable.agent, model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get(),
      )
      // steer 复用活动 turn 的配置，不应把引导携带的旧客户端快照发布成会话级切换事件。
      if (input.steerTargetTurnID === undefined && current?.agent !== info.agent) {
        EventV2.run(SessionEvent.AgentSwitched.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: info.agent,
        })
      }
      if (
        input.steerTargetTurnID === undefined &&
        (current?.model?.providerID !== info.model.providerID ||
          current?.model.id !== info.model.modelID ||
          current?.model.variant !== info.model.variant)
      ) {
        EventV2.run(SessionEvent.ModelSwitched.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          model: {
            id: Modelv2.ID.make(info.model.modelID),
            providerID: Modelv2.ProviderID.make(info.model.providerID),
            variant: Modelv2.VariantID.make(info.model.variant ?? "default"),
          },
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
        // 文件、目录和 MCP 资源解析发生在任何消息落库前，必须允许调用方中断并向 Read 工具传播 abort。
        Effect.interruptible,
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts },
        // 插件预处理仍属于可放弃的提交前阶段；完成后才进入 durable user→generation→waiter 原子交接。
      ).pipe(Effect.interruptible)

      const parsed = MessageV2.Info.zod.safeParse(info)
      if (!parsed.success) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          issues: parsed.error.issues,
        })
      }
      parts.forEach((part, index) => {
        const p = MessageV2.Part.zod.safeParse(part)
        if (p.success) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          issues: p.error.issues,
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)
      const nextPrompt = parts.reduce(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
          }
          if (part.type === "file") {
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          }
          if (part.type === "agent") {
            result.agents.push(
              new AgentAttachment({
                name: part.name,
                source: part.source
                  ? new Source({
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    })
                  : undefined,
              }),
            )
          }
          return result
        },
        {
          text: [] as string[],
          files: [] as FileAttachment[],
          agents: [] as AgentAttachment[],
          synthetic: [] as string[],
        },
      )
      // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
      EventV2.run(SessionEvent.Prompted.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(info.time.created),
        prompt: {
          text: nextPrompt.text.join("\n"),
          files: nextPrompt.files,
          agents: nextPrompt.agents,
        },
      })
      for (const text of nextPrompt.synthetic) {
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        EventV2.run(SessionEvent.Synthetic.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          text,
        })
      }

      return { info, parts }
    }, Effect.scoped)

    const preparePrompt = Effect.fn("SessionPrompt.preparePrompt")(function* (input: UserMessageInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      if (input.steerTargetTurnID === undefined) {
        // turn/steer 只追加当前回合输入，不能借兼容 payload 中的 tools 改写会话级权限。
        const permissions = Object.entries(input.tools ?? {}).map(
          ([permission, enabled]) =>
            ({ permission, action: enabled ? "allow" : "deny", pattern: "*" }) satisfies Permission.Rule,
        )
        if (permissions.length > 0) {
          session.permission = permissions
          yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
        }
      }

      return { session, message }
    })

    const replyPrepared = Effect.fn("SessionPrompt.replyPrepared")(function* (input: {
      session: Session.Info
      message: MessageV2.WithParts
      cancelEpoch: number
      generation?: number
    }) {
      if (replyCancelled(input.message.info.sessionID, input.cancelEpoch)) return input.message
      const result = yield* joinLoop({
        sessionID: input.message.info.sessionID,
        activeRootMessageID: input.message.info.id,
        cancelEpoch: input.cancelEpoch,
        failureGeneration: input.generation,
      })
      // loop 被 abort 释放后不能继续走收尾补跑；resumeQueued=true 的续跑只由 cancel() 显式负责。
      if (replyCancelled(input.message.info.sessionID, input.cancelEpoch)) return result
      // 子代理会话由 task 调度器负责收尾；只对根会话补跑 runner 收尾竞态，避免子会话递归触发自身。
      if (input.session.parentID) return result
      const refreshed = yield* MessageV2.filterCompactedEffect(input.message.info.sessionID)
      const directTerminalAssistant = refreshed.some(
        (candidate) =>
          candidate.info.role === "assistant" &&
          candidate.info.parentID === input.message.info.id &&
          assistantCompletesInstruction(candidate.info),
      )
      if (directTerminalAssistant) return result
      const stillAwaiting = awaitingInstructionUsers(refreshed).some(
        (candidate) => candidate.info.id === input.message.info.id,
      )
      if (!stillAwaiting) return result

      // durable ACK 可能恰好落在旧 runner 收尾快照之后；只在目标消息仍明确待处理时再启动一次，避免重复回复。
      return yield* joinLoop({
        sessionID: input.message.info.sessionID,
        activeRootMessageID: input.message.info.id,
        cancelEpoch: input.cancelEpoch,
        failureGeneration: input.generation,
      })
    })

    const reportPromptFailure = Effect.fn("SessionPrompt.reportFailure")(function* (input: {
      sessionID: SessionID
      cause: Cause.Cause<unknown>
      cancelEpoch: number
      generation?: number
      runID?: MessageID
      activeRootMessageID?: MessageID
    }) {
      // 用户停止和实例销毁产生的中断由既有 abort 终态负责；不能在 runner 中断收尾时再抢提交锁发布错误。
      if (Cause.hasInterrupts(input.cause) || replyCancelled(input.sessionID, input.cancelEpoch)) return
      yield* promptLock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          if (
            replyCancelled(input.sessionID, input.cancelEpoch) ||
            (input.generation !== undefined && replyGenerations.handled(input.sessionID, input.generation)) ||
            // 没有 runID 的调用来自异步 waiter 外层兜底，只能结算当前代次；真实 runner work 则始终对自己启动的回合负责。
            (input.runID === undefined && !replyGenerations.current(input.sessionID, input.generation))
          )
            return

          // 检查、认领和发布都持有提交锁；共享 runner 的其余 waiter 会把各自代次标记为 handled，不再重复结算。
          markReplyFailureHandled(input.sessionID, input.generation)
          const failure = Cause.squash(input.cause)
          yield* elog.error("session reply failed", {
            sessionID: input.sessionID,
            runID: input.runID,
            error: failure,
          })
          const messages = yield* MessageV2.filterCompactedEffect(input.sessionID)
          const awaiting = awaitingInstructionUsers(messages)
          const failedTurnID = input.runID ? turnByRunID.get(input.runID)?.turnID : undefined
          const pending =
            (failedTurnID
              ? awaiting.findLast(
                  (message) => {
                    // 失败归属只读取 user 的 turn 身份；其它消息类型不能参与待回复选择。
                    if (message.info.role !== "user") return false
                    return (
                      MessageV2.userTurnID(message.info) === failedTurnID ||
                      manualSteerTargetTurnID(message) === failedTurnID
                    )
                  },
                )
              : undefined) ??
            (input.activeRootMessageID
              ? awaiting.find((message) => message.info.id === input.activeRootMessageID)
              : undefined) ??
            awaiting.at(0)
          if (pending?.info.role === "user") {
            const now = Date.now()
            const error = MessageV2.fromError(failure, { providerID: pending.info.model.providerID })
            const turnID = MessageV2.userTurnID(pending.info)
            const existing = messages.findLast(
              (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
                message.info.role === "assistant" &&
                !assistantTerminal(message.info) &&
                (message.info.parentID === pending.info.id || message.info.turnID === turnID),
            )
            if (existing) {
              // assistant 已经落库但 runner 在收尾前异常时，复用原消息补齐终态，避免同一问题出现两个错误气泡。
              existing.info.error = error
              existing.info.finish = existing.info.finish ?? "stop"
              existing.info.time.completed = existing.info.time.completed ?? now
              existing.info.completedUserMessageIDs = [
                ...new Set([...(existing.info.completedUserMessageIDs ?? []), pending.info.id]),
              ]
              yield* sessions.updateMessage(existing.info)
            } else {
              const ctx = yield* InstanceState.context
              // 预处理阶段也可能在 assistant 创建前失败；持久化终态占位后，刷新仍保持“有问有答”，后续队列可继续执行。
              yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "assistant",
                parentID: pending.info.id,
                turnID,
                sessionID: input.sessionID,
                mode: pending.info.agent,
                agent: pending.info.agent,
                variant: pending.info.model.variant,
                path: { cwd: ctx.directory, root: ctx.worktree },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: pending.info.model.modelID,
                providerID: pending.info.model.providerID,
                error,
                finish: "stop",
                completedUserMessageIDs: [pending.info.id],
                time: { created: now, completed: now },
              })
            }
          }
          // runner 是 busy/idle 的唯一所有者；失败结算只落终态并发布事件，不能覆盖已经启动的新 runner 状态。
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.sessionID,
            error: new NamedError.Unknown({ message: Cause.pretty(input.cause) }).toObject(),
          })
        }),
      )
    })

    const scheduleReply = Effect.fn("SessionPrompt.scheduleReply")(function* (input: {
      session: Session.Info
      message: MessageV2.WithParts
      cancelEpoch: number
      generation: number
    }) {
      const run = yield* runner()
      const reply = replyPrepared(input).pipe(
        Effect.catchCause((cause) =>
          reportPromptFailure({
            sessionID: input.message.info.sessionID,
            cause,
            cancelEpoch: input.cancelEpoch,
            generation: input.generation,
            // 异步 waiter 即使加入旧 runner，也必须把失败归属固定在自己提交的 durable root 上。
            activeRootMessageID: input.message.info.id,
          }),
        ),
        Effect.ensuring(
          turnLock(input.message.info.sessionID).withPermits(1)(
            Effect.sync(() => {
              const scheduled = scheduledTurns.get(input.message.info.sessionID)
              if (scheduled?.generation === input.generation) scheduledTurns.delete(input.message.info.sessionID)
            }),
          ),
        ),
      )
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>()
          // prompt_async 的 204 只表示 durable ACK；回复必须脱离 HTTP 请求 scope 继续运行。
          // EffectBridge 保留当前实例/工作区上下文，同时避免响应收尾把尚未创建 assistant 的 runner 一并中断。
          const fiber = yield* Effect.sync(() =>
            run.fork(
              Deferred.await(ready).pipe(
                Effect.andThen(reply),
                // finalizer 覆盖 ready 门闩本身；stop 在开闸前中断 fiber 也必须释放 generation。
                Effect.ensuring(
                  Effect.sync(() => finishReplyGeneration(input.message.info.sessionID, input.generation)),
                ),
              ),
            ),
          )
          yield* turnLock(input.message.info.sessionID).withPermits(1)(
            Effect.sync(() => {
              const scheduled = scheduledTurns.get(input.message.info.sessionID)
              // 子 fiber 先停在 ready 门闩，登记完成后才允许进入 replyPrepared；stop 不会落在 fork 与发布句柄之间。
              // 只挂到同一取消代次的 pending turn，避免旧 waiter 在 stop 后混入新回合的可取消句柄集合。
              if (scheduled?.cancelEpoch === input.cancelEpoch) {
                scheduledTurns.set(input.message.info.sessionID, {
                  ...scheduled,
                  fibers: new Set([...(scheduled.fibers ?? []), fiber]),
                })
              }
            }),
          )
          // fork、句柄发布和开闸不可被 HTTP scope 拆开，否则 detached fiber 会永久停在未完成的 ready 上。
          yield* Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
        }),
      )
    })

    const commitPrompt = Effect.fn("SessionPrompt.commitPrompt")(function* (input: PromptInput) {
      return yield* promptLock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          // cancel epoch 必须在取得提交锁后采样：排在 stop 后面的新 prompt 应继承新代次，不能被当作旧请求吞掉。
          const epoch = cancelEpoch(input.sessionID)
          // createUserMessage 内部仅让落库前的附件与插件预处理可中断；一旦开始持久化就必须连续交接给 generation/waiter。
          const prepared = yield* preparePrompt(input)
          if (input.noReply !== true && prepared.message.info.role !== "user") {
            throw new Error("Prepared prompt is not a user message")
          }
          // user 已成功持久化后再登记回复生命周期；预处理失败不会留下无法收尾的活动代次。
          const generation = input.noReply === true ? undefined : beginReplyGeneration(input.sessionID)
          if (generation === undefined) return { ...prepared, cancelEpoch: epoch, generation }

          yield* turnLock(input.sessionID).withPermits(1)(
            Effect.sync(() => {
              const active = activeTurns.get(input.sessionID)
              const scheduled = scheduledTurns.get(input.sessionID)
              // 同步与异步入口在 durable user 后都发布 pending 身份；当前代次已有 active/pending 时仍保持最早 root，
              // 旧代次的 runner 即使拆卸滞后也不能阻止新 prompt 发布自己的停止身份。
              if (currentTurnIDAtEpoch({ active, scheduled, cancelEpoch: epoch }) !== undefined) return
              scheduledTurns.set(input.sessionID, {
                id: MessageV2.userTurnID(prepared.message.info),
                generation,
                cancelEpoch: epoch,
              })
            }),
          )
          return { ...prepared, cancelEpoch: epoch, generation }
        }),
      )
    })

    const clearScheduledTurn = Effect.fn("SessionPrompt.clearScheduledTurn")(function* (input: {
      sessionID: SessionID
      generation: number
    }) {
      yield* turnLock(input.sessionID).withPermits(1)(
        Effect.sync(() => {
          // 只清理由本次提交创建的 pending 身份，不能让旧 fiber 删除后续 generation 的权威 turn。
          const scheduled = scheduledTurns.get(input.sessionID)
          if (scheduled?.generation === input.generation) scheduledTurns.delete(input.sessionID)
        }),
      )
    })

    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(
      function* (input: PromptInput) {
        return yield* Effect.acquireUseRelease(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // durable user、回复代次和同步 waiter 必须在 acquisition 内一次性交接，成功后所有退出路径才都有 release。
              const prepared = yield* commitPrompt(input)
              if (prepared.generation === undefined) return { prepared, fiber: undefined }
              const ready = yield* Deferred.make<void>()
              const fiber = yield* Deferred.await(ready).pipe(
                Effect.andThen(
                  replyPrepared(prepared).pipe(
                    Effect.ensuring(
                      clearScheduledTurn({ sessionID: input.sessionID, generation: prepared.generation }),
                    ),
                  ),
                ),
                // 同步 waiter 同样把清理包在 ready 外层，停止不会在 finalizer 安装前留下 generation。
                Effect.ensuring(Effect.sync(() => finishReplyGeneration(input.sessionID, prepared.generation))),
                // acquisition 只保护创建和句柄登记；waiter 必须立即进入可中断 ready 门闩，stop/release 才能触发完整 finalizer。
                Effect.interruptible,
                Effect.forkChild({ startImmediately: true }),
              )
              yield* turnLock(input.sessionID).withPermits(1)(
                Effect.sync(() => {
                  const scheduled = scheduledTurns.get(input.sessionID)
                  // 同步 waiter 与异步 waiter 遵守同一代次边界，旧请求不得注册到 stop 之后的新 pending turn。
                  if (scheduled?.cancelEpoch !== prepared.cancelEpoch) return
                  // 同步 prompt 也必须暴露可取消句柄；否则 pending A 会在默认 stop 后抢占 B 的恢复 runner。
                  scheduledTurns.set(input.sessionID, {
                    ...scheduled,
                    fibers: new Set([...(scheduled.fibers ?? []), fiber]),
                  })
                }),
              )
              yield* Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
              return { prepared, fiber }
            }),
          ),
          (acquired) => {
            if (!acquired.fiber) return Effect.succeed(acquired.prepared.message)
            return Fiber.join(acquired.fiber).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) &&
                replyCancelled(input.sessionID, acquired.prepared.cancelEpoch)
                  ? Effect.succeed(acquired.prepared.message)
                  : Effect.failCause(cause),
              ),
            )
          },
          (acquired) => {
            if (!acquired.fiber) return Effect.void
            // 正常完成时是幂等操作；失败或外部中断时会等待 scheduled/generation finalizer 全部完成。
            return Fiber.interrupt(acquired.fiber)
          },
        )
      },
    )

    const promptAsync = Effect.fn("SessionPrompt.promptAsync")(function* (input: PromptInput) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // 异步 ACK 只有在 detached waiter 完成登记后才能返回；请求 scope 中断不得留下无所有者的 pending 身份。
          const prepared = yield* commitPrompt(input)
          if (prepared.generation !== undefined) {
            // pending 身份已经在同一提交事务内发布；即使 stop 抢在 fork 前到达，旧 epoch 也会阻止迟到 runner 复活。
            yield* scheduleReply(prepared)
          }
          return prepared.message
        }),
      )
    })

    const steer: Interface["steer"] = Effect.fn("SessionPrompt.steer")(function* (input: SteerInput) {
      return yield* promptLock(input.sessionID).withPermits(1)(
        Effect.gen(function* () {
          const existing = input.messageID
            ? yield* sessions.findMessage(input.sessionID, (message) => message.info.id === input.messageID)
            : Option.none<MessageV2.WithParts>()
          if (Option.isSome(existing)) {
            const existingTargetTurnID = manualSteerTargetTurnID(existing.value)
            if (!existingTargetTurnID) {
              throw new Error(`Message ${existing.value.info.id} already exists and is not a manual steer`)
            }
            // marker 是最后一个持久化 part；它存在就证明整条引导已经 durable accepted，回合结束后重试也应幂等 ACK。
            if (isManualSteerUser(existing.value) && input.parts.length > 0) {
              if (existingTargetTurnID !== input.targetTurnID) {
                return yield* steerTurnInactiveError(input.sessionID, input.targetTurnID, existingTargetTurnID)
              }
              return SteerAck.make({ messageID: existing.value.info.id, targetTurnID: input.targetTurnID })
            }
            // marker 未完成时旧 target 不是服务端 ACK；进入 turnLock 清理后必须以 activeTurns 的权威身份判定改绑重试。
          }

          return yield* turnLock(input.sessionID).withPermits(1)(
            Effect.gen(function* () {
              const active = activeTurns.get(input.sessionID)
              // steer 只能接入当前取消代次；旧 runner 拆卸残留与旧 stop 一样必须按 inactive 处理。
              const activeTurn = active?.cancelEpoch === cancelEpoch(input.sessionID) ? active : undefined
              if (activeTurn?.id !== input.targetTurnID) {
                if (Option.isSome(existing) && !isManualSteerUser(existing.value) && input.parts.length > 0) {
                  // 旧客户端可能留下未完成 marker；非空重试失败时仍清掉半条记录，便于随后按普通队列恢复。
                  yield* sessions.removeMessage({ sessionID: input.sessionID, messageID: existing.value.info.id })
                }
                return yield* steerTurnInactiveError(input.sessionID, input.targetTurnID, activeTurn?.id)
              }
              if (input.parts.length === 0) {
                // 与官方顺序一致：只有 expected turn 仍活动时才报告空输入，且在任何清理或新消息落库前失败。
                return yield* new SteerEmptyInputError()
              }
              if (Option.isSome(existing)) {
                // marker 缺失说明上次接收没有完成；通过活动回合与输入校验后再清理，失败请求绝不能改动历史。
                yield* sessions.removeMessage({ sessionID: input.sessionID, messageID: existing.value.info.id })
              }

              const activeRoot = activeTurn.rootMessageID
                ? yield* sessions.findMessage(
                    input.sessionID,
                    (message) => message.info.role === "user" && message.info.id === activeTurn.rootMessageID,
                  )
                : Option.none<MessageV2.WithParts>()
              if (Option.isNone(activeRoot) || activeRoot.value.info.role !== "user") {
                throw new Error(`Active turn ${activeTurn.id} has no root user message`)
              }
              const root = activeRoot.value.info

              const prepared = yield* preparePrompt({
                ...input,
                // 活动 steer 只继承 root 配置；兼容 payload 中的发送快照仅供 inactive fallback 创建普通消息使用。
                agent: root.agent,
                model: { providerID: root.model.providerID, modelID: root.model.modelID },
                variant: root.model.variant,
                tools: root.tools,
                format: root.format,
                system: root.system,
                language: root.language,
                translateContent: root.translateContent,
                imageGeneration: root.imageGeneration,
                // automationID 不随 steer 继承:它的含义是「这条消息是自动化注入的」。
                // 用户手输的插话不是自动化发的 —— 继承过来会给用户自己的消息打上
                // 「通过自动化发送」徽章,也会让无人值守契约套在一次真人对话上。
                // 回合级的自动化身份仍由 turnRoot 持有,多步续跑不受影响。
                steerTargetTurnID: input.targetTurnID,
                parts: [
                  ...input.parts,
                  {
                    type: "text",
                    // 官方 turn/steer 只把原始用户 input 交给模型；空 ignored part 仅承担 durable ACK 与刷新恢复。
                    text: "",
                    synthetic: true,
                    ignored: true,
                    metadata: {
                      manual_steer_context: true,
                      manual_steer_target_turn_id: input.targetTurnID,
                    },
                  },
                ],
              })
              // durable marker 完整落库后推进分界代次；只中止仍在采样且尚未进入工具执行的旧步骤。
              // runner 本身保持运行，下一轮会以 steer user 为 parent 创建 assistant，因此不会退化成第二个对话。
              const steerEpoch = activeTurn.steerEpoch + 1
              activeTurns.set(input.sessionID, { ...activeTurn, steerEpoch })
              const activeStep = activeSteps.get(input.sessionID)
              if (
                activeStep?.turnID === input.targetTurnID &&
                activeStep.runID === activeTurn.runID &&
                activeStep.steerEpoch < steerEpoch &&
                activeStep.interruptible()
              ) {
                activeStep.controller.abort()
              }
              return SteerAck.make({ messageID: prepared.message.info.id, targetTurnID: input.targetTurnID })
            }),
          )
        }),
      )
    })

    const lastAssistant = Effect.fnUntraced(function* (
      sessionID: SessionID,
      afterSequence?: number,
    ) {
      // runner 只读取序号水位之后的一条 assistant，不能扫描并 hydrate 可能包含巨型 diff 的旧消息。
      const match = yield* sessions.latestAssistant({ sessionID, afterSequence })
      if (Option.isSome(match)) return match.value
      // 被动中断发生在 assistant 创建前时必须保留失败语义；历史回复不能伪装成本轮结果触发静默补跑。
      throw new Error(`No assistant message found for session ${sessionID}`)
    })

    // steer 只切断仍在采样的模型流；runner、活动 turn 和已开始的工具保持不变。
    // processor 会把该分界静默收尾，下一轮读取 durable 引导，不写用户停止才使用的中断错误。

    // 被动中断可能跳过 processor cleanup；仅终结本 runner 新建的 assistant，避免界面永久停留在“思考中”。
    // afterSequence 隔离历史回复；若新回合已抢先启动，busy 检查会阻止迟到清理误写它的消息。
    const finalizeInterrupted = Effect.fnUntraced(function* (
      sessionID: SessionID,
      afterSequence?: number,
    ) {
      const message = yield* lastAssistant(sessionID, afterSequence)
      const info = message.info
      if (info.role !== "assistant" || info.error || info.time.completed !== undefined) return message
      const busy = yield* state
        .assertNotBusy(sessionID)
        .pipe(Effect.as(false), Effect.catchCause(() => Effect.succeed(true)))
      if (busy) return message
      // 只补 completed，不补 finish：被动中断的半截回答仍可由后续循环继续完成。
      const updated: MessageV2.Assistant = { ...info, time: { ...info.time, completed: Date.now() } }
      yield* sessions
        .updateMessage(updated)
        .pipe(Effect.catchCause((cause) => elog.warn("failed to finalize interrupted message", { sessionID, cause })))
      return { ...message, info: updated }
    })

    type RunLoopInput = {
      sessionID: SessionID
      runID: MessageID
      cancelEpoch: number
      activeRootMessageID?: MessageID
    }
    const runLoop: (input: RunLoopInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (input: RunLoopInput) {
        const sessionID = input.sessionID
        const ctx = yield* InstanceState.context
        const slog = elog.with({ sessionID })
        let structured: unknown
        let step = 0
        let lengthContinuationCount = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        // 审批状态在整个活动 turn 内保持一致；权限模式则在每次实际执行前刷新。
        const approvalState = ApprovalReviewer.state()
        const initialMessages = yield* MessageV2.filterCompactedEffect(sessionID)
        const pendingTurnRoot = (messages: MessageV2.WithParts[], excluded = new Set<MessageID>()) => {
          const awaitingIDs = new Set(awaitingInstructionUsers(messages).map((message) => message.info.id))
          const continuationOwnerIDs = internalContinuationOwnerIDs(messages)
          const pendingTaskOwnerIDs = new Set(pendingInternalTasks(messages).map((task) => task.owner.id))
          const startedTaskOwnerIDs = new Set(
            messages.flatMap((message) =>
              message.info.role === "assistant" &&
              message.info.parentID &&
              !isStandaloneInternalTaskAssistant(message)
                ? [message.info.parentID]
              : [],
            ),
          )
          const continuation = messages.find(
            (message) =>
              message.info.role === "user" &&
              (!excluded.has(message.info.id) || pendingTaskOwnerIDs.has(message.info.id)) &&
              continuationOwnerIDs.has(message.info.id),
          )
          if (continuation) return continuation
          return messages.find((message) => {
            if (message.info.role !== "user") return false
            const hasPendingTask = pendingTaskOwnerIDs.has(message.info.id)
            // 当前 owner 只有确实还剩内部任务时才能重新入选；普通已完成用户仍由 activeTurnUserIDs 防止重复回复。
            if (excluded.has(message.info.id) && !hasPendingTask) return false
            if (isManualSteerCandidate(message) && manualSteerTargetTurnID(message)) return false
            if (awaitingIDs.has(message.info.id) || hasPendingTask) return true
            return (
              !startedTaskOwnerIDs.has(message.info.id) &&
              message.parts.some((part) => part.type === "compaction" || part.type === "subtask")
            )
          })
        }
        const requestedRoot = input.activeRootMessageID
          ? initialMessages.find(
              (message) => message.info.role === "user" && message.info.id === input.activeRootMessageID,
            )
          : undefined
        const fallbackRoot =
          pendingTurnRoot(initialMessages) ??
          initialMessages.findLast(
            (message) =>
              message.info.role === "user" &&
              // marker 缺失的 steer 只是一条未完成提交；恢复 runner 时不能把它兜底成活动根并绕过 durable ACK。
              (!isManualSteerCandidate(message) || isManualSteerUser(message)),
          )
        const recoveredTargetTurnID = fallbackRoot ? manualSteerTargetTurnID(fallbackRoot) : undefined
        const initialRoot =
          requestedRoot ??
          // durable steer 恢复时仍以目标 root 固定回合配置和完成集合；只有旧 root 已被裁剪才回退到 steer 自身。
          (recoveredTargetTurnID
            ? (initialMessages.find(
                (message) => message.info.role === "user" && message.info.id === recoveredTargetTurnID,
              ) ?? fallbackRoot)
            : fallbackRoot)
        if (!initialRoot || initialRoot.info.role !== "user") {
          throw new Error("No user message found in stream. This should never happen.")
        }
        // runner 恢复时以消息中的持久化身份为准；旧历史再回退到 steer/continuation/自身 ID。
        let turnID = MessageV2.userTurnID(initialRoot.info)
        // 官方 turn/steer 不会改变活动回合的配置；把首条 root 用户消息作为整个回合的配置快照。
        let turnRoot = initialRoot.info
        // prompt 调度 runner 后、runner 首次读取消息前可能已有普通 noReply；逻辑回合始终只认实际启动它的根消息。
        const activeTurnUserIDs = new Set<MessageID>([initialRoot.info.id])
        const registered = yield* turnLock(sessionID).withPermits(1)(
          Effect.sync(() => {
            const scheduled = scheduledTurns.get(sessionID)
            // 旧代次 runner 迟到登记时不能删除同 turnID 的新 pending 身份；删除必须同时匹配取消代次。
            if (scheduled?.id === turnID && scheduled.cancelEpoch === input.cancelEpoch)
              scheduledTurns.delete(sessionID)
            // cancel 可能发生在 replyPrepared 的早期检查之后、runner 真正登记之前；代次失效时禁止旧 fiber 复活回合。
            if (replyCancelled(sessionID, input.cancelEpoch)) return false
            activeTurns.set(sessionID, {
              id: turnID,
              rootMessageID: initialRoot.info.id,
              runID: input.runID,
              steerEpoch: 0,
              cancelEpoch: input.cancelEpoch,
            })
            // 独立保存 runner→turn 归属，直到该 runner 的失败结算和清理全部完成。
            turnByRunID.set(input.runID, { sessionID, turnID })
            return true
          }),
        )
        if (!registered) return initialRoot

        while (true) {
          yield* status.set(sessionID, { type: "busy", turnID })
          yield* slog.info("loop", { step })

          // 先在 turn 锁内取得本轮消息快照对应的 steer 代次；ACK 若随后到达，会推进代次并中止旧采样。
          const stepSteerEpoch = yield* turnLock(sessionID).withPermits(1)(
            Effect.sync(() => {
              const active = activeTurns.get(sessionID)
              if (active?.runID !== input.runID || active.id !== turnID) return
              return active.steerEpoch
            }),
          )
          if (stepSteerEpoch === undefined) break

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
          const awaitingUsers = awaitingInstructionUsers(msgs)
          // 普通 continuation、compaction 和 subtask 用户本来就属于当前 turn；只有 manual steer 需要等采样证据，
          // 否则会把尚未送入模型的引导误当成已完成。这个分流保留内部步骤的原有执行语义。
          msgs
            .filter(
              (message) =>
                message.info.role === "user" &&
                MessageV2.userTurnID(message.info) === turnID &&
                !isManualSteerCandidate(message),
            )
            .forEach((message) => activeTurnUserIDs.add(message.info.id))
          // 兼容旧数据库里没有 target marker 的 steer：它只可能来自已经启动的 runner，仍按旧协议归入当前 turn。
          // 新协议的 steer 总会带权威 targetTurnID，因此不会走这个分支，也就不会重新引入提前吞消息的竞态。
          awaitingUsers
            .filter((message) => isManualSteerCandidate(message) && manualSteerTargetTurnID(message) === undefined)
            .forEach((message) => activeTurnUserIDs.add(message.info.id))

          const currentAssistantMessages = msgs.filter(
            (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } => {
              if (message.info.role !== "assistant") return false
              // 新消息按显式回合身份恢复；旧历史仍沿用 parentID，避免升级后丢失在途工具步骤。
              const parentID: MessageID = message.info.parentID
              return (
                message.info.turnID === turnID ||
                (message.info.turnID === undefined &&
                  (activeTurnUserIDs.has(parentID) ||
                    msgs.some(
                      (candidate) =>
                        candidate.info.role === "user" &&
                        candidate.info.id === parentID &&
                        MessageV2.userTurnID(candidate.info) === turnID,
                    )))
              )
            },
          )
          // 只有已有 assistant 明确以某个 user 为 parent，或显式完成列表点名该 user，才能证明它已经被模型采样。
          // 不能按 turnID 把尚未采样的 steer 预先放进完成集合，否则终态 assistant 会吞掉引导而不再生成后续回复。
          currentAssistantMessages.forEach((message) => {
            const parent = msgs.find((candidate) => candidate.info.id === message.info.parentID)
            if (parent?.info.role === "user") activeTurnUserIDs.add(parent.info.id)
            message.info.completedUserMessageIDs?.forEach((messageID) => {
              const completedUser = msgs.find(
                (candidate) => candidate.info.role === "user" && candidate.info.id === messageID,
              )
              if (completedUser?.info.role === "user" && MessageV2.userTurnID(completedUser.info) === turnID)
                activeTurnUserIDs.add(completedUser.info.id)
            })
          })
          const lastAssistantMsg = currentAssistantMessages.at(-1)
          const lastAssistant = lastAssistantMsg?.info
          // 预检压缩要读取完整历史中的最近终态；只查当前 turn 会漏掉上一回合的高 token 用量。
          const lastFinished = msgs.findLast(
            (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
              message.info.role === "assistant" && !!message.info.finish,
          )?.info
          const imageGenerationEnded = assistantImageGenerationEnded(lastAssistantMsg)
          // 直接生图成功会补正文，失败会写 assistant error；两者都已是终态，其他工具仍保持正常回灌。
          const currentStepHasToolCalls =
            !imageGenerationEnded && (lastAssistantMsg ? assistantHasToolCall(lastAssistantMsg) : false)
          const lengthWillContinue = lastAssistant?.finish === "length" && lengthContinuationCount < 5
          const completed = completedInstructionUserIDs(msgs)
          const pendingCurrentSteers = awaitingUsers.filter(
            (message) =>
              isManualSteerUser(message) &&
              manualSteerTargetTurnID(message) === turnID &&
              !completed.has(message.info.id),
          )
          // 同一 owner 的后续内部任务必须在关闭回合前执行；否则终态父回复会让 transition 原地重复选中该 owner。
          const pendingCurrentTasks = pendingInternalTasks(msgs).filter((task) =>
            activeTurnUserIDs.has(task.owner.id),
          )

          if (
            !lengthWillContinue &&
            !currentStepHasToolCalls &&
            pendingCurrentSteers.length === 0 &&
            pendingCurrentTasks.length === 0 &&
            [...activeTurnUserIDs].every((messageID) => completed.has(messageID))
          ) {
            const transition = yield* turnLock(sessionID).withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* MessageV2.filterCompactedEffect(sessionID)
                const latestCompleted = completedInstructionUserIDs(latest)
                const acceptedSteers = awaitingInstructionUsers(latest).filter(
                  (message) =>
                    isManualSteerUser(message) &&
                    manualSteerTargetTurnID(message) === turnID &&
                    !latestCompleted.has(message.info.id),
                )
                if (acceptedSteers.length > 0) {
                  // ACK 与关闭竞争时只保持当前 turn；steer 要到真正创建下一条 assistant 前才进入完成集合。
                  return "current" as const
                }

                const next = pendingTurnRoot(latest, activeTurnUserIDs)
                if (next && next.info.role === "user") {
                  activeTurnUserIDs.clear()
                  activeTurnUserIDs.add(next.info.id)
                  // 普通队列使用自身 turnID 开启新回合，内部续跑则沿用已持久化的原回合。
                  turnID = MessageV2.userTurnID(next.info)
                  // 只有真正切换到普通新回合时才更新配置快照，steer 永远不会走到这里。
                  turnRoot = next.info
                  activeTurns.set(sessionID, {
                    id: turnID,
                    rootMessageID: next.info.id,
                    runID: input.runID,
                    steerEpoch: 0,
                    // 同一 runner 内切换普通队列仍属于本次 work 的取消代次，旧停止不得跨代次命中它。
                    cancelEpoch: input.cancelEpoch,
                  })
                  // 同一 runner 接着处理普通排队回合时，失败归属也必须前移到新 turn，不能继续指向初始根消息。
                  turnByRunID.set(input.runID, { sessionID, turnID })
                  return "next" as const
                }

                const active = activeTurns.get(sessionID)
                if (active?.runID === input.runID) activeTurns.delete(sessionID)
                return "closed" as const
              }),
            )
            if (transition === "closed") {
              yield* slog.info("exiting loop")
              break
            }
            continue
          }

          // 只有 marker 完整落库的 steer 才能进入模型；candidate 仅用于阻止半条消息被普通流程提前完成。
          const currentTurnSteers = pendingCurrentSteers
          const currentTurnSteerIDs = new Set(currentTurnSteers.map((message) => message.info.id))
          // 当前回合的 pending steer 必须留在本次模型上下文候选中；普通队列仍在这里被延后，避免抢占 steer。
          const turnAwaitingUsers = awaitingUsers.filter(
            (message) => activeTurnUserIDs.has(message.info.id) || currentTurnSteerIDs.has(message.info.id),
          )
          const startedTaskOwnerIDs = new Set(
            msgs.flatMap((message) =>
              message.info.role === "assistant" &&
              message.info.parentID &&
              !isStandaloneInternalTaskAssistant(message)
                ? [message.info.parentID]
              : [],
            ),
          )
          // 只调度尚未被精确完成记录认领的内部任务，避免恢复时重复执行已经落库的 task 结果。
          const continuationOwnerIDs = internalContinuationOwnerIDs(msgs)
          const tasks = pendingCurrentTasks.filter((task) => !continuationOwnerIDs.has(task.owner.id))
          const deferredUserIDs = new Set([
            ...awaitingUsers
              .filter((message) => !activeTurnUserIDs.has(message.info.id) && !currentTurnSteerIDs.has(message.info.id))
              .map((message) => message.info.id),
            ...msgs.flatMap((message) =>
              message.info.role === "user" &&
              !startedTaskOwnerIDs.has(message.info.id) &&
              !activeTurnUserIDs.has(message.info.id) &&
              message.parts.some((part) => part.type === "compaction" || part.type === "subtask")
                ? [message.info.id]
                : [],
            ),
          ])
          // 压缩会主动排除普通队列；把最早的 deferred 消息作为保留锚点，避免摘要完成后被历史截断永久丢失。
          const preserveTailStartID = msgs.find((message) => deferredUserIDs.has(message.info.id))?.info.id
          msgs = msgs.filter((message) => !deferredUserIDs.has(message.info.id))

          let lastUser = msgs.findLast(
            (message): message is MessageV2.WithParts & { info: MessageV2.User } =>
              message.info.role === "user" && activeTurnUserIDs.has(message.info.id),
          )?.info
          if (!lastUser) throw new Error("No active user message found in stream. This should never happen.")
          // 后续分支会按引导切换 lastUser；这里固定本轮结束判断使用的用户，保持类型收窄稳定。
          const latestUser = lastUser

          // Some providers return "stop" even when the assistant message contains tool calls.
          // Keep the loop running so tool results can be sent back to the model.
          // Skip provider-executed tool parts — those were fully handled within the
          // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
          const hasToolCalls = currentStepHasToolCalls

          // 结束判断同样基于消息在历史中的位置，避免自定义 messageID 让已经完成的回合再次调用模型。
          const lastUserIndex = msgs.findIndex((msg) => msg.info.role === "user" && msg.info.id === latestUser.id)
          const lastAssistantIndex = lastAssistant
            ? msgs.findIndex((msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id)
            : -1
          const shouldExit =
            !!lastAssistant?.finish &&
            lastAssistant.finish !== "tool-calls" &&
            !hasToolCalls &&
            lastAssistantIndex > lastUserIndex &&
            turnAwaitingUsers.length === 0 &&
            // 终态 assistant 后仍有内部任务时，必须先执行任务，不能提前跳过到下一轮退出判断。
            pendingCurrentTasks.length === 0

          if (shouldExit) {
            if (lastAssistant?.finish === "length" && lengthContinuationCount < 5) {
              lengthContinuationCount++
            } else {
              // 下一轮顶部会在 turnLock 内完成“接收迟到引导 / 关闭当前回合 / 切换普通队列”的唯一决策。
              continue
            }
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: turnRoot.model.modelID,
              providerID: turnRoot.model.providerID,
              history: msgs,
            }).pipe(
              Effect.catchCause((cause) => elog.error("title generation failed", { error: Cause.squash(cause) })),
              Effect.forkIn(scope),
            )

          const pendingTask = tasks[0]
          const task = pendingTask?.part
          const taskOwner = pendingTask?.owner
          const taskOwnerIndex = taskOwner ? msgs.findIndex((message) => message.info.id === taskOwner.id) : -1
          const firstPendingSteer = msgs.find((message) => currentTurnSteerIDs.has(message.info.id))
          if (task?.type === "compaction" && firstPendingSteer) {
            const currentAnchorIndex = task.tail_start_id
              ? msgs.findIndex((message) => message.info.id === task.tail_start_id)
              : -1
            const steerIndex = msgs.findIndex((message) => message.info.id === firstPendingSteer.info.id)
            if (currentAnchorIndex === -1 || steerIndex < currentAnchorIndex) {
              // steer 属于 turn-local pending input，不能写进摘要；同时锚定物理消息，避免摘要完成后被裁剪掉。
              task.tail_start_id = firstPendingSteer.info.id
              yield* sessions.updatePart(task)
            }
          }
          // 子任务和压缩只看到原步骤历史；尚未采样的 steer 无论落在 owner 前后都继续留在 pending 队列。
          const taskMessages = (taskOwnerIndex === -1 ? msgs : msgs.slice(0, taskOwnerIndex + 1)).filter(
            (message) => !currentTurnSteerIDs.has(message.info.id),
          )
          const modelUser = taskOwner ?? turnRoot
          // 内部任务沿用其 owner 的模型；后续正常采样仍会按本轮最后一条用户消息重新解析模型。
          const taskModel = yield* getModel(modelUser.model.providerID, modelUser.model.modelID, sessionID)

          if (task?.type === "subtask" && taskOwner) {
            // steer 不会取消正在运行的子任务；子任务自然收尾后，下一轮读取 durable 引导。
            activeTurnUserIDs.add(taskOwner.id)
            yield* handleSubtask({
              task,
              model: taskModel,
              lastUser: taskOwner,
              sessionID,
              session,
              msgs: taskMessages,
              automationID: taskOwner.automationID ?? turnRoot.automationID,
            })
            continue
          }

          if (task?.type === "compaction" && taskOwner) {
            // 压缩同样属于当前步骤；等待它完成后再把引导注入下一次模型请求，避免损坏摘要状态。
            activeTurnUserIDs.add(taskOwner.id)
            const previousStep = taskMessages.findLast(
              (message) => message.info.role === "assistant" && message.info.summary !== true,
            )
            const needsOldContinuation =
              task.overflow === true ||
              (previousStep?.info.role === "assistant" &&
                !assistantImageGenerationEnded(previousStep) &&
                (assistantHasToolCall(previousStep) || ["tool-calls", "length"].includes(previousStep.info.finish ?? "")))
            yield* compaction.process({
              messages: taskMessages,
              parentID: taskOwner.id,
              sessionID,
              // 旧工具/长度步骤仍需先续跑；只有 steer 需要 follow-up 时才在摘要后直接 drain steer。
              auto: task.auto && (needsOldContinuation || currentTurnSteers.length === 0),
              overflow: task.overflow,
            })
            // 压缩任务无论返回 stop 还是 continue 都已完成本轮处理，统一回到循环顶部读取最新消息。
            continue
          }

          // 手动引导与普通排队必须分流：
          // - steer 属于当前 active turn，工具结果返回后的下一次模型决策必须立即看到它，但仍沿用 root 模型；
          // - 普通 noReply/目标续跑仍保持旧语义，在途任务完成后再处理，避免影响无人值守队列。
          const completedAt = lastAssistant?.time.completed
          const awaitingAfterAssistantCompleted =
            typeof completedAt === "number" &&
            turnAwaitingUsers.some((message) => message.info.time.created >= completedAt)
          const continuingTask =
            !!lastAssistant && !lastAssistant.error && hasToolCalls && !awaitingAfterAssistantCompleted
          const manualSteers = turnAwaitingUsers.filter(isManualSteerUser)
          const latestManualSteer = manualSteers.at(-1)
          const postCompactionContinuation =
            lastAssistant?.summary === true
              ? msgs.find(
                  (message) =>
                    !isManualSteerCandidate(message) &&
                    message.info.role === "user" &&
                    message.info.continuationTurnID === turnID &&
                    msgs.findIndex((candidate) => candidate.info.id === message.info.id) > lastAssistantIndex,
                )
              : undefined
          if (postCompactionContinuation) {
            // 官方在旧工具/失败步骤需要续跑时先恢复原步骤；pending steer 要等这次模型请求结束后再 drain。
            lastUser = postCompactionContinuation.info as MessageV2.User
            msgs = msgs.filter((message) => !currentTurnSteerIDs.has(message.info.id))
          } else if (latestManualSteer) {
            // assistant parent 推进到最新 steer，既让前端顺序锁正确释放，也让终态 high-water 覆盖此前连续引导。
            lastUser = latestManualSteer.info as MessageV2.User
            // 普通 noReply/目标消息继续留在数据库队列里，但不能提前混进当前 steer 的模型上下文。
            const deferred = new Set(
              turnAwaitingUsers
                .filter(
                  (message) =>
                    !activeTurnUserIDs.has(message.info.id) && !currentTurnSteerIDs.has(message.info.id),
                )
                .map((message) => message.info.id),
            )
            msgs = msgs.filter((message) => !deferred.has(message.info.id))
          } else if (continuingTask && lastAssistant && lastAssistant.parentID) {
            const pid = lastAssistant.parentID
            const initiator = msgs.find((m) => m.info.role === "user" && m.info.id === pid)?.info as
              | MessageV2.User
              | undefined
            if (initiator && initiator.id !== lastUser.id) {
              lastUser = initiator
              const initiatorIndex = msgs.findIndex((m) => m.info.role === "user" && m.info.id === initiator.id)
              const deferred = new Set(
                turnAwaitingUsers
                  .filter((message) => msgs.findIndex((m) => m.info.id === message.info.id) > initiatorIndex)
                  .map((message) => message.info.id),
              )
              msgs = msgs.filter((m) => !deferred.has(m.info.id))
            }
          } else if (!continuingTask && turnAwaitingUsers.length > 0) {
            const newest = turnAwaitingUsers[turnAwaitingUsers.length - 1]
            if (newest.info.id !== lastUser.id) {
              lastUser = newest.info as MessageV2.User
            }
            // steer 回复可能先于更早的普通队列完成；把仍待处理的用户消息移到模型历史末尾，恢复真实执行顺序。
            const pendingIDs = new Set(turnAwaitingUsers.map((message) => message.info.id))
            msgs = [...msgs.filter((message) => !pendingIDs.has(message.info.id)), ...turnAwaitingUsers]
            if (turnAwaitingUsers.length > 1) {
              for (const p of newest.parts) {
                if (p.type === "text" && !p.ignored && !p.synthetic && p.text.trim().length > 0) {
                  p.text = [
                    p.text,
                    "",
                    "<system-reminder>The user sent multiple messages in a row; address all of them together in this single response.</system-reminder>",
                  ].join("\n")
                  break
                }
              }
            }
          }

          let model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)

          if (lastFinished && lastFinished.summary !== true) {
            // 是否主动压缩统一交给 compaction.shouldCompact 判断：始终按当前 msgs 实际体积预估兜底
            // （上游 usage 缺失/失真时也能触发，否则上下文会一路撑到模型上限数倍），
            // 同模型时再用上一轮 usage 自报值在 estimate 之外更早/更准触发。
            // 官方在 compaction 决策时尚未 drain turn-local pending input；未采样 steer 不能参与本轮历史快照。
            const compactionMessages = msgs.filter((message) => !currentTurnSteerIDs.has(message.info.id))
            const overflowed = yield* compaction.shouldCompact({ lastFinished, messages: compactionMessages, model })
            if (overflowed) {
              // 当前真实用户消息已经参与本次体积判断；压缩后要走 overflow replay，
              // 重新入队这条请求，避免只看到内部 synthetic continue 而误判“没有下一步”。
              yield* compaction.create({
                sessionID,
                agent: turnRoot.agent,
                model: turnRoot.model,
                auto: true,
                // 未采样 steer 自身就是压缩后的 pending input，不需要复制成 overflow replay。
                overflow: latestManualSteer ? false : true,
                continuationTurnID: turnID,
                preserveTailStartID,
              })
              continue
            }
          }

          const agent = yield* agents.get(turnRoot.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${turnRoot.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* insertReminders({
            messages: msgs,
            agent,
            session,
            automationID: turnRoot.automationID,
            turnRoot,
          })
          msgs = yield* insertPluginCapabilities({ messages: msgs })

          const internalContinuation =
            continuingTask || (shouldExit && lastAssistant?.finish === "length" && lengthContinuationCount <= 5)
          if (!internalContinuation && pendingCurrentTasks.length === 0) {
            const refreshed = yield* MessageV2.filterCompactedEffect(sessionID)
            if (completedInstructionUserIDs(refreshed).has(lastUser.id)) {
              // runner 的旧快照与 assistant 落库之间可能有另一条回复推进完成水位；回到顶部原子切换 turn。
              yield* slog.info("skipping user already covered by terminal assistant", { userMessageID: lastUser.id })
              continue
            }
          }

          // 只在真正创建 assistant、即将采样前登记模型实际看到的待处理用户，避免预处理阶段被 steer 时误吞队列。
          const sampledMessageIDs = new Set(msgs.map((message) => message.info.id))
          turnAwaitingUsers.forEach((message) => {
            if (sampledMessageIDs.has(message.info.id)) activeTurnUserIDs.add(message.info.id)
          })
          activeTurnUserIDs.add(lastUser.id)
          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            // 同一活动回合可包含多次 steer；assistant 始终记录固定 turnID，不随 parentID 推进而改变归组。
            turnID,
            mode: agent.name,
            agent: agent.name,
            // 引导只推进 parent，不改变活动 turn 在 root 固定的模型变体。
            variant: turnRoot.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            // 新 runner 从创建时就禁用旧位置水位；最终步骤收尾时再覆盖为真实完成的用户消息集合。
            completedUserMessageIDs: [],
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)
          const handle = yield* processor.create({
            assistantMessage: msg,
            sessionID,
            model,
            // processor 内部还会读取 user.system/language；这些配置必须固定为当前 turn root。
            user: turnRoot,
          })
          const approvalConfig = yield* config.getGlobal()
          const reviewer = ApprovalReviewer.make({
            state: approvalState,
            provider,
            model,
            messages: msgs,
            directory: ctx.directory,
            worktree: ctx.worktree,
            fallbackToMainModel: ApprovalReviewer.resolveMainModelFallback(
              approvalConfig.approval_review_fallback_to_main_model,
            ),
          })

          const execution: Effect.Effect<"break" | "continue"> = Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

            const tools = yield* resolveTools({
              agent,
              session,
              model,
              tools: turnRoot.tools,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              automationID: turnRoot.automationID,
              turnRoot,
              language: turnRoot.language,
              translateContent: turnRoot.translateContent,
            })

            if (turnRoot.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: turnRoot.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const format = turnRoot.format ?? { type: "text" as const }
            const selectedImageModel = isImageGenerationModel(model)
            const wantsImageGeneration =
              selectedImageModel || !!turnRoot.imageGeneration || shouldForceImageGenerationTool(msgs, lastUser.id)
            if (
              format.type !== "json_schema" &&
              wantsImageGeneration &&
              model.providerID === wanlaiCodeProviderID &&
              (yield* handleDirectImageGeneration({
                handle,
                tools,
                messages: msgs,
                lastUser,
                model,
                imageGeneration: turnRoot.imageGeneration,
              }))
            ) {
              // 下一轮先用持久化终态判断退出；若期间已有普通输入或 task 入队，则继续处理而不是遗留。
              return "continue" as const
            }

            const [skills, env, instructions, memories, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              memoryBlock({ messages: msgs, session, lastUser }),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const system = [...env, ...instructions, ...(memories ? [memories] : []), ...(skills ? [skills] : [])]
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const forceImageGeneration = !!tools.image_generation && wantsImageGeneration
            if (forceImageGeneration) {
              system.push(
                [
                  "The latest user message is an image generation or image editing request.",
                  "You must call the image_generation tool in this same turn. Do not answer with normal chat text.",
                  "If the user request is vague, resolve the concrete image prompt from the recent conversation before calling the tool.",
                  "Include the relevant previous assistant/user content, numbering, labels, answers, layout/style requirements, and uploaded image references in the tool prompt or context_text.",
                ].join("\n"),
              )
            }
            const toolChoice =
              format.type === "json_schema"
                ? ("required" as const)
                : forceImageGeneration
                  ? { type: "tool" as const, toolName: "image_generation" }
                  : undefined
            const stepController = new AbortController()
            const staleStep = yield* turnLock(sessionID).withPermits(1)(
              Effect.sync(() => {
                const active = activeTurns.get(sessionID)
                if (
                  active?.runID !== input.runID ||
                  active.id !== turnID ||
                  active.steerEpoch !== stepSteerEpoch
                )
                  return true
                activeSteps.set(sessionID, {
                  turnID,
                  runID: input.runID,
                  steerEpoch: stepSteerEpoch,
                  controller: stepController,
                  // 工具 part 一旦进入 pending/running 就不再中止，避免引导把真实文件写入或命令执行标成失败。
                  interruptible: () => handle.steerInterruptible !== false,
                })
                return false
              }),
            )
            if (staleStep) stepController.abort()

            const result = yield* handle
              .process({
                // handle/LLM 读取的用户配置也固定在 turn root；最新 steer 只贡献可见文本和 parent。
                user: turnRoot,
                agent,
                permission: session.permission,
                sessionID,
                parentSessionID: session.parentID,
                system,
                messages: [
                  ...modelMsgs,
                  ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : []),
                  ...(shouldExit && lastAssistant?.finish === "length" && !isLastStep
                    ? [{ role: "user" as const, content: "请继续你刚才未完成的回复。" }]
                    : []),
                ],
                tools,
                model,
                toolChoice,
                stepAbortSignal: stepController.signal,
              })
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    // 只清理自己登记的控制器，防止迟到收尾删除同一会话后来启动的新步骤。
                    if (activeSteps.get(sessionID)?.controller === stepController) activeSteps.delete(sessionID)
                  }),
                ),
              )

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              if (format.type === "json_schema") {
                handle.message.error = new MessageV2.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") {
              const responseComplete = MessageV2.parts(handle.message.id).some(
                (part) =>
                  part.type === "tool" &&
                  part.tool === "image_generation" &&
                  "metadata" in part.state &&
                  part.state.metadata?.responseComplete === true,
              )
              // 生图工具已经完成最终交付时回到循环顶端，以便处理同一快照里被延期的后续工作。
              return responseComplete ? ("continue" as const) : ("break" as const)
            }
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: turnRoot.agent,
                model: turnRoot.model,
                auto: true,
                overflow: !handle.message.finish,
                continuationTurnID: turnID,
                preserveTailStartID,
              })
            }
            return "continue" as const
          }).pipe(
            // 自动审批必须覆盖同一 turn 内的每次模型执行，包括 steer 触发的后续 assistant。
            ApprovalReviewer.provideContext({
              mode: PermissionMode.resolve(approvalConfig.permission_mode),
              reviewer,
            }),
            Effect.ensuring(instruction.clear(handle.message.id)),
          )
          const result = yield* execution
          if (assistantCompletesInstruction(handle.message)) {
            // 所有逻辑回合都写精确完成集合；否则更早的普通队列会被 assistant 的位置 high-water 误吞。
            handle.message.completedUserMessageIDs = [...activeTurnUserIDs]
            yield* sessions.updateMessage(handle.message)
          }
          if (result === "break") {
            // 终态统一回到循环顶部，由 turnLock 决定接收迟到引导还是关闭并切换普通队列。
            if (assistantTerminal(handle.message)) continue
            const close = yield* turnLock(sessionID).withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* MessageV2.filterCompactedEffect(sessionID)
                const pending = awaitingInstructionUsers(latest).filter(
                  (message) => isManualSteerUser(message) && manualSteerTargetTurnID(message) === turnID,
                )
                if (pending.length > 0) {
                  // 保持接收窗口即可；pending steer 不能在下一条 assistant 创建前进入精确完成集合。
                  return false
                }
                const active = activeTurns.get(sessionID)
                if (active?.runID === input.runID) activeTurns.delete(sessionID)
                return true
              }),
            )
            if (close) break
          }
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        yield* suggestion({ sessionID }).pipe(
          Effect.catchCause((cause) => elog.warn("suggestion generation failed", { error: Cause.squash(cause) })),
          Effect.forkIn(scope),
        )
        return yield* lastAssistant(sessionID)
      },
    )

    const joinLoop: (
      input: LoopInput & { activeRootMessageID?: MessageID; cancelEpoch: number; failureGeneration?: number },
    ) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.joinLoop")(function* (
      input: LoopInput & { activeRootMessageID?: MessageID; cancelEpoch: number; failureGeneration?: number },
    ) {
      const baseline = yield* Deferred.make<number>()
      const runID = MessageID.ascending()
      // 水位只能由真正启动的新 runner 在 work 内采集；并发 waiter 加入旧 runner 时不能借用旧回复冒充本轮结果。
      const work = Effect.uninterruptible(
        sessions.messageHighWater(input.sessionID).pipe(
          // 这里只登记序号水位；读取完整消息会把历史 summary patch 无谓复制进主进程。
          Effect.flatMap((sequence) => Deferred.succeed(baseline, sequence)),
        ),
      ).pipe(
        Effect.andThen(
          runLoop({
            sessionID: input.sessionID,
            runID,
            cancelEpoch: input.cancelEpoch,
            activeRootMessageID: input.activeRootMessageID,
          }),
        ),
        Effect.tapCause((cause) =>
          reportPromptFailure({
            sessionID: input.sessionID,
            cause,
            cancelEpoch: input.cancelEpoch,
            generation: input.failureGeneration,
            runID,
            activeRootMessageID: input.activeRootMessageID,
          }),
        ),
        Effect.ensuring(
          turnLock(input.sessionID).withPermits(1)(
            Effect.sync(() => {
              // 异常或中断也必须撤销本 runner 的接收窗口；runID 防止迟到清理误删后来启动的新回合。
              if (activeTurns.get(input.sessionID)?.runID === runID) activeTurns.delete(input.sessionID)
              if (activeSteps.get(input.sessionID)?.runID === runID) activeSteps.delete(input.sessionID)
              const ownedTurn = turnByRunID.get(runID)
              // 迟到清理只能删除当前 runner 自己登记的归属，不能碰同会话后来启动的新回合。
              if (ownedTurn?.sessionID === input.sessionID) turnByRunID.delete(runID)
            }),
          ),
        ),
      )
      // 纯中断只能返回本 runner 新建的 assistant；其他错误由真正执行 work 的 runID 结算，禁止静默二次执行。
      return yield* state
        .ensureRunning(
          input.sessionID,
          Deferred.await(baseline).pipe(
            Effect.flatMap((sequence) => finalizeInterrupted(input.sessionID, sequence)),
          ),
          work,
        )
        .pipe(
          Effect.tapCause(() =>
            Effect.sync(() => {
              // 共享 runner 的所有 waiter 都会收到同一失败；实际 work 已经发布终态，其余代次只标记已处理。
              markReplyFailureHandled(input.sessionID, input.failureGeneration)
            }),
          ),
        )
    })

    const loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      const reply = yield* promptLock(input.sessionID).withPermits(1)(
        Effect.sync(() => {
          // epoch 与 generation 共用同一个线性化点；排在 stop 后的 loop 必须继承新 epoch，不能被旧快照吞掉。
          return {
            cancelEpoch: cancelEpoch(input.sessionID),
            generation: beginReplyGeneration(input.sessionID),
          }
        }),
      )
      return yield* joinLoop({
        ...input,
        cancelEpoch: reply.cancelEpoch,
        failureGeneration: reply.generation,
      }).pipe(
        // 公开 loop 没有 prompt waiter 外壳，必须在自己的最外层释放代次。
        Effect.ensuring(Effect.sync(() => finishReplyGeneration(input.sessionID, reply.generation))),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
      function* (input: ShellInput) {
        // shell 成为新的会话活动后，上一回复 generation 的迟到错误不得再覆盖当前界面。
        yield* promptLock(input.sessionID).withPermits(1)(
          Effect.sync(() => replyGenerations.invalidate(input.sessionID)),
        )
        const ready = yield* Latch.make()
        return yield* state.startShell(input.sessionID, finalizeInterrupted(input.sessionID), shellImpl(input, ready), ready)
      },
    )

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* lastModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = yield* agents.get(agentName)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const skillInfo =
        cmd.source === "skill"
          ? {
              name: input.command,
              location: cmd.location,
            }
          : undefined
      const userVisibleParts =
        skillInfo && !isSubtask
          ? templateParts.map((part) =>
              part.type === "text"
                ? {
                    ...part,
                    metadata: {
                      ...part.metadata,
                      // 前端用这段元数据把大段 SKILL.md 折叠成 Codex 风格的可点击 skill chip。
                      skill: {
                        name: skillInfo.name,
                        ...(skillInfo.location ? { location: skillInfo.location } : {}),
                        ...(input.arguments.trim() ? { arguments: input.arguments.trim() } : {}),
                      },
                    },
                  }
                : part,
            )
          : templateParts
      const originalInputParts = input.parts ?? []
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...userVisibleParts, ...originalInputParts]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* lastModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      promptAsync,
      steer,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
      ),
    ),
  ),
)
const ModelRef = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(MessageV2.Format),
  system: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  translateContent: Schema.optional(Schema.Boolean),
  imageGeneration: Schema.optional(
    Schema.Struct({
      count: Schema.optional(
        Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(8)),
      ),
      size: Schema.optional(Schema.String),
      output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
      failure_prefix: Schema.optional(Schema.String),
      loading_text: Schema.optional(Schema.String),
      error_messages: Schema.optional(ErrorMessageMapSchema),
    }),
  ),
  variant: Schema.optional(Schema.String),
  // 远控层只传入不可逆摘要，用于桌面重启后定位同一次手机请求；原始请求 ID 不进入会话内容。
  remoteRequestKey: Schema.optional(Schema.String),
  // 手机消息 UUID 需要和用户消息一起落库，供历史恢复及多端实时去重使用。
  remoteClientMessageID: Schema.optional(Schema.String),
  // 自动化注入触发:标记本条用户消息来源的自动化 ID(前端显示「通过自动化发送」)
  automationID: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      MessageV2.TextPartInput,
      MessageV2.FilePartInput,
      MessageV2.AgentPartInput,
      MessageV2.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export const SteerInput = Schema.Struct({
  ...Struct.omit(PromptInput.fields, ["noReply"]),
  // 与 ChatGPT 的 expectedTurnId 一致：服务端只把引导接收到这个仍在运行的逻辑回合。
  targetTurnID: MessageID,
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const SteerAck = Schema.Struct({
  // ACK 只有在用户消息和全部 parts 完整落库后返回；客户端可据此串行发送下一条引导。
  messageID: MessageID,
  targetTurnID: MessageID,
})

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {
  static readonly zod = zod(this)
}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(MessageV2.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
