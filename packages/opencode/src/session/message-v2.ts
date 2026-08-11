import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "../sync"
import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import * as ProviderError from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { ErrorMessageMapSchema } from "@opencode-ai/core/error/message-map"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Option, Schema, Types } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { zod, ZodOverride } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { namedSchemaError } from "@/util/named-schema-error"
import * as EffectLogger from "@opencode-ai/core/effect/logger"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
// 对齐官方 Codex 的模型可见中断边界：否则无正文的 aborted assistant 被过滤后，停止前引导会与下一问合并。
const TURN_ABORTED_PROMPT = `<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
</turn_aborted>`
export { isMedia }

export const OutputLengthError = namedSchemaError("MessageOutputLengthError", {})
export const AbortedError = namedSchemaError("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = namedSchemaError("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const AuthError = namedSchemaError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})
export const APIError = namedSchemaError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = z.infer<typeof APIError.Schema>
export const ContextOverflowError = namedSchemaError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {
  static readonly zod = zod(this)
}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {
  static readonly zod = zod(this)
}

const _Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export const Format = Object.assign(_Format, { zod: zod(_Format) })
export type OutputFormat = Schema.Schema.Type<typeof _Format>

const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
})
  .annotate({ identifier: "SnapshotPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
})
  .annotate({ identifier: "PatchPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  // 官方 Responses 用 phase 区分活动流进度与底部最终回复；持久化该字段后前端才能稳定按原位展示。
  phase: Schema.optional(Schema.Literals(["commentary", "final_answer"])),
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "TextPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  // 推理翻译启用时，text 为译文、originalText 保留原文供前端「显示原文」切换。
  // 独立字段而非塞进 metadata：metadata 会转成 ModelMessage 的 providerOptions，混入字符串会触发 schema 错。
  originalText: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
})
  .annotate({ identifier: "ReasoningPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: NonNegativeInt,
    end: NonNegativeInt,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
})
  .annotate({ identifier: "FileSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: LSP.Range,
  name: Schema.String,
  kind: NonNegativeInt,
})
  .annotate({ identifier: "SymbolSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
})
  .annotate({ identifier: "ResourceSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

const _FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})
export const FilePartSource = Object.assign(_FilePartSource, { zod: zod(_FilePartSource) })

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(_FilePartSource),
})
  .annotate({ identifier: "FilePart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
})
  .annotate({ identifier: "AgentPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
})
  .annotate({ identifier: "CompactionPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
})
  .annotate({ identifier: "SubtaskPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
})
  .annotate({ identifier: "RetryPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
})
  .annotate({ identifier: "StepStartPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(NonNegativeInt),
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  }),
})
  .annotate({ identifier: "StepFinishPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
})
  .annotate({ identifier: "ToolStatePending" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  attachments: Schema.optional(Schema.Array(FilePart)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
})
  .annotate({ identifier: "ToolStateRunning" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
})
  .annotate({ identifier: "ToolStateCompleted" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  title: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(FilePart)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
})
  .annotate({ identifier: "ToolStateError" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

const _ToolState = Schema.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
// Cast the derived zod so downstream z.infer sees the same mutable shape that
// our exported TS types expose (the pre-migration Zod inferences were mutable).
export const ToolState = Object.assign(_ToolState, {
  zod: zod(_ToolState) as unknown as z.ZodType<
    ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
  >,
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: _ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "ToolPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: SessionID,
}

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  // 逻辑回合的稳定身份；旧消息没有该字段时由执行层按历史字段回退推导。
  turnID: Schema.optional(MessageID),
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
  format: Schema.optional(_Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(Snapshot.FileDiff),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  translateContent: Schema.optional(Schema.Boolean),
  imageGeneration: Schema.optional(
    Schema.Struct({
      count: Schema.optional(NonNegativeInt),
      size: Schema.optional(Schema.String),
      output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
      failure_prefix: Schema.optional(Schema.String),
      loading_text: Schema.optional(Schema.String),
      // 图片生成错误文案由客户端按当前语言注入；会话消息要持久化它，
      // 否则图片模型直连路径重载后会退回网关英文错误。
      error_messages: Schema.optional(ErrorMessageMapSchema),
    }),
  ),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  // 手机请求幂等键随用户消息持久化，但不参与消息 ID 排序，也不会被发送给模型。
  remoteRequestKey: Schema.optional(Schema.String),
  // 保留手机生成的消息 UUID，Bridge 历史与实时回放据此和本地 optimistic 消息稳定去重。
  remoteClientMessageID: Schema.optional(Schema.String),
  // 由自动化触发注入的用户消息:记录来源自动化 ID,前端据此显示「通过自动化发送」
  automationID: Schema.optional(Schema.String),
  // 引导消息持久化它所绑定的逻辑回合；marker 未完整落库时也能识别并安全恢复同一次提交。
  steerTargetTurnID: Schema.optional(MessageID),
  // 压缩 replay/continue 等内部用户消息沿用原逻辑回合，不能在内部步骤之间更换引导目标。
  continuationTurnID: Schema.optional(MessageID),
})
  .annotate({ identifier: "UserMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

// 新消息优先使用持久化回合身份；旧历史继续兼容引导/压缩字段，最终退回自身 ID。
export function userTurnID(message: User): MessageID {
  return message.turnID ?? message.steerTargetTurnID ?? message.continuationTurnID ?? message.id
}

const _Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export const Part = Object.assign(_Part, {
  zod: zod(_Part) as unknown as z.ZodType<
    | TextPart
    | SubtaskPart
    | ReasoningPart
    | FilePart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | SnapshotPart
    | PatchPart
    | AgentPart
    | RetryPart
    | CompactionPart
  >,
})
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

// Zod discriminated union kept for the legacy Hono OpenAPI path.
const AssistantErrorZod = z.discriminatedUnion("name", [
  AuthError.Schema,
  NamedError.Unknown.Schema,
  OutputLengthError.Schema,
  AbortedError.Schema,
  StructuredOutputError.Schema,
  ContextOverflowError.Schema,
  APIError.Schema,
])
type AssistantError = z.infer<typeof AssistantErrorZod>

// Effect Schema for the same union — used by HttpApi OpenAPI generation.
const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  Schema.Struct({ name: Schema.Literal("UnknownError"), data: Schema.Struct({ message: Schema.String }) }).annotate({
    identifier: "UnknownError",
  }),
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })

// ── Prompt input schemas ─────────────────────────────────────────────────────
//
// Consumers of `SessionPrompt.PromptInput.parts` send part drafts without the
// ambient IDs (`messageID`, `sessionID`) that live on stored parts, and may
// omit `id` to let the server allocate one.  These Schema-Struct variants
// carry that shape, and `SessionPrompt.PromptInput` just references the
// derived `.zod` (no omit/partial gymnastics needed at the call site).

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  // 输入结构与持久化 TextPart 保持同一阶段契约，避免远控或 SDK 转发时丢掉官方 phase。
  phase: Schema.optional(Schema.Literals(["commentary", "final_answer"])),
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "TextPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(_FilePartSource),
})
  .annotate({ identifier: "FilePartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
})
  .annotate({ identifier: "AgentPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
})
  .annotate({ identifier: "SubtaskPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  // 助手与触发它的用户可能不是同一条消息，必须显式保存所属逻辑回合以支持刷新后归组。
  turnID: Schema.optional(MessageID),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  // steer 回复可能跨过普通排队消息；显式记录真正覆盖的用户消息，避免仅凭 parentID high-water 吞掉队列。
  completedUserMessageIDs: Schema.optional(Schema.Array(MessageID)),
  modelID: ModelID,
  providerID: ProviderID,
  /**
   * @deprecated
   */
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  // 记录本条回复实际覆盖到的普通用户消息；内部 task/compaction 的 parent 不能替代普通消息 high-water。
  instructionThrough: Schema.optional(MessageID),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(NonNegativeInt),
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
})
  .annotate({ identifier: "AssistantMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

const _Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export const Info = Object.assign(_Info, {
  zod: zod(_Info) as unknown as z.ZodType<User | Assistant>,
})
export type Info = User | Assistant

const UpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: _Info,
})

const RemovedEventSchema = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
})

const PartUpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  part: _Part,
  time: NonNegativeInt,
})

const PartRemovedEventSchema = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: PartID,
})

export const Event = {
  Updated: SyncEvent.define({
    type: "message.updated",
    version: 1,
    aggregate: "sessionID",
    schema: UpdatedEventSchema,
  }),
  Removed: SyncEvent.define({
    type: "message.removed",
    version: 1,
    aggregate: "sessionID",
    schema: RemovedEventSchema,
  }),
  PartUpdated: SyncEvent.define({
    type: "message.part.updated",
    version: 1,
    aggregate: "sessionID",
    schema: PartUpdatedEventSchema,
  }),
  PartDelta: BusEvent.define(
    "message.part.delta",
    Schema.Struct({
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
      field: Schema.String,
      delta: Schema.String,
    }),
  ),
  PartRemoved: SyncEvent.define({
    type: "message.part.removed",
    version: 1,
    aggregate: "sessionID",
    schema: PartRemovedEventSchema,
  }),
}

export const WithParts = Schema.Struct({
  info: _Info,
  parts: Schema.Array(_Part),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type WithParts = {
  info: Info
  parts: Part[]
}

export function visibleUserTextPart(part: Part) {
  if (part.type !== "text" || part.synthetic || part.ignored) return undefined
  const skill = part.metadata?.skill
  if (skill && typeof skill === "object" && !Array.isArray(skill)) {
    const argumentsText = (skill as Record<string, unknown>).arguments
    if (typeof argumentsText === "string") {
      const text = argumentsText.trim()
      if (text) return text
    }
  }
  const text = part.text.trim()
  return text || undefined
}

const Cursor = Schema.Union([
  Schema.Struct({
    id: MessageID,
    sequence: NonNegativeInt,
  }),
    // 兼容升级前已发给客户端的 time/id 游标；新游标只使用 first-seen sequence。
  Schema.Struct({
    id: MessageID,
    time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
])
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) => {
  // SQLite 的 JSON 列会抹掉 Schema.Class 原型；读回消息时恢复 format 实例，避免结构化输出消息被下发前的编码校验误丢弃。
  const formatValue = "format" in row.data ? row.data.format : undefined
  const format =
    formatValue === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(Format)(formatValue))
  return {
    ...row.data,
    ...(format === undefined ? {} : { format }),
    id: row.id,
    sessionID: row.session_id,
  } as Info
}

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) => {
  // sequence 是新协议的精确数组位置；旧 time/id 游标仅保留跨版本翻页能力。
  if ("sequence" in row) return lt(MessageTable.sequence, row.sequence)
  return or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))
}

const newer = (row: Cursor) => {
  // 远控历史与本地历史共用翻页入口；新 sequence 游标必须按真实写入顺序判断，不能退回 ID 字典序。
  if ("sequence" in row) return gt(MessageTable.sequence, row.sequence)
  return or(gt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), gt(MessageTable.id, row.id)))
}

const atOrOlder = (row: Cursor) => {
  // sequence 游标也用于远控历史的包含锚点查询，确保刷新时不会漏掉当前边界消息。
  if ("sequence" in row) return lte(MessageTable.sequence, row.sequence)
  return or(
    lt(MessageTable.time_created, row.time),
    and(eq(MessageTable.time_created, row.time), lte(MessageTable.id, row.id)),
  )
}

const log = Log.create({ service: "message" })

// 与 httpapi 边界 success schema(Schema.Array(WithParts)) 用同一编码判定：能编码即最终能下发。
const encodeMessageOption = Schema.encodeUnknownOption(WithParts)
const encodePartOption = Schema.encodeUnknownOption(Part)

// 已记录过损坏的 messageID，避免同一条坏消息被反复访问时刷屏（对齐 orphanCleanedSessions 思路）。
const loggedCorruption = new Set<string>()
function logCorruptionOnce(messageID: string, message: string, data: Record<string, unknown>) {
  if (loggedCorruption.has(messageID)) return
  loggedCorruption.add(messageID)
  log.error(message, data)
}

// 崩溃/进程重启中断流式写库，可能在 SQLite 里遗留不符合当前 schema 的 message/part（残缺的
// 工具/推理 part，或流式过程中被反复重写、写到一半的 assistant info）。下发时若整条
// Array(WithParts) 编码失败会导致整会话 500（表现为「消息加载失败」且重试永远失败、会话永久
// 打不开）。此函数保证返回值一定能编码（或丢弃整条），对齐 storage.ts 的 readOrQuarantine：
//   - 合法消息走快路径零改动
//   - 先丢弃不可编码的 part，保留其余；过滤后仍不可编码（info 等损坏）→ 整条丢弃，让会话仍能打开
// 仅接入 httpapi/classic 读端点（session.messages 服务方法、单条消息 handler），不进 runLoop
// 复用的 hydrate/stream 热路径。
export function sanitizeMessage(message: WithParts): WithParts | undefined {
  // sanitize 仅隔离 schema 损坏数据；合法推理即使内容重复也必须原样保留，不能在读取边界猜测重放。
  if (Option.isSome(encodeMessageOption(message))) return message
  const parts = message.parts.filter((part) => Option.isSome(encodePartOption(part)))
  const candidate: WithParts = { info: message.info, parts }
  if (Option.isNone(encodeMessageOption(candidate))) {
    logCorruptionOnce(message.info.id, "dropping unencodable message", {
      messageID: message.info.id,
      sessionID: message.info.sessionID,
    })
    return undefined
  }
  const dropped = message.parts.length - parts.length
  if (dropped > 0)
    logCorruptionOnce(message.info.id, "dropped unencodable message parts", {
      messageID: message.info.id,
      dropped,
      kept: parts.length,
    })
  return candidate
}

// 对一批消息做 salvage：逐条 sanitize，丢弃不可编码（返回 undefined）的整条消息。
export function sanitizeMessages(messages: WithParts[]): WithParts[] {
  return messages.map(sanitizeMessage).filter((message): message is WithParts => message !== undefined)
}

const COMPACT_MESSAGE_DIFF_THRESHOLD = 120
const COMPACT_MESSAGE_DIFF_PATCH_CHARS = 512 * 1024
const COMPACT_MESSAGE_DIFF_FILE_LIMIT = 500

export function compactSummaryDiffs(diffs: Snapshot.FileDiff[]): Snapshot.FileDiff[] {
  // 文件数少但单个 patch 很大时同样会阻塞主进程；数量与正文体积任一越界都只保留有限审核元数据。
  const patchChars = diffs.reduce(
    (total, item) => Math.min(COMPACT_MESSAGE_DIFF_PATCH_CHARS + 1, total + item.patch.length),
    0,
  )
  if (diffs.length <= COMPACT_MESSAGE_DIFF_THRESHOLD && patchChars <= COMPACT_MESSAGE_DIFF_PATCH_CHARS) return diffs
  // Solid keyed reconcile 面对近两万个文件会长期满核并占用数 GB；总文件数继续由 session.summary.files 提供。
  return diffs
    .slice(0, COMPACT_MESSAGE_DIFF_FILE_LIMIT)
    .map((item) => (item.patch ? { ...item, patch: "" } : item))
}

export function compactMessageSummaryDiffs(messages: WithParts[]): WithParts[] {
  // 长会话首屏只需要文件路径与增删计数；超出数量或体积上限后去掉 patch 正文。
  return messages.map((message) => {
    if (message.info.role !== "user") return message
    const summary = message.info.summary
    if (!summary) return message
    const diffs = compactSummaryDiffs(summary.diffs)
    if (diffs === summary.diffs) return message
    return {
      ...message,
      info: {
        ...message.info,
        summary: {
          ...summary,
          diffs,
        },
      },
    }
  })
}

function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all(),
    )
    for (const row of partRows) {
      const next = part(row)
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }

  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

// providerOptions 必须是 { [provider]: { ... } }（每个值是对象）。过滤掉非对象的顶层项
// （例如历史上误存进 metadata 的原文字符串），否则 convertToModelMessages 会报
// "messages do not match the ModelMessage[] schema"
function cleanProviderOptions(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const rest = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, v]) => key !== "skill" && v !== null && typeof v === "object" && !Array.isArray(v),
    ),
  )
  return Object.keys(rest).length > 0 ? rest : undefined
}

function textProviderOptions(part: Pick<TextPart, "metadata" | "phase">) {
  const metadata = cleanProviderOptions(part.metadata)
  if (!part.phase) return metadata
  // 显式 provider phase 保持原命名空间；兼容推断只有顶层 phase 时补到 OpenAI 标准回放入口，
  // 让下一轮模型上下文与 UI 的 commentary/final_answer 顺序保持一致。
  if (
    Object.values(metadata ?? {}).some(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        "phase" in value &&
        (value.phase === "commentary" || value.phase === "final_answer"),
    )
  )
    return metadata
  return {
    ...metadata,
    openai: { ...(metadata?.openai ?? {}), phase: part.phase },
  }
}

function safeModelFileUrl(url: string) {
  return url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")
}

function modelFilePart(part: Pick<FilePart, "mime" | "url" | "filename">) {
  // AI SDK 只接受 http/https/data 作为模型图片 URL；历史生成图可能保存为 file://，回放时降级成文字说明。
  if (!safeModelFileUrl(part.url))
    return {
      type: "text" as const,
      text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
    }
  return {
    type: "file" as const,
    url: part.url,
    mediaType: part.mime,
    filename: part.filename,
  }
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  const lastAbortedAssistantByTurn = new Map<MessageID, MessageID>()
  input.forEach((message) => {
    if (message.info.role !== "assistant" || !AbortedError.isInstance(message.info.error)) return
    // 同一次停止可能先终结工具 assistant、再为迟到 steer 补 tombstone；只在最后一个终态后写一次边界。
    lastAbortedAssistantByTurn.set(message.info.turnID ?? message.info.parentID, message.info.id)
  })
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support media in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Other SDKs (anthropic, google,
  // bedrock) handle type: "content" with media parts natively.
  //
  // Only apply this workaround if the model actually supports image input -
  // otherwise there's no point extracting images.
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) {
      if (
        msg.info.role === "assistant" &&
        AbortedError.isInstance(msg.info.error) &&
        lastAbortedAssistantByTurn.get(msg.info.turnID ?? msg.info.parentID) === msg.info.id
      ) {
        // 停止为尚未回答的 steer 生成的 tombstone 没有 part；它仍是隔开旧引导与下一问的权威终态。
        result.push({
          id: MessageID.ascending(),
          role: "user",
          parts: [{ type: "text", text: TURN_ABORTED_PROMPT }],
        })
      }
      continue
    }

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      result.push(userMessage)
      for (const part of msg.parts) {
        // 空文本会让 convertToModelMessages 报 "messages do not match ModelMessage[] schema"，跳过
        if (part.type === "text" && !part.ignored && part.text.trim().length > 0)
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push(modelFilePart(part))
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string }> = []
      const finalTurnAbort =
        AbortedError.isInstance(msg.info.error) &&
        lastAbortedAssistantByTurn.get(msg.info.turnID ?? msg.info.parentID) === msg.info.id

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        if (finalTurnAbort) {
          // 中断终态没有正文时仍要留下模型可见边界，防止下一条用户消息重新激活已停止的引导。
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [{ type: "text", text: TURN_ABORTED_PROMPT }],
          })
        }
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      for (const part of msg.parts) {
        // 空文本会让 convertToModelMessages 报 schema 错（消息退化为纯 step-start 后由下方过滤丢弃），跳过
        if (part.type === "text" && part.text.trim().length > 0)
          assistantMessage.parts.push({
            type: "text",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: textProviderOptions(part) }),
          })
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            const compacted = "compacted" in part.state.time ? part.state.time.compacted : undefined
            const attachments = compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            // 错误态通常来自用户停止或 provider 中断。附件仍保留在会话 part.state.attachments 里给 UI 展示，
            // 但不能再回放给模型；图片 data URL 会被 SDK 串进 tool output，轻易超过 OpenAI 10MB 输出上限。
            const finalAttachments = nonMediaAttachments
            if (typeof output === "string" || attachments.length > 0) {
              const outputText =
                typeof output === "string"
                  ? output
                  : `Tool execution interrupted after producing ${attachments.length} attachment(s).`
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output:
                  finalAttachments.length > 0
                    ? {
                        text: outputText,
                        attachments: finalAttachments,
                      }
                    : outputText,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else if (part.state.metadata?.interrupted === true) {
              // 用户暂停/停止（或被动中断）打断了这次工具调用，它没有产出结果。必须让模型明确知道
              // 这不是工具失败——否则目标模式恢复后模型会把一连串「aborted」误读成「工具一直在坏」，
              // 转而收窄策略（少调工具、拆小批次）。用 output-available 传中性说明而非 output-error。
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output:
                  "This tool call was interrupted before it finished, so it produced no result. This is not a tool failure — continue normally, and re-run the call only if its result is still needed.",
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output:
                "This tool call was interrupted before it finished, so it produced no result. This is not a tool failure — continue normally, and re-run the call only if its result is still needed.",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          // 思考翻译是纯展示层：回放给模型的必须是模型自己产出的、带签名的原文(originalText)，
          // 译文(text)只用于 UI。用译文回放会与 signature 不匹配 → 被 @ai-sdk/anthropic 丢块，
          // interleaved 模式下带 tool_use 的轮次缺失思考块 → Anthropic 持续 400（断线）。
          // 没有 provider 明确的 replay 身份时原文必须完整回放；仅凭 H+H 外形裁剪会破坏合法推理。
          const replayText = part.originalText ?? part.text
          if (differentModel) {
            if (replayText.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: replayText,
              })
            continue
          }
          // 空文本 reasoning 会让 provider 报 "messages do not match ModelMessage[] schema"，跳过
          if (replayText.trim().length > 0)
            assistantMessage.parts.push({
              type: "reasoning",
              text: replayText,
              providerMetadata: cleanProviderOptions(part.metadata),
            })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map(modelFilePart),
            ],
          })
        }
      }
      if (finalTurnAbort) {
        // 有部分回答或工具结果的中断同样需要显式标记；部分内容只能说明执行到哪，不能表达用户主动停止。
        result.push({
          id: MessageID.ascending(),
          role: "user",
          parts: [{ type: "text", text: TURN_ABORTED_PROMPT }],
        })
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

/**
 * 「排队中(尚未开始处理)的用户消息」：比「当前在途(未终结)assistant 的 parentID」更新的用户消息。
 * 用于删除守卫——排队消息允许在会话 busy 时撤销，处理中/已回答的消息不允许(避免破坏进行中的回合)。
 *
 * 放行边界用「在途 assistant 的 parentID」而非任意历史 assistant 的最大 parentID：普通发消息时前端会乐观插入
 * 用户消息、SDK 立即 204，服务端后台真正建 assistant 前有个窗口——此时列表里那条正在启动处理的新用户消息
 * 会满足「比历史 parentID 更新」，若据此放行删除，后台 runLoop 会找不到 user / 建出指向已删消息的 assistant，
 * 破坏当前回合。无在途 assistant 时(该窗口)不放行任何消息。
 */
export function isQueuedUserMessage(msgs: WithParts[], messageID: MessageID): boolean {
  const targetIndex = msgs.findIndex((m) => m.info.id === messageID)
  const target = msgs[targetIndex]
  if (!target || target.info.role !== "user") return false
  // 只看最新一条 assistant 消息:仅当它非 terminal(回合真在途)时其 parentID 才算在途回合。旧实现遍历所有
  // assistant 取最后一个非 terminal,会把完成的工具轮里被后续 stop 步取代的历史 tool-calls 步也当在途
  //(tool-calls 视为非 terminal)→ 放行删除正在被处理的消息,丢失该回合的用户消息。
  let inFlightParent: MessageID | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info
    if (info.role !== "assistant") continue
    const terminal = info.error || (info.finish && !["tool-calls", "unknown"].includes(info.finish))
    if (!terminal && info.parentID) inFlightParent = info.parentID
    break
  }
  if (inFlightParent === undefined) return false
  // sessions.messages() 已按真实创建顺序返回；旧 msg_remote_<hash> 的字典序不携带时间信息，
  // 因此排队关系只能比较目标用户与在途 parent 在数组中的位置。
  const parentIndex = msgs.findIndex((msg) => msg.info.id === inFlightParent)
  // 消息数组已按 first-seen 顺序恢复；比较数组位置同时兼容远控 ID 与本地生成 ID。
  return parentIndex >= 0 && targetIndex > parentIndex
}

const boundedMessageFields = {
  id: MessageTable.id,
  session_id: MessageTable.session_id,
  sequence: MessageTable.sequence,
  time_created: MessageTable.time_created,
  time_updated: MessageTable.time_updated,
  // 历史版本可能把数百 MB patch 写进 user.summary；先在 SQLite 内替换为空数组，
  // 避免原始 JSON 进入 V8 后在解码、Schema 校验和 IPC 编码阶段被反复复制。此读取保护不改数据库原文。
  data: sql<typeof MessageTable.$inferSelect.data>`CASE
    WHEN length(CAST(${MessageTable.data} AS BLOB)) > ${2 * 1024 * 1024}
    THEN json_replace(${MessageTable.data}, '$.summary.diffs', json('[]'))
    ELSE ${MessageTable.data}
  END`.mapWith(MessageTable.data),
}

export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
  const before = input.before ? cursor.decode(input.before) : undefined
  // 已发给旧客户端的 time/id 游标仍可能回来；锚点尚在时先解析为 sequence，避免同毫秒逆 ID 历史漏页。
  const resolvedBefore =
    before && "time" in before
      ? Database.use((db) => {
          const anchor = db
            .select({ sequence: MessageTable.sequence })
            .from(MessageTable)
            .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, before.id)))
            .get()
          return anchor ? { id: before.id, sequence: anchor.sequence } : before
        })
      : before
  const where = resolvedBefore
    ? and(eq(MessageTable.session_id, input.sessionID), older(resolvedBefore))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = Database.use((db) =>
    db
      .select(boundedMessageFields)
      .from(MessageTable)
      .where(where)
      // 官方持久快照按 turn.items 首次 push 顺序恢复；消息 ID 和毫秒时间都不能承担位置语义。
      .orderBy(desc(MessageTable.sequence))
      .limit(input.limit + 1)
      .all(),
  )
  if (rows.length === 0) {
    const row = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, sequence: tail.sequence }) : undefined,
  }
}

export function messageHighWater(sessionID: SessionID) {
  // runner 只需要“启动前最后一个序号”，不能为建立水位 hydrate 整个会话及其历史 diff。
  return (
    Database.use((db) =>
      db
        .select({ sequence: MessageTable.sequence })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(desc(MessageTable.sequence))
        .limit(1)
        .get(),
    )?.sequence ?? -1
  )
}

export function latestAssistant(input: { sessionID: SessionID; afterSequence?: number }) {
  // 中断收尾只 hydrate 水位之后最新的 assistant；旧巨型 user 行不会再进入查找路径。
  const row = Database.use((db) =>
    db
      .select({
        id: MessageTable.id,
        session_id: MessageTable.session_id,
        sequence: MessageTable.sequence,
        time_created: MessageTable.time_created,
        time_updated: MessageTable.time_updated,
        data: MessageTable.data,
      })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, input.sessionID),
          input.afterSequence === undefined ? undefined : gt(MessageTable.sequence, input.afterSequence),
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        ),
      )
      .orderBy(desc(MessageTable.sequence))
      .limit(1)
      .get(),
  )
  return row ? hydrate([row])[0] : undefined
}

const remoteHistoryMessageMaxBytes = 32 * 1024 * 1024
const remoteHistoryPartMaxCount = 2_048
const remoteHistoryPageMaxMessages = 8

export type RemoteHistoryPageItem =
  | { type: "message"; message: WithParts; bytes: number }
  | { type: "oversized"; messageID: MessageID }

export type RemoteHistoryPage = {
  items: RemoteHistoryPageItem[]
  nextCursor?: string
  highWater: string | null
}

// 远控历史先按键和 JSON 长度筛选，再逐条 hydrate；高水位与 keyset cursor 共同冻结本次快照。
export function remoteHistoryPage(input: {
  sessionID: SessionID
  direction: "forward" | "backward"
  limit: number
  cursor?: string
  highWater?: string | null
}): RemoteHistoryPage {
  const limit = Math.min(remoteHistoryPageMaxMessages, Math.max(1, Math.floor(input.limit)))
  return Database.transaction((tx) => {
    const highWaterRow =
      input.highWater === undefined
        ? tx
            .select({ id: MessageTable.id, time: MessageTable.time_created })
            .from(MessageTable)
            .where(eq(MessageTable.session_id, input.sessionID))
            .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
            .limit(1)
            .get()
        : input.highWater === null
          ? undefined
          : cursor.decode(input.highWater)
    if (!highWaterRow) return { items: [], highWater: null }

    const highWater = cursor.encode(highWaterRow)
    const pageCursor = input.cursor ? cursor.decode(input.cursor) : undefined
    const boundary = pageCursor ? (input.direction === "backward" ? older(pageCursor) : newer(pageCursor)) : undefined
    const rows = tx
      .select({
        id: MessageTable.id,
        time: MessageTable.time_created,
        dataBytes: sql<number>`length(CAST(${MessageTable.data} AS BLOB))`,
      })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, input.sessionID), atOrOlder(highWaterRow), boundary))
      .orderBy(
        input.direction === "backward" ? desc(MessageTable.time_created) : asc(MessageTable.time_created),
        input.direction === "backward" ? desc(MessageTable.id) : asc(MessageTable.id),
      )
      .limit(limit + 1)
      .all()
    const more = rows.length > limit
    const selected = more ? rows.slice(0, limit) : rows
    const items = selected.map((row): RemoteHistoryPageItem => {
      const partSizes = tx
        .select({ bytes: sql<number>`length(CAST(${PartTable.data} AS BLOB))` })
        .from(PartTable)
        .where(eq(PartTable.message_id, row.id))
        .limit(remoteHistoryPartMaxCount + 1)
        .all()
      const bytes =
        Number(row.dataBytes) + partSizes.reduce((total, item) => total + Math.max(0, Number(item.bytes)), 0)
      if (
        Number(row.dataBytes) > remoteHistoryMessageMaxBytes ||
        partSizes.length > remoteHistoryPartMaxCount ||
        bytes > remoteHistoryMessageMaxBytes
      ) {
        return { type: "oversized", messageID: row.id }
      }

      // 长度门禁与实际读取位于同一同步事务，其他连接的并发更新不能在检查后换入超大 JSON。
      const messageRow = tx
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, row.id)))
        .get()
      if (!messageRow) return { type: "oversized", messageID: row.id }
      const partRows = tx.select().from(PartTable).where(eq(PartTable.message_id, row.id)).orderBy(PartTable.id).all()
      const message = sanitizeMessage({ info: info(messageRow), parts: partRows.map(part) })
      return message ? { type: "message", message, bytes } : { type: "oversized", messageID: row.id }
    })
    const tail = selected.at(-1)
    return {
      items,
      highWater,
      ...(more && tail ? { nextCursor: cursor.encode({ id: tail.id, time: tail.time }) } : {}),
    }
  })
}

export function* stream(sessionID: SessionID) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = page({ sessionID, limit: size, before })
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0; i--) {
      yield next.items[i]
    }
    if (!next.more || !next.cursor) break
    before = next.cursor
  }
}

export function parts(message_id: MessageID) {
  const rows = Database.use((db) =>
    db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
  )
  return rows.map(
    (row) =>
      ({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }) as Part,
  )
}

export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
  const row = Database.use((db) =>
    db
      // 单条消息端点与分页必须共享同一历史体积门禁，避免点击旧消息时重新把巨型摘要载入主进程。
      .select(boundedMessageFields)
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: parts(input.messageID),
  }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  // 模型运行不消费 user.summary.diffs；在进入上下文转换前统一裁掉 patch，限制旧会话的常驻对象体积。
  return compactMessageSummaryDiffs(filterCompacted(stream(sessionID)))
})

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case APIError.isInstance(e):
      return APIError.Schema.parse(
        typeof (e as { toObject?: unknown }).toObject === "function"
          ? (e as { toObject: () => unknown }).toObject()
          : e,
      )
    case ContextOverflowError.isInstance(e):
      // processor 内部也会主动构造上下文溢出错误，必须保留原始错误类型供压缩流程识别。
      return ContextOverflowError.Schema.parse(
        typeof (e as { toObject?: unknown }).toObject === "function"
          ? (e as { toObject: () => unknown }).toObject()
          : e,
      )
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as { code?: string }).code === "STREAM_STALL":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Stream stalled",
          isRetryable: true,
          metadata: {
            code: "STREAM_STALL",
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as { code?: string }).code === "STREAM_FAILED":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: e.message || "Stream failed",
          isRetryable: true,
          metadata: {
            code: "STREAM_FAILED",
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
