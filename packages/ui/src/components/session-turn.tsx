import {
  AssistantMessage,
  type FilePart,
  type SnapshotFileDiff,
  Message as MessageType,
  Part as PartType,
} from "@opencode-ai/sdk/v2/client"
import type { SessionStatus, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "../context/file"
import { useImagePreview } from "../context/image-preview"
import {
  classifyAssistantError,
  classifyBalanceError,
  shouldRenderErrorActionButton,
  type BalanceErrorKind,
} from "./session-turn-error"
import { displayImageFailureText, displaySessionErrorText } from "./session-error-display"
import { scrollKey } from "./scroll-view"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"

import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  ParentProps,
  Show,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import {
  AssistantParts,
  Message,
  MessageDivider,
  PART_MAPPING,
  ReasoningOriginalContext,
  type UserActions,
} from "./message-part"
import { effectiveTurnStart } from "./turn-timing"
import { Card } from "./card"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { DiffChanges } from "./diff-changes"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Button } from "./button"
import { Tooltip } from "./tooltip"
import { TextShimmer } from "./text-shimmer"
import { SessionRetry } from "./session-retry"
import { TextReveal } from "./text-reveal"
import { Collapsible } from "./collapsible"
import { DropdownMenu } from "./dropdown-menu"
import { HoverCard } from "./hover-card"
import { FileLinkContextMenu } from "./file-link-context-menu"
import { resolveWorkspaceFilePath } from "./session-turn-path"
import { sessionReviewDiffNeedsFullLoad } from "./session-review-performance"
import { fileUrlFromAbsolutePath, isHtmlFilePath } from "./markdown-local-path"
import { createAutoScroll } from "../hooks"
import { useI18n, type UiI18nKey } from "../context/i18n"
import { normalize, mergeDiffsWithOverlay, hasRenderableDiffBody, diffPathKey } from "./session-diff"
import {
  assistantEndedWithResponse,
  assistantTextPartInActivity,
  assistantTurnTerminal,
  compactionFinished,
  reconcileSessionTurnActivityMembers,
  selectFinalAssistantTextPart,
  sessionTurnPresentation,
  type SessionTurnActivityMember,
} from "./session-turn-members"
import { collapseThinkingWithViewport } from "./thinking-collapse-scroll"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function editDiffListOverflow(el: HTMLDivElement | undefined) {
  if (!el) return false
  return el.scrollHeight > el.clientHeight + 1
}

const EDIT_DIFF_SCROLL_LINE = 40
const EDIT_DIFF_SCROLLBAR_BUTTON_HEIGHT = 17
const EDIT_DIFF_THUMB_MIN_TRAVEL = 4
const EDIT_DIFF_THUMB_HIT_SLOP = 4

function editDiffThumbMetrics(scrollHeight: number, clientHeight: number, scrollTop: number) {
  if (scrollHeight <= clientHeight) return undefined

  const track = Math.max(clientHeight - EDIT_DIFF_SCROLLBAR_BUTTON_HEIGHT * 2, 1)
  const proportional = Math.round((clientHeight / scrollHeight) * track)
  const thumbMax = Math.max(track - EDIT_DIFF_THUMB_MIN_TRAVEL, 1)
  const thumb = Math.min(Math.max(24, proportional), thumbMax)
  const maxTop = Math.max(track - thumb, 0)
  const top = maxTop <= 0 ? 0 : (scrollTop / Math.max(scrollHeight - clientHeight, 1)) * maxTop

  return { track, thumb, maxTop, top }
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function isStreamStall(error: unknown): boolean {
  if (!record(error)) return false
  const data = record(error.data) ? error.data : undefined
  const metadata = data && record(data.metadata) ? data.metadata : undefined
  return metadata?.code === "STREAM_STALL"
}

function errorMessageText(error: unknown): string {
  if (!record(error)) return ""

  const data = record(error.data) ? error.data : undefined
  const candidates = [
    data?.message,
    error.message,
    data?.responseBody,
    error.responseBody,
    data?.reason,
    error.reason,
    data?.code,
    error.code,
    error.name,
  ]

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return unwrap(value)
  }

  return ""
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

const hidden = new Set(["todowrite"])

function partState(part: PartType, showReasoningSummaries: boolean) {
  if (part.type === "tool") {
    if (hidden.has(part.tool)) return
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")) return
    return "visible" as const
  }
  if (part.type === "text") return part.text?.trim() ? ("visible" as const) : undefined
  if (part.type === "reasoning") {
    if (showReasoningSummaries && part.text?.trim()) return "visible" as const
    return
  }
  if (PART_MAPPING[part.type]) return "visible" as const
  return
}

function assistantImageFile(part: PartType): part is FilePart {
  if (part.type !== "file") return false
  if (part.filename?.startsWith("wanlai-image-loading-")) return false
  return part.mime.startsWith("image/") || !!part.filename?.startsWith("wanlai-image-")
}

// Codex.app 会把 imageGeneration item 聚合成 generatedImages；这里从工具完成态附件还原同一层语义。
function imageGenerationAttachments(part: PartType) {
  if (part.type !== "tool") return []
  if (part.tool !== "image_generation") return []
  if (part.state.status !== "running" && part.state.status !== "completed" && part.state.status !== "error") return []
  return ((part.state as { attachments?: FilePart[] }).attachments ?? []).filter(assistantImageFile)
}

function imagePartKey(part: FilePart) {
  return part.url || part.id
}

// 生图工具的 size 入参是加载完成前唯一能拿到的尺寸信息。把它换算成 aspect-ratio 设在 <img> 上，
// 浏览器就能在图片解码完成前算出高度，避免图片一落地就把下方内容整体推走。
const GENERATED_IMAGE_ASPECT_RATIO: Record<string, string> = {
  "1024x1024": "1 / 1",
  "1536x1024": "3 / 2",
  "1024x1536": "2 / 3",
}

function generatedImageAspectRatio(part: PartType) {
  if (part.type !== "tool") return undefined
  if (part.tool !== "image_generation") return undefined
  const size = (part.state as { input?: { size?: unknown } }).input?.size
  if (typeof size !== "string") return undefined
  return GENERATED_IMAGE_ASPECT_RATIO[size]
}

function generatedImagesFromParts(parts: readonly PartType[]) {
  const seen = new Set<string>()
  return parts.flatMap(imageGenerationAttachments).filter((image) => {
    const key = imagePartKey(image)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function GeneratedImageGallery(props: { images: FilePart[]; aspectRatio?: string }) {
  const imagePreview = useImagePreview()
  const name = (image: FilePart, index: number) => image.filename?.trim() || `Generated image ${index + 1}`
  const openImagePreview = (image: FilePart, index: number) => {
    imagePreview.show({ src: image.url, alt: name(image, index) })
  }
  // 多图走 CSS 里的方形网格（容器已有 aspect-ratio + object-fit: cover），高度本就稳定；
  // 只有单图是 width:100% + height:auto，需要预留比例。
  const placeholderRatio = () => (props.images.length === 1 ? props.aspectRatio : undefined)

  return (
    <div data-slot="session-turn-generated-image-gallery" data-count={String(props.images.length)}>
      <For each={props.images}>
        {(image, index) => (
          <button
            type="button"
            data-slot="session-turn-generated-image-preview"
            aria-label={name(image, index())}
            onClick={() => openImagePreview(image, index())}
          >
            <img
              data-slot="session-turn-generated-image"
              src={image.url}
              alt={name(image, index())}
              style={placeholderRatio() ? { "aspect-ratio": placeholderRatio() } : undefined}
            />
          </button>
        )}
      </For>
    </div>
  )
}

function finalAssistantMessage(message: AssistantMessage) {
  // 压缩摘要是内部上下文，不是给用户看的最终回复；最终聊天区只展示真实 assistant 回答。
  return message.summary !== true
}

// 自动化创建卡片按 Codex 风格放在普通聊天流里,不折叠进「已处理」。
function mainChatAssistantPart(part: PartType) {
  if (assistantImageFile(part)) return true
  return part.type === "tool" && (part as { tool?: string }).tool === "automation_create"
}

function processedThinkingPart(part: PartType, finalTextPartID?: string, _working = false) {
  // 活动链保留 working 参数契约，但内容归属不再随状态切换，避免结束瞬间卸载并重挂图片。
  // 已完成的生图工具仍要保留在「已处理」区，用来承载完成态和工具过程；图片本体由最终图片区域单独展示，避免重复。
  if (part.type === "tool" && part.tool === "image_generation") return true
  // 图片始终只在最终聊天区渲染。曾经的写法在 working 期间把图片留在思考区，回合结束再交给最终区，
  // 等于同一张图先卸载再重新挂载：图片从零重新加载撑开，同时思考区缩、最终区涨，双向顶走阅读位置。
  if (mainChatAssistantPart(part)) return false
  // 文本默认保持在原始活动流位置，只排除本响应段唯一被抽到底部的具体 item；
  // 较早的 final_answer 也必须继续可见，不能因为 phase 相同就被整批隐藏。
  if (part.type === "text") return assistantTextPartInActivity(part, finalTextPartID)
  return true
}

function clean(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
}

function heading(text: string) {
  const markdown = text.replace(/\r\n?/g, "\n")

  const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  if (html?.[1]) {
    const value = clean(html[1].replace(/<[^>]+>/g, " "))
    if (value) return value
  }

  const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
  if (atx?.[1]) {
    const value = clean(atx[1])
    if (value) return value
  }

  const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
  if (setext?.[1]) {
    const value = clean(setext[1])
    if (value) return value
  }

  const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
  if (strong?.[1]) {
    const value = clean(strong[1])
    if (value) return value
  }
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m <= 0) return `${s}s`
  return `${m}m ${String(s).padStart(2, "0")}s`
}

type TextRenderVersion = { partID: string; text: string }

function sameTextRenderVersion(a: TextRenderVersion | undefined, b: TextRenderVersion | undefined) {
  return a?.partID === b?.partID && a?.text === b?.text
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    messages?: MessageType[]
    parts?: Record<string, PartType[] | undefined>
    /** 逻辑 turn 内的完整消息顺序；成功 steer 只增加成员，不增加第二个 SessionTurn。 */
    memberMessageIDs?: readonly string[]
    /** 需要按 turn.items 原位展示、并在活动折叠后保持可见的 steer user。 */
    steeringUserMessageIDs?: readonly string[]
    /** 为 turn 内的 steer user 保留可直达的消息锚点。 */
    messageAnchor?: (messageID: string) => string
    /** steer 自己的附件评论必须跟随该用户气泡，不能被提升到物理 turn 根消息上方。 */
    beforeSteeringMessage?: (messageID: string) => JSX.Element
    /** 模型切换等消息级提示仍锚定触发它的 steer，而不是在逻辑 turn 合并时丢失。 */
    afterSteeringMessage?: (messageID: string) => JSX.Element
    actions?: UserActions
    /** 此 turn 是否为会话最后一个 user turn —— 决定其内最后一条 assistant 是否常显 fork */
    isLatestUserTurn?: boolean
    showReasoningSummaries?: boolean
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    active?: boolean
    working?: boolean
    /** 主时间线的真实滚动视口；完成态折叠用它保护用户正在阅读的位置。 */
    scrollContainer?: () => HTMLElement | undefined
    status?: SessionStatus
    afterUserContent?: JSX.Element
    onUserInteracted?: () => void
    /**
     * 错误卡片内行为按钮的执行回调，由 app 层注入（跨包：ui 不能直接 import app 的行为入口）。
     * action ∈ {relogin, open_purchase, show_quota, backoff_retry, show_blocked} 时才呈现按钮。
     */
    onErrorAction?: (action: ErrorAction) => void
    /** VCS patches by file — merged into summary-only rows (e.g. submodule) to match Review panel */
    diffOverlay?: () => ReadonlyArray<SnapshotFileDiff | VcsFileDiff>
    /** Workspace root (e.g. SDK directory) so absolute summary paths match repo-relative overlay keys */
    diffOverlayWorkspaceRoot?: () => string | undefined
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyFiles: FilePart[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyDiffs: SnapshotFileDiff[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => props.messages ?? list(data.store.message?.[props.sessionID], emptyMessages))
  const presentation = createMemo(() =>
    sessionTurnPresentation({
      messages: allMessages(),
      rootMessageID: props.messageID,
      memberMessageIDs: props.memberMessageIDs,
      steeringUserMessageIDs: props.steeringUserMessageIDs,
    }),
  )
  const messageParts = (messageID: string) => list(props.parts?.[messageID] ?? data.store.part?.[messageID], emptyParts)

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    // 服务端消息按首次到达顺序保存，远控 ID 和本地 ID 都只用于身份匹配；必须精确查找，不能按 ID 二分猜位置。
    const index = messages.findIndex((message) => message.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const pending = createMemo(() => {
    if (typeof props.active === "boolean") return
    const messages = allMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && !assistantTurnTerminal(item),
    )
  })

  const pendingUser = createMemo(() => {
    const item = pending()
    if (!item?.parentID) return
    const messages = allMessages() ?? emptyMessages
    // pending assistant 的 parentID 是身份引用，与列表顺序无关；错误命中会把活动态显示到另一条 turn。
    const msg = messages.find((message) => message.id === item.parentID)
    if (!msg || msg.role !== "user") return
    return msg
  })
  const active = createMemo(() => {
    if (typeof props.active === "boolean") return props.active
    const msg = message()
    const parent = pendingUser()
    if (!msg || !parent) return false
    return parent.id === msg.id
  })

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return messageParts(msg.id)
  })

  const turnUserMessages = createMemo(() =>
    presentation().members.filter((item): item is Extract<MessageType, { role: "user" }> => item.role === "user"),
  )
  const compaction = createMemo(() =>
    turnUserMessages()
      .flatMap((item) => messageParts(item.id))
      .findLast((part) => part.type === "compaction"),
  )

  const diffs = createMemo(() => {
    // 同一逻辑 turn 可能经过多次 steer；文件摘要必须合并所有成员，再按路径保留最后状态。
    const files = turnUserMessages().flatMap((item) => item.summary?.diffs ?? [])
    if (!files?.length) return emptyDiffs

    const seen = new Set<string>()
    return files
      .reduceRight<SnapshotFileDiff[]>((result, diff) => {
        if (seen.has(diff.file)) return result
        seen.add(diff.file)
        result.push(diff)
        return result
      }, [])
      .reverse()
  })

  const storedSessionDiffs = createMemo(() => {
    const all = data.store.session_diff?.[props.sessionID]
    if (!all?.length) return emptyDiffs
    return all
  })
  const MAX_FILES = 10
  const edited = createMemo(() => diffs().length)
  const [state, setState] = createStore({
    showAll: false,
    expandedThinking: [] as string[],
    expandedFinal: [] as string[],
  })
  const showAll = () => state.showAll
  const expandedThinking = () => state.expandedThinking
  const expandedFinal = () => state.expandedFinal
  const overflow = createMemo(() => Math.max(0, edited() - MAX_FILES))
  const visible = createMemo(() => (showAll() ? diffs() : diffs().slice(0, MAX_FILES)))
  const toggleAll = () => {
    autoScroll.pause()
    setState("showAll", !showAll())
  }

  const assistantMessages = createMemo(() => presentation().assistants, emptyAssistant, { equals: same })
  const currentAssistantMessages = createMemo(() => presentation().currentAssistants, emptyAssistant, { equals: same })
  const currentUserMessages = createMemo(() => presentation().currentUsers)
  // 响应段只用于判断最新活动和最终交付归属，所有 segment 仍共享同一个 turn 级活动容器。
  const activitySegments = createMemo(() => presentation().activitySegments)
  const currentActivitySegment = createMemo(() => activitySegments().at(-1))
  const currentActivityMembers = createMemo(() => currentActivitySegment()?.members ?? [])
  const activityMembers = createMemo(
    (previous: readonly SessionTurnActivityMember[]) =>
      reconcileSessionTurnActivityMembers(previous, presentation().activity),
    [],
  )
  const steeringMessages = createMemo(() => presentation().steering)
  const currentActivityMessageIDs = createMemo(
    () => new Set(currentActivityMembers().map((member) => member.message.id)),
  )
  const activeActivityMessageID = createMemo(() => currentActivityMembers().at(-1)?.message.id)
  // presentation 的最后一条 assistant 只表示当前响应段；它可能刚创建且尚无内容，不能据此清空旧活动。
  const latestAssistant = createMemo(() => presentation().finalAssistant)
  // 选择粒度必须落到具体 TextPart：同一响应段可能跨多条 assistant 产生多个 final_answer，官方只抽最后一个。
  const finalTextSelection = createMemo(() =>
    selectFinalAssistantTextPart(
      currentAssistantMessages().map((message) => ({ message, parts: messageParts(message.id) })),
    ),
  )
  // part ID 不足以识别迟到 delta：同一个 TextPart 会原位增长，因此版本必须同时保存用户实际看到的展示文本。
  // 这里与 TextPartDisplay 使用完全相同的转换，确保 Markdown 绘制回报和目标版本可以精确比较。
  const finalTextRenderVersion = createMemo<TextRenderVersion | undefined>(() => {
    const selected = finalTextSelection()
    if (!selected) return
    const text = selected.part.text.trim()
    return { partID: selected.part.id, text: text ? displayImageFailureText(text, i18n.t) : text }
  })
  const finalAnswerAssistant = createMemo(() => {
    const selected = finalTextSelection()
    if (selected) return selected.message
    return currentAssistantMessages().findLast((message) => {
      if (!finalAssistantMessage(message)) return false
      const parts = messageParts(message.id)
      // 没有最终文本时，图片与主聊天卡片仍作为最终交付占用底部回复区。
      return parts.some(mainChatAssistantPart) || generatedImagesFromParts(parts).length > 0
    })
  })

  const interrupted = createMemo(() => currentAssistantMessages().some((m) => m.error?.name === "MessageAbortedError"))
  const erroredAssistant = createMemo(() =>
    currentAssistantMessages().findLast((m) => m.error && m.error.name !== "MessageAbortedError"),
  )
  const error = createMemo(() => erroredAssistant()?.error)
  // 最终展示与复制共用同一个具体 part，避免同 phase 的较早文本被一并抽到底部。
  const showAssistantCopyPartID = createMemo(() => finalTextSelection()?.part.id)
  const finalAssistantTextPartID = createMemo(() => showAssistantCopyPartID())
  const finalAnswerParts = createMemo(() => {
    const message = finalAnswerAssistant()
    return message ? messageParts(message.id) : emptyParts
  })
  // 官方每个 turn 只提取最后一个 final_answer item；底部回复、图片与复制必须共用这一选择结果。
  const assistantHasMainChatPart = createMemo(() => finalAnswerParts().some(mainChatAssistantPart))
  const assistantHasGeneratedImages = createMemo(() => generatedImagesFromParts(finalAnswerParts()).length > 0)
  // 上层 unwrap 出的后端原始文本（用于附带展示 / 旧字符串兜底匹配）。
  const rawErrorText = createMemo(() => {
    return errorMessageText(error())
  })

  // 错误分类：reason 码契约优先（resolveError），unknown 时退回旧字符串匹配兜底（仅 wanlaicode 网关）。
  const classifiedError = createMemo(() => {
    const err = error()
    if (!err) return undefined
    return classifyAssistantError({
      error: err,
      rawText: rawErrorText(),
      isWanlai: erroredAssistant()?.providerID === "wanlaicode",
    })
  })

  // 无套餐用户「账户余额按量付费」相关错误码：优先用结构化 code 归类（最可靠），
  // 命中后走专门的友好文案 + 引导动作（开启余额扣费 / 充值 / 购买套餐 / 换模型）。
  const balanceError = createMemo<BalanceErrorKind>(() => {
    // 与 classifiedError 一致：仅当错误来自 wanlaicode 网关时才按余额扣费契约归类，
    // 否则用户自配 provider 的错误可能被误判并展示「开启余额扣费 / 升级套餐」等引导。
    if (erroredAssistant()?.providerID !== "wanlaicode") return null
    const data = error()?.data as { message?: unknown; responseBody?: unknown } | undefined
    if (!data) return null
    return classifyBalanceError({
      message: typeof data.message === "string" ? data.message : undefined,
      responseBody: typeof data.responseBody === "string" ? data.responseBody : undefined,
    })
  })

  const balanceErrorText = createMemo(() => {
    switch (balanceError()) {
      case "needEnableBalance":
        return i18n.t("ui.sessionTurn.error.needEnableBalance")
      case "noPlanNoBalance":
        return i18n.t("ui.sessionTurn.error.noPlanNoBalance")
      case "insufficientBalance":
        return i18n.t("ui.sessionTurn.error.insufficientBalance")
      case "balanceModelUnavailable":
        return i18n.t("ui.sessionTurn.error.balanceModelUnavailable")
      case "balanceFallbackUnavailable":
        return i18n.t("ui.sessionTurn.error.balanceFallbackUnavailable")
      default:
        return undefined
    }
  })

  // 余额扣费类错误码的引导按钮（inline / standalone 两处卡片共用）。
  const renderBalanceActions = () => (
    <Show when={balanceError()}>
      <div data-slot="session-turn-balance-actions" class="flex flex-wrap gap-2">
        <Show when={balanceError() === "needEnableBalance"}>
          <Show when={props.actions?.openPurchasePage}>
            <Button size="small" variant="secondary" onClick={() => void props.actions?.openPurchasePage?.()}>
              {i18n.t("ui.sessionTurn.error.action.purchasePlan")}
            </Button>
          </Show>
          <Show when={props.actions?.enableBalanceBilling}>
            <Button
              size="small"
              variant="primary"
              onClick={() =>
                void props.actions?.enableBalanceBilling?.({
                  sessionID: props.sessionID,
                  messageID: props.messageID,
                })
              }
            >
              {i18n.t("ui.sessionTurn.error.action.enableBalance")}
            </Button>
          </Show>
        </Show>
        <Show
          when={
            (balanceError() === "noPlanNoBalance" || balanceError() === "insufficientBalance") &&
            props.actions?.openPurchasePage
          }
        >
          <Button
            size="small"
            variant={balanceError() === "insufficientBalance" ? "primary" : "secondary"}
            onClick={() => void props.actions?.openPurchasePage?.()}
          >
            {i18n.t(
              balanceError() === "insufficientBalance"
                ? "ui.sessionTurn.error.action.recharge"
                : "ui.sessionTurn.error.action.purchasePlan",
            )}
          </Button>
        </Show>
      </div>
    </Show>
  )

  // 共享：inline-notice 左侧 info-circle 图标
  const renderNoticeIcon = () => (
    <span data-slot="session-turn-inline-notice-icon" aria-hidden="true">
      <Icon name="info-circle" size="small" />
    </span>
  )

  // 共享：错误消息内容区（error-detail / balance / reason action）
  const renderErrorNoticeContent = () => (
    <div data-slot="session-turn-inline-notice-content">
      <span data-slot="session-turn-error-message">{errorText()}</span>
      {/* 通用文案下附带后端原始 message，避免丢失具体信息 */}
      <Show when={errorRawDetail()}>
        {(detail) => (
          <span data-slot="session-turn-error-detail" class="text-12-regular opacity-80">
            {detail()}
          </span>
        )}
      </Show>
      {renderBalanceActions()}
      {/* reason 码契约驱动的行为按钮；行为执行交由 app 注入的 onErrorAction */}
      <Show when={errorActionButton()}>
        {(action) => (
          <span data-slot="session-turn-error-action">
            <Button variant="secondary" size="small" class="self-start" onClick={() => props.onErrorAction?.(action())}>
              {i18n.t(("errors.action." + action()) as UiI18nKey)}
            </Button>
          </span>
        )}
      </Show>
    </div>
  )

  // 错误卡片主文案。
  const errorText = createMemo(() => {
    if (isStreamStall(error())) return i18n.t("ui.sessionTurn.error.streamStalled")
    // 余额扣费类错误码优先（带结构化 code，最可靠）。
    const balance = balanceErrorText()
    if (balance) return balance
    const c = classifiedError()
    if (!c) return ""
    switch (c.kind) {
      case "reconnecting":
        return i18n.t("ui.sessionTurn.error.reconnecting")
      case "noPlan":
        return i18n.t("ui.sessionTurn.error.noPlan")
      case "upstreamModelUnsupported":
        return i18n.t("ui.sessionTurn.error.modelUnsupported")
      case "contract":
        return i18n.t(c.messageKey as UiI18nKey)
      default:
        return c.rawText || i18n.t("errors.category.unknown")
    }
  })

  // 通用文案下方附带展示的后端原始 message（避免丢失具体信息）；与主文案相同则不重复展示。
  const errorRawDetail = createMemo(() => {
    const c = classifiedError()
    if (!c || !c.showRaw) return undefined
    const raw = c.rawText
    if (!raw || raw === errorText()) return undefined
    // displaySessionErrorText 无法分类时原样返回 raw；用 || raw 确保 unknown 兜底错误详情不被丢失。
    const detail = displaySessionErrorText(raw, i18n.t) || raw
    if (detail === errorText()) return undefined
    return detail
  })

  // 需要在卡片内呈现的行为按钮 action（不在按钮集合内时为 undefined）。
  const errorActionButton = createMemo<ErrorAction | undefined>(() => {
    const c = classifiedError()
    if (!c) return undefined
    return shouldRenderErrorActionButton(c.action) ? c.action : undefined
  })

  const status = createMemo(() => {
    if (props.status !== undefined) return props.status
    if (typeof props.active === "boolean" && !props.active) return idle
    return data.store.session_status[props.sessionID] ?? idle
  })
  const runtimeWorking = createMemo(() => {
    if (props.working !== undefined) return props.working
    return status().type !== "idle" && active()
  })
  const [renderState, setRenderState] = createStore({
    runObserved: false,
    pendingFinalTextVersion: undefined as TextRenderVersion | undefined,
    renderedFinalTextVersion: undefined as TextRenderVersion | undefined,
  })
  let presentationFrame: number | undefined
  let presentationPaintFrame: number | undefined

  const clearPresentationFrame = () => {
    if (presentationFrame !== undefined) cancelAnimationFrame(presentationFrame)
    if (presentationPaintFrame !== undefined) cancelAnimationFrame(presentationPaintFrame)
    presentationFrame = undefined
    presentationPaintFrame = undefined
  }

  const releasePresentationAfterPaint = (expected: TextRenderVersion | undefined) => {
    if (presentationFrame !== undefined || presentationPaintFrame !== undefined) return
    presentationFrame = requestAnimationFrame(() => {
      presentationFrame = undefined
      presentationPaintFrame = requestAnimationFrame(() => {
        presentationPaintFrame = undefined
        if (runtimeWorking()) return
        if (!sameTextRenderVersion(finalTextRenderVersion(), expected)) return
        if (expected && !sameTextRenderVersion(renderState.renderedFinalTextVersion, expected)) return
        setRenderState({ runObserved: false, pendingFinalTextVersion: undefined })
      })
    })
  }

  createEffect(() => {
    if (runtimeWorking()) {
      clearPresentationFrame()
      // 锁存这轮真实运行态；后端终态到达后仍由最终正文的绘制确认负责释放。
      setRenderState({ runObserved: true, pendingFinalTextVersion: undefined })
      return
    }
    if (!renderState.runObserved) return

    const target = finalTextRenderVersion()
    if (!sameTextRenderVersion(target, renderState.pendingFinalTextVersion)) {
      // idle 后同 ID 的迟到 delta 会改变目标版本；立即取消旧静默窗口，绝不能借旧绘制确认结束。
      clearPresentationFrame()
      setRenderState("pendingFinalTextVersion", target)
    }
    if (target && !sameTextRenderVersion(target, renderState.renderedFinalTextVersion)) return

    // 即使当前版本早已绘制，也要从 runtime 终态后重新等待双帧静默期，吸收排在 idle 后面的最后 delta。
    // 没有最终 Markdown 的工具、图片和错误回合同样走这里，保证完成内容至少真实绘制一次。
    releasePresentationAfterPaint(target)
  })

  const onFinalTextRendered = (input: TextRenderVersion) => {
    // 历史回合首次挂载不参与运行态；只记录当前真实运行或它留下的展示结算窗口。
    if (!runtimeWorking() && !renderState.runObserved) return
    setRenderState("renderedFinalTextVersion", input)
  }

  onCleanup(clearPresentationFrame)

  // 用户看到的回合状态以“运行中或最终展示尚未确认”为准，后端 idle 仍可独立驱动队列和其它会话。
  const working = createMemo(() => runtimeWorking() || renderState.runObserved)
  // 压缩分割线随进度切换时态：压缩进行中显示「正在压缩会话…」，完成后才显示「会话已压缩」。
  // 时态只看压缩摘要自身是否收尾——overflow 自动压缩与后续续跑共享同一回合，
  // 绑整回合 working 会让 divider 在续跑的几小时里一直卡在进行时。
  const divider = createMemo(() => {
    const part = compaction()
    if (!part) return ""
    if (!working() || compactionFinished(allMessages(), part.messageID)) {
      return i18n.t("ui.messagePart.compaction")
    }
    return i18n.t("ui.messagePart.compacting")
  })
  const showReasoningSummaries = createMemo(() => props.showReasoningSummaries ?? true)

  const assistantCopyPartID = createMemo(() => {
    if (working()) return null
    return showAssistantCopyPartID() ?? null
  })
  // 计时起点取「本回合最后一段连续活动的起点」，而非 user 消息创建时刻：
  // 会话暂停（app 关闭）/目标模式长时间续跑会在时间线上留下大间隔，
  // 从最初 user 消息算会把闲置时间也计入，显示成 7227m/2459m 这类异常值。
  const turnStartMs = createMemo(() => {
    const created = message()?.time.created
    if (typeof created !== "number") return undefined
    // 每个 assistant 步都是独立消息；finish==="tool-calls" 的步之后的大空档是工具在跑（非闲置）。
    return effectiveTurnStart([
      { created, toolLoopContinues: false },
      ...assistantMessages().map((item) => ({
        created: item.time.created,
        toolLoopContinues: item.finish === "tool-calls",
      })),
    ])
  })
  const turnDurationMs = createMemo(() => {
    const start = turnStartMs()
    if (typeof start !== "number") return undefined

    const end = assistantMessages().reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)

    if (typeof end !== "number") return undefined
    if (end < start) return undefined
    return end - start
  })

  // 复刻 Codex：用户中断后轮末显示右对齐「你在 {duration} 后停止了」提示（无时长数据时退化为「已中断」）
  const stoppedLabel = createMemo(() => {
    const ms = turnDurationMs()
    return ms === undefined
      ? i18n.t("ui.message.interrupted")
      : i18n.t("ui.message.stoppedAfter", { duration: formatDuration(ms) })
  })

  // —— 整 user turn 末尾工具条所需信息 ——
  // Copy 读取最终 TextPart；时间与 Fork 必须锚定响应段末端，避免漏掉最终正文之后的物理 assistant 成员。
  const lastAssistantMessage = createMemo(() => latestAssistant() ?? currentAssistantMessages().at(-1))
  // 仅显示该 turn 最后一条 assistant 的完成时间（fallback 到创建时间）
  const turnFooterTimeFmt = createMemo(
    () =>
      new Intl.DateTimeFormat(i18n.locale(), {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: false,
      }),
  )
  const turnFooterMeta = createMemo(() => {
    const m = lastAssistantMessage()
    if (!m) return ""
    const ts = typeof m.time.completed === "number" ? m.time.completed : m.time.created
    if (typeof ts !== "number") return ""
    const stamp = turnFooterTimeFmt().format(new Date(ts))
    return interrupted() ? `${stamp} · ${i18n.t("ui.message.interrupted")}` : stamp
  })
  const turnAssistantText = createMemo(() => {
    // Copy/Fork 工具条和屏幕上最终回复保持同一选择规则，不能把 steer 前的中间文本再次拼入。
    return finalTextSelection()?.part.text.trim() ?? ""
  })
  const [turnCopied, setTurnCopied] = createSignal(false)
  const onTurnFooterCopy = async () => {
    const content = turnAssistantText()
    if (!content) return
    await navigator.clipboard.writeText(content)
    setTurnCopied(true)
    setTimeout(() => setTurnCopied(false), 2000)
  }
  const onTurnFooterFork = () => {
    const m = lastAssistantMessage()
    const act = props.actions?.fork
    if (!m || !act) return
    void Promise.resolve(act({ sessionID: props.sessionID, messageID: m.id }))
  }
  const turnFooterVisible = createMemo(() => !!lastAssistantMessage() && !working() && !!turnAssistantText())
  const assistantDerived = createMemo(() => {
    let visible = 0
    let reason: string | undefined
    const show = showReasoningSummaries()
    for (const message of assistantMessages()) {
      for (const part of messageParts(message.id)) {
        if (partState(part, show) === "visible") {
          visible++
        }
        if (part.type === "reasoning" && part.text) {
          const h = heading(part.text)
          if (h) reason = h
        }
      }
    }
    return { visible, reason }
  })
  const currentAssistantVisible = createMemo(() => {
    const show = showReasoningSummaries()
    return currentAssistantMessages().reduce(
      (visible, message) =>
        visible + messageParts(message.id).filter((part) => partState(part, show) === "visible").length,
      0,
    )
  })
  const reasoningHeading = createMemo(() => assistantDerived().reason)
  const showThinking = createMemo(() => {
    if (!working() || !!error()) return false
    if (status().type === "retry") return false
    return true
  })

  // 以 now 信号驱动计时显示；用自校正 setTimeout 对齐到相对 start 的整秒边界，
  // 避免 setInterval 漂移 / 后台节流导致取整后跳秒或停顿
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!working()) return
    setNow(Date.now())
    let timer = 0
    const schedule = () => {
      const start = turnStartMs() ?? Date.now()
      const msToNextSecond = 1000 - ((Date.now() - start) % 1000)
      timer = window.setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, msToNextSecond)
    }
    schedule()
    onCleanup(() => window.clearTimeout(timer))
  })

  const thinkingMs = createMemo(() => {
    // 官方只有一个 turn 级活动容器；连续 steer 不重置“已处理”计时，也不能制造第二个处理回合。
    const start = turnStartMs()
    if (typeof start !== "number") return undefined
    if (working()) return now() - start
    const end = turnDurationMs()
    if (typeof end === "number") return end
    return undefined
  })
  const thinkingLabel = createMemo(() => {
    const label = error() ? i18n.t("ui.messagePart.diagnostic.error") : working() ? "处理中" : "已处理"
    const ms = thinkingMs()
    if (ms === undefined) return label
    return `${label} ${formatDuration(ms)}`
  })

  const processedThinkingVisible = createMemo(() => {
    const show = showReasoningSummaries()
    // 所有响应段共用一个处理组；仅当前响应段最终抽到底部的 TextPart 从活动链排除。
    return assistantMessages().some((message) => {
      const parts = messageParts(message.id)
      return parts.some(
        (part) => processedThinkingPart(part, finalAssistantTextPartID()) && partState(part, show) === "visible",
      )
    })
  })

  const thinkingGroupVisible = createMemo(() => {
    // 压缩是内部操作：纯压缩回合（手动 /compact，无其他真实活动）只用分割线表达「正在压缩→已压缩」，
    // 不展示压缩摘要 agent 的 reasoning / 计时等内部产物。失败摘要虽保留在活动里（供错误卡片取 error），
    // 但不算真实活动，否则失败时内部 reasoning 会漏进思考组并与错误卡片双显。
    // overflow 自动压缩并回原回合时，回合里还有压缩前后的真实工作，绝不能整组隐藏。
    const realActivity = activityMembers().some(
      (member) => member.type !== "assistant" || member.message.summary !== true,
    )
    if (compaction() && !realActivity) return false
    if (working()) return true
    if (processedThinkingVisible()) return true
    if (steeringMessages().length > 0 && (working() || assistantMessages().length > 0)) return true
    if (edited() > 0) return true
    if (status().type === "retry") return true
    return false
  })
  const thinkingHeaderVisible = createMemo(() => {
    // 只有 steer 气泡而没有真实处理活动时不显示“已处理”，但气泡仍由 persistent 区域保留。
    if (!working() && !processedThinkingVisible() && steeringMessages().length > 0) return false
    return true
  })

  // 思考组内是否存在被翻译过的推理（originalText 有内容）：决定是否显示组级「显示原文」按钮
  const hasReasoningOriginal = createMemo(() => {
    for (const message of assistantMessages()) {
      const parts = messageParts(message.id)
      for (const part of parts) {
        if (part?.type === "reasoning" && !!(part as any).originalText?.trim()) return true
      }
    }
    return false
  })
  // 组级「显示原文」总开关：整组共用，传给组内所有 reasoning part
  const [reasoningShowOriginal, setReasoningShowOriginal] = createSignal(false)

  // 历史回合默认折叠；活动回合展开供用户观察，真正结束后在不打断阅读的前提下自动收起。
  const [thinkingOpen, setThinkingOpen] = createSignal(false)
  let thinkingContentRef: HTMLDivElement | undefined
  createEffect(
    on(working, (next, previous) => {
      if (next) {
        setThinkingOpen(true)
        return
      }
      // 初次挂载的历史回合已经默认折叠；只有真实经历运行→完成的回合才触发自动收起。
      if (previous !== true) return
      collapseThinkingWithViewport({
        viewport: props.scrollContainer?.(),
        content: thinkingContentRef,
        collapse: () => setThinkingOpen(false),
      })
    }),
  )

  const editedToolFiles = createMemo(() => {
    const files = new Set<string>()
    for (const message of assistantMessages()) {
      const parts = messageParts(message.id)
      for (const part of parts) {
        if (!part || part.type !== "tool") continue
        const tool = (part as any).tool as string | undefined
        if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") continue
        const input = ((part as any).state?.input ?? {}) as Record<string, unknown>
        const filePath = typeof input.filePath === "string" ? input.filePath : undefined
        if (filePath) files.add(filePath)
      }
    }
    return Array.from(files)
  })

  const mdDiffs = createMemo(() => diffs().filter((d) => d.file.toLowerCase().endsWith(".md")))
  const otherDiffs = createMemo(() => diffs().filter((d) => !d.file.toLowerCase().endsWith(".md")))
  const showEditSummaryBelowFinal = createMemo(() => {
    if (working()) return false
    // 文件变更是已结束回合的独立产物；即使模型没有输出最终正文，也要保留统一的完成态卡片样式。
    return edited() > 0 || editedToolFiles().length > 0
  })
  const showOtherDiffSummaryBelowMd = createMemo(() => mdDiffs().length > 0 && otherDiffs().length > 0)
  const currentAssistantHasRenderableContent = createMemo(
    () =>
      currentAssistantVisible() > 0 ||
      assistantHasMainChatPart() ||
      assistantHasGeneratedImages() ||
      currentUserMessages().some((message) => (message.summary?.diffs?.length ?? 0) > 0),
  )
  const showStandaloneError = createMemo(() => !!error() && !currentAssistantHasRenderableContent())
  const showEmptyAssistantResponse = createMemo(
    () =>
      !working() &&
      !error() &&
      !interrupted() &&
      currentAssistantMessages().length > 0 &&
      !currentAssistantHasRenderableContent() &&
      // 仅当模型真正以终止原因收尾却没有可显示内容时才提示「空回复」；被截断（无 finish）的
      // 半成品——用户暂停/停止、被动中断（崩溃重启）——不能误显示成「空回复，请重试或切换模型」。
      assistantEndedWithResponse(latestAssistant()),
  )

  const toolFileDiffs = createMemo(() => {
    const out: Array<{
      file: string
      patch?: string
      additions: number
      deletions: number
      before?: string
      after?: string
      status?: "added" | "deleted" | "modified"
    }> = []

    for (const message of assistantMessages()) {
      const parts = messageParts(message.id)
      for (const part of parts) {
        if (!part || part.type !== "tool") continue
        const tool = (part as any).tool as string | undefined
        if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") continue

        const filediff = (((part as any).state?.metadata as any)?.filediff ?? undefined) as
          | {
              file?: string
              patch?: string
              additions?: number
              deletions?: number
              before?: string
              after?: string
              status?: "added" | "deleted" | "modified"
            }
          | undefined
        const file = (filediff?.file ?? (part as any).state?.input?.filePath ?? "").toString()
        if (!file) continue
        out.push({
          file,
          patch: typeof filediff?.patch === "string" ? filediff.patch : undefined,
          additions: typeof filediff?.additions === "number" ? filediff.additions : 0,
          deletions: typeof filediff?.deletions === "number" ? filediff.deletions : 0,
          before: typeof filediff?.before === "string" ? filediff.before : undefined,
          after: typeof filediff?.after === "string" ? filediff.after : undefined,
          status:
            filediff?.status === "added" || filediff?.status === "deleted" || filediff?.status === "modified"
              ? filediff.status
              : undefined,
        })
      }
    }

    // de-dupe by file, keep latest
    const seen = new Set<string>()
    const uniq: typeof out = []
    for (let i = out.length - 1; i >= 0; i--) {
      const item = out[i]
      if (seen.has(item.file)) continue
      seen.add(item.file)
      uniq.push(item)
    }
    uniq.reverse()
    return uniq
  })

  const addedToolFiles = createMemo(() => {
    const files = new Set<string>()

    for (const message of assistantMessages()) {
      const parts = messageParts(message.id)
      for (const part of parts) {
        if (!part || part.type !== "tool") continue
        const tool = (part as any).tool as string | undefined
        if (tool !== "edit" && tool !== "write" && tool !== "apply_patch") continue

        const metadata = record((part as any).state?.metadata) ? (part as any).state.metadata : undefined
        const diff = record(metadata?.filediff) ? metadata?.filediff : undefined
        if (diff?.status === "added" && typeof diff.file === "string") {
          files.add(diffPathKey(diff.file))
        }

        const entries = Array.isArray(metadata?.files) ? metadata.files : []
        for (const entry of entries) {
          if (!record(entry) || entry.type !== "add") continue
          if (typeof entry.relativePath === "string") files.add(diffPathKey(entry.relativePath))
          if (typeof entry.filePath === "string") files.add(diffPathKey(entry.filePath))
        }
      }
    }

    return files
  })

  const finalReviewDiffs = createMemo(() => {
    const s = diffs()
    const localOverlay = [...storedSessionDiffs(), ...toolFileDiffs()]
    if (s.length > 0) {
      return mergeDiffsWithOverlay(s as any[], localOverlay as any[], {
        workspaceRoot: props.diffOverlayWorkspaceRoot?.(),
      })
    }
    const stored = storedSessionDiffs()
    if (stored.length > 0) return stored as any[]
    return toolFileDiffs() as any[]
  })

  const mergedFinalReviewDiffs = createMemo(() =>
    mergeDiffsWithOverlay(finalReviewDiffs(), props.diffOverlay?.() ?? [], {
      workspaceRoot: props.diffOverlayWorkspaceRoot?.(),
    }),
  )

  const FINAL_DIFF_INITIAL_LIMIT = 40
  const FINAL_DIFF_BATCH = 40
  const FINAL_DIFF_HOVER_LIMIT = 12
  const FINAL_DIFF_AUTO_COLLAPSE_THRESHOLD = 80
  const [finalDiffLimit, setFinalDiffLimit] = createSignal(FINAL_DIFF_INITIAL_LIMIT)
  const visibleFinalReviewDiffs = createMemo(() => mergedFinalReviewDiffs().slice(0, finalDiffLimit()))
  const hoverFinalReviewDiffs = createMemo(() => mergedFinalReviewDiffs().slice(0, FINAL_DIFF_HOVER_LIMIT))
  const remainingFinalReviewDiffs = createMemo(() =>
    Math.max(0, mergedFinalReviewDiffs().length - visibleFinalReviewDiffs().length),
  )

  const totalChanges = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const d of mergedFinalReviewDiffs()) {
      additions += typeof d.additions === "number" ? d.additions : 0
      deletions += typeof d.deletions === "number" ? d.deletions : 0
    }
    return { additions, deletions }
  })

  const showDiffAccordion = createMemo(() => mergedFinalReviewDiffs().length > 0)
  const [finalDiffDisclosure, setFinalDiffDisclosure] = createSignal<"auto" | "open" | "closed">("auto")
  const finalDiffsOpen = createMemo(() => {
    const disclosure = finalDiffDisclosure()
    if (disclosure === "open") return true
    if (disclosure === "closed") return false
    // 小列表保持原有默认展开；超长列表先收起，避免回复完成瞬间挂载数万节点并锁死页面。
    return mergedFinalReviewDiffs().length <= FINAL_DIFF_AUTO_COLLAPSE_THRESHOLD
  })
  const toggleFinalDiffs = () => {
    const closing = finalDiffsOpen()
    setFinalDiffDisclosure(closing ? "closed" : "open")
    // 收起时丢弃已经展开的批次；再次打开始终从轻量首批开始。
    if (closing) setFinalDiffLimit(FINAL_DIFF_INITIAL_LIMIT)
  }
  const onFinalDiffsChange = (value: string | string[]) => {
    const next = Array.isArray(value) ? value : value ? [value] : []
    const opened = next.find((file) => !expandedFinal().includes(file))
    const selected = opened ? mergedFinalReviewDiffs().find((item) => item.file === opened) : undefined
    if (
      selected &&
      props.actions?.openReviewPanel &&
      sessionReviewDiffNeedsFullLoad(selected, mergedFinalReviewDiffs().length)
    ) {
      // compact 摘要没有正文时转入审核页，现有 session.diff 请求会按需取得完整 patch，不能展示空白差异。
      onEditSummaryReview()
      return
    }
    setState("expandedFinal", next)
  }
  let editDiffListRef: HTMLDivElement | undefined
  const [editDiffListOverflowing, setEditDiffListOverflowing] = createSignal(false)
  const [editDiffScrollMetrics, setEditDiffScrollMetrics] = createStore({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  })
  let editDiffArrowClickTimer: ReturnType<typeof setTimeout> | undefined
  let editDiffThumbDrag:
    | { startY: number; startScrollTop: number; maxScrollTop: number; maxThumbTop: number; track: number }
    | undefined
  let editDiffThumbPointerCleanup: (() => void) | undefined
  const [editDiffThumbDragging, setEditDiffThumbDragging] = createSignal(false)

  const clearEditDiffArrowTimer = () => {
    if (editDiffArrowClickTimer === undefined) return
    clearTimeout(editDiffArrowClickTimer)
    editDiffArrowClickTimer = undefined
  }

  const stopEditDiffThumbDrag = () => {
    editDiffThumbPointerCleanup?.()
    editDiffThumbPointerCleanup = undefined
    editDiffThumbDrag = undefined
    setEditDiffThumbDragging(false)
  }

  const resetEditDiffScrollInteraction = () => {
    clearEditDiffArrowTimer()
    stopEditDiffThumbDrag()
  }

  onCleanup(resetEditDiffScrollInteraction)

  const syncEditDiffListOverflow = () => {
    const el = editDiffListRef
    if (!el || !el.isConnected) {
      setEditDiffListOverflowing(false)
      return
    }
    // 先读后写且写挪到微任务：会话切换时所有 turn 的 ResizeObserver 同帧触发，
    // 若读写交错，前一个 turn 的信号写会让下一个 turn 的布局读强制回流（实测百 ms 级）
    const overflowing = editDiffListOverflow(el)
    const metrics = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
    queueMicrotask(() =>
      batch(() => {
        setEditDiffListOverflowing(overflowing)
        setEditDiffScrollMetrics(metrics)
      }),
    )
  }

  const revealMoreFinalDiffs = () => {
    // 每次只追加固定批次，用户仍能逐步查看全部文件，但单次交互不会把上千行同时塞进 DOM。
    setFinalDiffLimit((limit) => Math.min(mergedFinalReviewDiffs().length, limit + FINAL_DIFF_BATCH))
    requestAnimationFrame(syncEditDiffListOverflow)
  }

  const editDiffScrollbarThumbStyle = createMemo(() => {
    const metrics = editDiffThumbMetrics(
      editDiffScrollMetrics.scrollHeight,
      editDiffScrollMetrics.clientHeight,
      editDiffScrollMetrics.scrollTop,
    )
    if (!metrics) return undefined

    return {
      height: `${metrics.thumb}px`,
      transform: `translateY(${metrics.top}px)`,
    }
  })

  const onEditDiffThumbPointerDown = (event: PointerEvent) => {
    const el = editDiffListRef
    const thumb = event.currentTarget
    if (!el || !el.isConnected || !(thumb instanceof HTMLDivElement)) return

    const metrics = editDiffThumbMetrics(el.scrollHeight, el.clientHeight, el.scrollTop)
    if (!metrics) return

    event.preventDefault()
    event.stopPropagation()
    stopEditDiffThumbDrag()

    const pointerId = event.pointerId
    editDiffThumbDrag = {
      startY: event.clientY,
      startScrollTop: el.scrollTop,
      maxScrollTop: el.scrollHeight - el.clientHeight,
      maxThumbTop: metrics.maxTop,
      track: metrics.track,
    }
    setEditDiffThumbDragging(true)
    thumb.setPointerCapture(pointerId)

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (!editDiffThumbDrag || !editDiffListRef || !editDiffListRef.isConnected) return
      const travel = editDiffThumbDrag.maxThumbTop > 0 ? editDiffThumbDrag.maxThumbTop : editDiffThumbDrag.track
      if (travel <= 0) return
      const deltaY = moveEvent.clientY - editDiffThumbDrag.startY
      const scrollDelta = deltaY * (editDiffThumbDrag.maxScrollTop / travel)
      const next = editDiffThumbDrag.startScrollTop + scrollDelta
      editDiffListRef.scrollTop = Math.max(0, Math.min(next, editDiffThumbDrag.maxScrollTop))
    }

    const onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      stopEditDiffThumbDrag()
    }

    const onLostPointerCapture = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId !== pointerId) return
      stopEditDiffThumbDrag()
    }

    editDiffThumbPointerCleanup = () => {
      thumb.removeEventListener("pointermove", onPointerMove)
      thumb.removeEventListener("pointerup", onPointerEnd)
      thumb.removeEventListener("pointercancel", onPointerEnd)
      thumb.removeEventListener("lostpointercapture", onLostPointerCapture)
      if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId)
    }

    thumb.addEventListener("pointermove", onPointerMove)
    thumb.addEventListener("pointerup", onPointerEnd)
    thumb.addEventListener("pointercancel", onPointerEnd)
    thumb.addEventListener("lostpointercapture", onLostPointerCapture)
  }

  const onEditDiffTrackPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return

    const track = event.currentTarget
    const el = editDiffListRef
    if (!el || !el.isConnected || !(track instanceof HTMLDivElement)) return

    const metrics = editDiffThumbMetrics(el.scrollHeight, el.clientHeight, el.scrollTop)
    if (!metrics) return

    const trackRect = track.getBoundingClientRect()
    if (trackRect.height <= 0) return

    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
    if (maxScrollTop <= 0) return

    const clickY = event.clientY - trackRect.top
    const clickYInMetrics = trackRect.height > 0 ? clickY * (metrics.track / trackRect.height) : clickY
    const onThumb =
      clickYInMetrics >= metrics.top - EDIT_DIFF_THUMB_HIT_SLOP &&
      clickYInMetrics <= metrics.top + metrics.thumb + EDIT_DIFF_THUMB_HIT_SLOP

    if (onThumb && metrics.maxTop > 0) return

    event.preventDefault()

    if (onThumb) {
      const mid = trackRect.height / 2
      el.scrollTop =
        clickY < mid
          ? Math.max(0, el.scrollTop - el.clientHeight)
          : Math.min(maxScrollTop, el.scrollTop + el.clientHeight)
      syncEditDiffListOverflow()
      return
    }

    const ratio = Math.max(0, Math.min(1, clickY / trackRect.height))
    el.scrollTop = ratio * maxScrollTop
    syncEditDiffListOverflow()
  }

  const scrollEditDiffList = (position: "top" | "bottom") => {
    const el = editDiffListRef
    if (!el || !el.isConnected) return
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTo({ top: position === "top" ? 0 : maxTop, behavior: "smooth" })
  }

  const onEditDiffListKeyDown = (event: KeyboardEvent) => {
    const el = editDiffListRef
    if (!el || !el.isConnected) return

    if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return

    const next = scrollKey(event)
    if (!next) return

    const scrollAmount = el.clientHeight * 0.8

    switch (next) {
      case "page-down":
        event.preventDefault()
        el.scrollBy({ top: scrollAmount, behavior: "smooth" })
        break
      case "page-up":
        event.preventDefault()
        el.scrollBy({ top: -scrollAmount, behavior: "smooth" })
        break
      case "home":
        event.preventDefault()
        el.scrollTo({ top: 0, behavior: "smooth" })
        break
      case "end":
        event.preventDefault()
        el.scrollTo({ top: Math.max(0, el.scrollHeight - el.clientHeight), behavior: "smooth" })
        break
      case "up":
        event.preventDefault()
        el.scrollBy({ top: -EDIT_DIFF_SCROLL_LINE, behavior: "smooth" })
        break
      case "down":
        event.preventDefault()
        el.scrollBy({ top: EDIT_DIFF_SCROLL_LINE, behavior: "smooth" })
        break
    }
  }

  const onEditDiffScrollbarArrowClick = (direction: "up" | "down") => {
    clearEditDiffArrowTimer()
    editDiffArrowClickTimer = setTimeout(() => {
      editDiffArrowClickTimer = undefined
      const el = editDiffListRef
      if (!el || !el.isConnected) return
      el.scrollBy({ top: direction === "up" ? -EDIT_DIFF_SCROLL_LINE : EDIT_DIFF_SCROLL_LINE, behavior: "auto" })
    }, 200)
  }

  const onEditDiffScrollbarArrowDblClick = (direction: "up" | "down") => {
    clearEditDiffArrowTimer()
    scrollEditDiffList(direction === "up" ? "top" : "bottom")
  }

  createEffect(
    on([finalDiffsOpen, showDiffAccordion], ([open, accordion]) => {
      if (!open || !accordion) {
        resetEditDiffScrollInteraction()
        setEditDiffListOverflowing(false)
        return
      }
      requestAnimationFrame(syncEditDiffListOverflow)
    }),
  )

  createEffect(
    on([mergedFinalReviewDiffs, () => state.expandedFinal], () => {
      if (!finalDiffsOpen()) return
      requestAnimationFrame(syncEditDiffListOverflow)
    }),
  )

  createResizeObserver(
    () => [editDiffListRef, editDiffListRef?.firstElementChild].filter(Boolean) as Element[],
    () => syncEditDiffListOverflow(),
  )

  const featuredFile = createMemo(() => {
    // 优先级：markdown 文档 > 可直接打开的 HTML 入口(index.html 最优) > 改动最大的文件。
    // featured 卡的「打开」对 .html 会用浏览器打开并标注为「网站」，因此网页项目应展示入口
    // 文件而非改动行数最多的文件（后者常是体量更大的 JS）。
    // featured 卡是「打开我刚做的产物」：被删除的文件、或纯删除(无新增内容)的文件都不能作为可打开对象。
    // 判据用 status!=="deleted" 且 additions>0——status 对删除不一定可靠，additions>0 兜底纯删除轮。
    const openable = (item: { status?: string; additions?: number }) =>
      item.status !== "deleted" && (typeof item.additions === "number" ? item.additions : 0) > 0
    const md = mdDiffs().filter(openable)
    if (md.length > 0) return { file: md[0].file }

    const allDiffs = diffs()
    const all = allDiffs.filter(openable)
    if (all.length > 0) {
      const score = (item: (typeof all)[number]) => {
        const a = typeof (item as any).additions === "number" ? (item as any).additions : 0
        const d = typeof (item as any).deletions === "number" ? (item as any).deletions : 0
        return a + d
      }
      const htmls = all.filter((item) => /\.html?$/i.test(item.file))
      if (htmls.length > 0) {
        const index = htmls.find((item) => /(^|\/)index\.html?$/i.test(item.file))
        if (index) return { file: index.file }
      }
      const pool = htmls.length > 0 ? htmls : all
      let best = pool[0]
      let bestScore = -1
      for (const item of pool) {
        const s = score(item)
        if (s >= bestScore) {
          best = item
          bestScore = s
        }
      }
      return { file: best.file }
    }

    // 有改动但全是删除 → 没有可打开的产物，不展示 featured 卡（否则「打开」一个已删除文件会失败）
    if (allDiffs.length > 0) return undefined

    const toolFiles = editedToolFiles()
    if (toolFiles.length > 0) return { file: toolFiles[0] }
    return undefined
  })

  const featuredMeta = createMemo(() => {
    const file = featuredFile()?.file
    if (!file) return ""
    const ext = getFilename(file).split(".").pop()?.toUpperCase() ?? ""
    if (file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm"))
      return i18n.t("ui.sessionTurn.editSummary.meta.website")
    if (file.toLowerCase().endsWith(".md"))
      return i18n.t("ui.sessionTurn.editSummary.meta.document", { ext: ext || "MD" })
    return i18n.t("ui.sessionTurn.editSummary.meta.file", { ext: ext || "?" })
  })

  const editedSummaryTitle = createMemo(() =>
    i18n.t("ui.sessionTurn.editSummary.editedFiles", {
      count: String(mergedFinalReviewDiffs().length),
    }),
  )

  const editSummaryUndoDisabled = createMemo(() => {
    if (!props.actions?.revert) return true
    if (!props.actions.canRevertEditSummary?.(props.messageID)) return true
    if (props.actions.sessionBusy?.()) return true
    if (props.actions.editSummaryRevertPending?.()) return true
    return false
  })

  const editSummaryReviewDisabled = createMemo(() => !props.actions?.openReviewPanel)
  const [editDiffContextPath, setEditDiffContextPath] = createSignal("")
  const [editDiffContextPosition, setEditDiffContextPosition] = createSignal({ x: 0, y: 0 })
  const [editDiffContextOpen, setEditDiffContextOpen] = createSignal(false)

  const onEditSummaryUndo = () => {
    const act = props.actions?.revert
    if (!act || editSummaryUndoDisabled()) return
    void Promise.resolve(act({ sessionID: props.sessionID, messageID: props.messageID }))
  }

  const onEditSummaryReview = () => {
    void props.actions?.openReviewPanel?.("turn")
  }

  const resolveFilePath = (filePath: string) => resolveWorkspaceFilePath(data.directory, filePath)

  const onEditDiffContextMenu = (event: MouseEvent, filePath: string) => {
    if (!data.fileContextMenuActions) return
    event.preventDefault()
    event.stopPropagation()
    setEditDiffContextPath(resolveFilePath(filePath))
    setEditDiffContextPosition({ x: event.clientX, y: event.clientY })
    setEditDiffContextOpen(true)
  }

  const openProjectPath = async (filePath: string) => {
    const absolute = resolveFilePath(filePath)
    if (isHtmlFilePath(absolute) && data.openExternalLink) {
      await data.openExternalLink(fileUrlFromAbsolutePath(absolute))
      return
    }
    const api = (globalThis as any).api as { openPath?: (path: string) => Promise<void> } | undefined
    if (!api?.openPath) return
    await api.openPath(absolute)
  }

  const renderSteeringMessage = (steering: Extract<MessageType, { role: "user" }>) => (
    <div id={props.messageAnchor?.(steering.id)} data-slot="session-turn-steering-message" data-message={steering.id}>
      {props.beforeSteeringMessage?.(steering.id)}
      <Message message={steering} parts={messageParts(steering.id)} actions={props.actions} />
      {props.afterSteeringMessage?.(steering.id)}
    </div>
  )

  const historicalActivityPart = (part: PartType) => {
    // steer 前的 assistant 仍是用户可见历史；旧 final 文本、图片和自动化卡片不能因新 steer 被吞掉。
    if (part.type === "text") return assistantTextPartInActivity(part)
    return partState(part, showReasoningSummaries()) === "visible"
  }

  const activityPart = (messageID: string, part: PartType) => {
    // segment 只用于终态归属；历史响应仍在同一个活动容器原位展示，不能被拆成新的“已处理”组。
    if (!currentActivityMessageIDs().has(messageID)) return historicalActivityPart(part)
    // 当前最终交付所属 assistant 的图片/卡片由底部最终区渲染；更早物理 assistant 的内容仍留在时间线。
    if (messageID !== finalAnswerAssistant()?.id && mainChatAssistantPart(part))
      return partState(part, showReasoningSummaries()) === "visible"
    return processedThinkingPart(part, finalAssistantTextPartID(), working())
  }

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
    overflowAnchor: "auto",
  })

  return (
    <div
      data-component="session-turn"
      data-active={active() ? "true" : "false"}
      // 供 CSS 豁免最新轮的虚拟化：回合结束 data-active 翻成 false 的同一帧套用
      // contain-intrinsic-size 会让这一轮当场塌到估值高度。见 message-part.css。
      data-latest={props.isLatestUserTurn ? "true" : undefined}
      class={props.classes?.root}
    >
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            <div
              ref={autoScroll.contentRef}
              data-message={message()!.id}
              data-slot="session-turn-message-container"
              class={props.classes?.container}
            >
              <div data-slot="session-turn-message-content" aria-live="off">
                <Message message={message()!} parts={parts()} actions={props.actions} />
              </div>
              {props.afterUserContent}
              <Show when={divider()}>
                <div data-slot="session-turn-compaction">
                  <MessageDivider label={divider()} />
                </div>
              </Show>
              <Show when={thinkingGroupVisible()}>
                <Collapsible
                  open={thinkingOpen()}
                  onOpenChange={setThinkingOpen}
                  variant="ghost"
                  class="tool-collapsible"
                  data-scope="reasoning"
                >
                  <Show when={thinkingHeaderVisible()}>
                    <Collapsible.Trigger>
                      <div data-slot="session-turn-thinking-trigger">
                        <span data-slot="session-turn-thinking-summary">
                          <span data-slot="session-turn-thinking-label" class="cursor-default">
                            {thinkingLabel()}
                          </span>
                          <Collapsible.Arrow />
                        </span>
                      </div>
                    </Collapsible.Trigger>
                  </Show>
                  <Show when={thinkingHeaderVisible()}>
                    <Collapsible.Content>
                      <div ref={thinkingContentRef} data-slot="session-turn-thinking-content">
                        <ReasoningOriginalContext.Provider value={reasoningShowOriginal}>
                          <Show when={hasReasoningOriginal() && !working()}>
                            <button
                              type="button"
                              data-slot="reasoning-original-toggle"
                              onClick={() => setReasoningShowOriginal((v) => !v)}
                            >
                              {reasoningShowOriginal()
                                ? i18n.t("ui.reasoning.hideOriginal")
                                : i18n.t("ui.reasoning.showOriginal")}
                            </button>
                          </Show>
                          <Show when={activityMembers().length > 0}>
                            <div
                              data-slot="session-turn-assistant-content"
                              aria-hidden={working() && steeringMessages().length === 0}
                            >
                              <For each={activityMembers()}>
                                {(member) => (
                                  <Show
                                    when={member.type === "assistant"}
                                    fallback={
                                      // 官方展开时把 steer 放在 expandedUnits 原位；折叠动画期间由 persistent 副本接管。
                                      member.type === "steering" && thinkingOpen()
                                        ? renderSteeringMessage(member.message)
                                        : undefined
                                    }
                                  >
                                    <AssistantParts
                                      messages={member.type === "assistant" ? [member.message] : emptyAssistant}
                                      showAssistantCopyPartID={assistantCopyPartID()}
                                      turnDurationMs={turnDurationMs()}
                                      working={
                                        member.type === "assistant" &&
                                        working() &&
                                        member.message.id === activeActivityMessageID()
                                      }
                                      showReasoningSummaries={showReasoningSummaries()}
                                      includeText={true}
                                      partFilter={(part) => activityPart(member.message.id, part)}
                                      shellToolDefaultOpen={props.shellToolDefaultOpen}
                                      editToolDefaultOpen={props.editToolDefaultOpen}
                                      actions={props.actions}
                                    />
                                  </Show>
                                )}
                              </For>
                            </div>
                          </Show>

                          <SessionRetry status={status()} show={active()} />

                          <Show when={edited() > 0 && !working() && !showEditSummaryBelowFinal()}>
                            <div
                              data-slot="session-turn-diffs"
                              data-component="session-turn-diffs-group"
                              data-show-all={showAll() || undefined}
                            >
                              <div data-slot="session-turn-diffs-header">
                                <span data-slot="session-turn-diffs-label">
                                  {edited()} {i18n.t("ui.sessionTurn.diffs.changed")}{" "}
                                  {i18n.t(edited() === 1 ? "ui.common.file.one" : "ui.common.file.other")}
                                </span>
                                <DiffChanges changes={diffs()} />
                                <Show when={overflow() > 0}>
                                  <span data-slot="session-turn-diffs-toggle" onClick={toggleAll}>
                                    {showAll()
                                      ? i18n.t("ui.sessionTurn.diffs.showLess")
                                      : i18n.t("ui.sessionTurn.diffs.showAll")}
                                  </span>
                                </Show>
                              </div>
                              <div data-component="session-turn-diffs-content">
                                <Accordion
                                  multiple
                                  style={{ "--sticky-accordion-offset": "44px" }}
                                  value={expandedThinking()}
                                  onChange={(value) =>
                                    setState("expandedThinking", Array.isArray(value) ? value : value ? [value] : [])
                                  }
                                >
                                  <For each={visible()}>
                                    {(diff) => {
                                      const view = normalize(diff)
                                      const active = createMemo(() => expandedThinking().includes(diff.file))
                                      const [shown, setShown] = createSignal(false)

                                      createEffect(
                                        on(
                                          active,
                                          (value) => {
                                            if (!value) {
                                              setShown(false)
                                              return
                                            }

                                            requestAnimationFrame(() => {
                                              if (!active()) return
                                              setShown(true)
                                            })
                                          },
                                          { defer: true },
                                        ),
                                      )

                                      return (
                                        <Accordion.Item value={diff.file}>
                                          <StickyAccordionHeader>
                                            <Accordion.Trigger>
                                              <div data-slot="session-turn-diff-trigger">
                                                <span data-slot="session-turn-diff-path">
                                                  <Show when={diff.file.includes("/")}>
                                                    <span data-slot="session-turn-diff-directory">
                                                      {`\u202A${getDirectory(diff.file)}\u202C`}
                                                    </span>
                                                  </Show>
                                                  <span data-slot="session-turn-diff-filename">
                                                    {getFilename(diff.file)}
                                                  </span>
                                                </span>
                                                <div data-slot="session-turn-diff-meta">
                                                  <span data-slot="session-turn-diff-changes">
                                                    <DiffChanges changes={diff} />
                                                  </span>
                                                  <span data-slot="session-turn-diff-chevron">
                                                    <Icon name="chevron-down" size="small" />
                                                  </span>
                                                </div>
                                              </div>
                                            </Accordion.Trigger>
                                          </StickyAccordionHeader>
                                          <Accordion.Content>
                                            <Show when={shown()}>
                                              <div data-slot="session-turn-diff-view" data-scrollable>
                                                <Dynamic
                                                  component={fileComponent}
                                                  mode="diff"
                                                  fileDiff={view.fileDiff}
                                                />
                                              </div>
                                            </Show>
                                          </Accordion.Content>
                                        </Accordion.Item>
                                      )
                                    }}
                                  </For>
                                </Accordion>
                                <Show when={!showAll() && overflow() > 0}>
                                  <div data-slot="session-turn-diffs-more" onClick={toggleAll}>
                                    {i18n.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
                                  </div>
                                </Show>
                              </div>
                            </div>
                          </Show>
                        </ReasoningOriginalContext.Provider>
                      </div>
                    </Collapsible.Content>
                  </Show>
                </Collapsible>
              </Show>
              <Show when={!thinkingHeaderVisible() || !thinkingOpen()}>
                <div data-slot="session-turn-persistent-steering-messages">
                  <For each={steeringMessages()}>{renderSteeringMessage}</For>
                </div>
              </Show>
              <Show
                when={
                  !!finalAnswerAssistant() &&
                  (finalAssistantTextPartID() || assistantHasMainChatPart() || assistantHasGeneratedImages())
                }
              >
                <div data-slot="session-turn-assistant-final-content">
                  <For each={finalAnswerAssistant() ? [finalAnswerAssistant()!] : emptyAssistant}>
                    {(assistantMessage) => {
                      const generatedImages = createMemo(() =>
                        !finalAssistantMessage(assistantMessage)
                          ? emptyFiles
                          : generatedImagesFromParts(messageParts(assistantMessage.id)),
                      )
                      const textParts = createMemo(() =>
                        messageParts(assistantMessage.id).filter((p) => {
                          if (!finalAssistantMessage(assistantMessage)) return false
                          // 底部只接收跨当前响应段选出的唯一 TextPart；其他 final_answer 留在活动区。
                          if (p.id === finalAssistantTextPartID()) return true
                          if (!mainChatAssistantPart(p)) return false
                          if (!assistantImageFile(p)) return true
                          const generated = new Set(generatedImages().map(imagePartKey))
                          return !generated.has(imagePartKey(p))
                        }),
                      )
                      // 直接迭代 part（store 里的稳定 proxy），而不是每次重算都新建的包装对象。
                      // <For> 按引用比对：若逐条包一层新对象，流式期间每个 token 都会让整列
                      // dispose 重建，正文 DOM 反复重挂——那正是本组件其它地方在极力避免的。
                      const finalContent = createMemo(() => {
                        const parts: PartType[] = []
                        const galleries = new Map<string, { images: FilePart[]; aspectRatio?: string }>()
                        if (!finalAssistantMessage(assistantMessage)) return { parts, galleries }

                        const rendered = new Set<string>()
                        // 使用统一 parts 入口，既保留主分支的稳定代理，也支持逻辑 turn 传入的成员快照。
                        for (const part of messageParts(assistantMessage.id)) {
                          const generated = imageGenerationAttachments(part).filter((image) => {
                            const key = imagePartKey(image)
                            if (rendered.has(key)) return false
                            rendered.add(key)
                            return true
                          })
                          if (generated.length > 0) {
                            parts.push(part)
                            galleries.set(part.id, { images: generated, aspectRatio: generatedImageAspectRatio(part) })
                            continue
                          }
                          if (textParts().includes(part)) parts.push(part)
                        }
                        return { parts, galleries }
                      })
                      return (
                        <For each={finalContent().parts}>
                          {(part) => {
                            const gallery = createMemo(() => finalContent().galleries.get(part.id))
                            return (
                              <Show
                                when={gallery()}
                                fallback={
                                  <Message
                                    message={assistantMessage}
                                    parts={[part]}
                                    actions={props.actions}
                                    showAssistantCopyPartID={assistantCopyPartID()}
                                    showReasoningSummaries={false}
                                    onTextRendered={onFinalTextRendered}
                                  />
                                }
                              >
                                {(content) => (
                                  <GeneratedImageGallery
                                    images={content().images}
                                    aspectRatio={content().aspectRatio}
                                  />
                                )}
                              </Show>
                            )
                          }}
                        </For>
                      )
                    }}
                  </For>

                  <Show when={showEditSummaryBelowFinal()}>
                    <div data-slot="session-turn-edit-summary">
                      <Show when={featuredFile()}>
                        {(f) => (
                          <div data-slot="session-turn-edit-md-cards">
                            <div data-slot="session-turn-edit-md-card">
                              <div data-slot="session-turn-edit-md-icon">
                                <Icon
                                  name={
                                    f().file.toLowerCase().endsWith(".html") || f().file.toLowerCase().endsWith(".htm")
                                      ? "webpage-icon"
                                      : "file1-icon"
                                  }
                                  size="small"
                                />
                              </div>
                              <div data-slot="session-turn-edit-md-main">
                                <div
                                  data-slot="session-turn-edit-md-name"
                                  data-absolute-path={resolveFilePath(f().file)}
                                  onContextMenu={(event) => onEditDiffContextMenu(event, f().file)}
                                >
                                  {getFilename(f().file)}
                                </div>
                                <div data-slot="session-turn-edit-md-meta">{featuredMeta()}</div>
                              </div>
                              {(() => {
                                const openers = createMemo(() => props.actions?.editSummaryOpeners?.() ?? [])
                                const hasMenu = createMemo(() => openers().length > 0)
                                return (
                                  <div
                                    data-slot="session-turn-edit-md-open-group"
                                    data-split={hasMenu() ? "true" : "false"}
                                  >
                                    <button
                                      type="button"
                                      data-slot="session-turn-edit-md-open"
                                      onClick={() => void openProjectPath(f().file)}
                                    >
                                      {i18n.t("ui.sessionTurn.editSummary.open")}
                                      <Show when={!hasMenu()}>
                                        <Icon name="chevron-down" size="small" />
                                      </Show>
                                    </button>
                                    <Show when={hasMenu()}>
                                      <DropdownMenu placement="bottom-end" gutter={4}>
                                        <DropdownMenu.Trigger
                                          data-slot="session-turn-edit-md-open-menu"
                                          aria-label={i18n.t("ui.sessionTurn.editSummary.openMenu")}
                                        >
                                          <Icon name="chevron-down" size="small" />
                                        </DropdownMenu.Trigger>
                                        <DropdownMenu.Portal>
                                          <DropdownMenu.Content
                                            data-component="session-turn-edit-md-open-menu-content"
                                            class="min-w-[180px]"
                                          >
                                            <For each={openers()}>
                                              {(opener) => (
                                                <DropdownMenu.Item onSelect={() => void opener.onSelect(f().file)}>
                                                  <Show when={opener.icon}>{opener.icon!()}</Show>
                                                  <DropdownMenu.ItemLabel>{opener.label}</DropdownMenu.ItemLabel>
                                                </DropdownMenu.Item>
                                              )}
                                            </For>
                                          </DropdownMenu.Content>
                                        </DropdownMenu.Portal>
                                      </DropdownMenu>
                                    </Show>
                                  </div>
                                )
                              })()}
                            </div>
                          </div>
                        )}
                      </Show>

                      <Show when={edited() > 0 || editedToolFiles().length > 0}>
                        <div data-slot="session-turn-edit-diff-summary">
                          <div data-slot="session-turn-edit-diff-summary-header">
                            <HoverCard
                              trigger={
                                <div data-slot="session-turn-edit-diff-summary-title">
                                  <div data-slot="session-turn-edit-diff-summary-title-icon">
                                    <Icon name="diff-summary-header" size="small" />
                                  </div>
                                  <div data-slot="session-turn-edit-diff-summary-title-copy">
                                    <span data-slot="session-turn-edit-diff-summary-title-text">
                                      {editedSummaryTitle()}
                                    </span>
                                    <span data-slot="session-turn-edit-diff-summary-title-subtext">
                                      <DiffChanges changes={totalChanges()} />
                                    </span>
                                  </div>
                                </div>
                              }
                              open={showDiffAccordion() ? undefined : false}
                              placement="bottom-start"
                              openDelay={300}
                              closeDelay={100}
                              class="session-turn-edit-hover-preview"
                            >
                              <div class="flex flex-col gap-2">
                                <For each={hoverFinalReviewDiffs()}>
                                  {(diff) => (
                                    <Dynamic component={fileComponent} mode="diff" fileDiff={normalize(diff).fileDiff} />
                                  )}
                                </For>
                              </div>
                            </HoverCard>
                            <div data-slot="session-turn-edit-diff-summary-actions">
                              <Button
                                size="small"
                                variant="ghost"
                                data-slot="session-turn-edit-diff-undo-button"
                                disabled={editSummaryUndoDisabled()}
                                onClick={onEditSummaryUndo}
                              >
                                <span data-slot="session-turn-edit-diff-action-pair">
                                  {i18n.t("ui.sessionTurn.editSummary.undo")}
                                  <Icon name="arrow-uturn-down-filled" size="small" />
                                </span>
                              </Button>
                              <Button
                                size="small"
                                variant="ghost"
                                data-slot="session-turn-edit-diff-review-button"
                                disabled={editSummaryReviewDisabled()}
                                onClick={onEditSummaryReview}
                              >
                                {i18n.t("ui.sessionTurn.editSummary.review")}
                              </Button>
                              <IconButton
                                icon="chevron-down"
                                size="normal"
                                variant="ghost"
                                style={{ transform: `rotate(${finalDiffsOpen() ? 0 : 180}deg)` }}
                                aria-label={
                                  finalDiffsOpen()
                                    ? i18n.t("ui.sessionTurn.editSummary.collapse")
                                    : i18n.t("ui.sessionTurn.editSummary.expand")
                                }
                                onClick={toggleFinalDiffs}
                              />
                            </div>
                          </div>
                          <Show when={finalDiffsOpen()}>
                            <Show when={showDiffAccordion()}>
                              <div data-slot="session-turn-edit-diff-list-wrap">
                                <div
                                  ref={editDiffListRef}
                                  data-slot="session-turn-edit-diff-list-scroll"
                                  data-thumb-dragging={editDiffThumbDragging() ? "true" : undefined}
                                  tabIndex={0}
                                  role="region"
                                  aria-label={i18n.t("ui.scrollView.ariaLabel")}
                                  onScroll={syncEditDiffListOverflow}
                                  onKeyDown={onEditDiffListKeyDown}
                                >
                                  <div data-slot="session-turn-edit-diff-accordion">
                                    <Accordion
                                      multiple
                                      value={expandedFinal()}
                                      onChange={(value) => {
                                        onFinalDiffsChange(value)
                                        requestAnimationFrame(syncEditDiffListOverflow)
                                      }}
                                    >
                                      <For each={visibleFinalReviewDiffs()}>
                                        {(diff) => {
                                          const view = normalize(diff)
                                          const active = createMemo(() => expandedFinal().includes(diff.file))
                                          const isAddedFile = createMemo(() => {
                                            if (diff.status === "added") return true
                                            return addedToolFiles().has(diffPathKey(diff.file))
                                          })
                                          const [shown, setShown] = createSignal(false)

                                          createEffect(
                                            on(
                                              active,
                                              (value) => {
                                                if (!value) {
                                                  setShown(false)
                                                  return
                                                }
                                                requestAnimationFrame(() => {
                                                  if (!active()) return
                                                  setShown(true)
                                                })
                                              },
                                              { defer: true },
                                            ),
                                          )

                                          return (
                                            <Accordion.Item value={diff.file}>
                                              <StickyAccordionHeader>
                                                <Accordion.Trigger>
                                                  <div
                                                    data-slot="session-turn-edit-diff-trigger"
                                                    onContextMenu={(event) => onEditDiffContextMenu(event, diff.file)}
                                                  >
                                                    <div
                                                      style={{
                                                        display: "inline-flex",
                                                        "align-items": "center",
                                                        gap: "0",
                                                        "flex-shrink": "0",
                                                      }}
                                                    >
                                                      <span data-slot="session-turn-edit-diff-path">{diff.file}</span>
                                                      <Show when={isAddedFile()}>
                                                        <span data-slot="session-turn-edit-diff-added-dot" />
                                                      </Show>
                                                    </div>
                                                    <span data-slot="session-turn-edit-diff-meta">
                                                      <span data-slot="session-turn-edit-diff-meta-swap">
                                                        <span data-slot="session-turn-edit-diff-changes">
                                                          {/* 文件行只展示稳定终值，禁用逐位滚动可把每行数字 DOM 从百余个降到常数级。 */}
                                                          <DiffChanges changes={diff} animated={false} />
                                                        </span>
                                                        <span
                                                          data-slot="session-turn-edit-diff-link-icon"
                                                          onClick={(e) => {
                                                            e.stopPropagation()
                                                            onEditSummaryReview()
                                                          }}
                                                        >
                                                          <Icon
                                                            name="right-link"
                                                            size="small"
                                                            viewBox="0 0 1024 1024"
                                                          />
                                                        </span>
                                                      </span>
                                                      <Icon name="chevron-down" size="small" />
                                                    </span>
                                                  </div>
                                                </Accordion.Trigger>
                                              </StickyAccordionHeader>
                                              <Accordion.Content>
                                                <Show when={shown()}>
                                                  <div data-slot="session-turn-edit-diff-view" data-scrollable>
                                                    <Show
                                                      when={hasRenderableDiffBody(diff)}
                                                      fallback={
                                                        <div class="text-12-regular text-text-weak">
                                                          {i18n.t("ui.sessionTurn.editSummary.noDiff")}
                                                        </div>
                                                      }
                                                    >
                                                      <Dynamic
                                                        component={fileComponent}
                                                        mode="diff"
                                                        fileDiff={view.fileDiff}
                                                      />
                                                    </Show>
                                                  </div>
                                                </Show>
                                              </Accordion.Content>
                                            </Accordion.Item>
                                          )
                                        }}
                                      </For>
                                    </Accordion>
                                    <Show when={remainingFinalReviewDiffs() > 0}>
                                      <button
                                        type="button"
                                        data-slot="session-turn-edit-diff-more"
                                        onClick={revealMoreFinalDiffs}
                                      >
                                        {i18n.t("ui.sessionTurn.diff.showMore", {
                                          count: String(Math.min(FINAL_DIFF_BATCH, remainingFinalReviewDiffs())),
                                        })}
                                      </button>
                                    </Show>
                                  </div>
                                </div>
                                <Show when={editDiffListOverflowing() || editDiffThumbDragging()}>
                                  <div data-slot="session-turn-edit-diff-scrollbar-rail">
                                    <button
                                      type="button"
                                      data-slot="session-turn-edit-diff-scrollbar-arrow"
                                      data-direction="up"
                                      aria-label={i18n.t("ui.sessionTurn.editSummary.scrollToTop")}
                                      onClick={() => onEditDiffScrollbarArrowClick("up")}
                                      onDblClick={(e) => {
                                        e.preventDefault()
                                        onEditDiffScrollbarArrowDblClick("up")
                                      }}
                                    />
                                    <div
                                      data-slot="session-turn-edit-diff-scrollbar-track"
                                      onPointerDown={onEditDiffTrackPointerDown}
                                    >
                                      <div
                                        data-slot="session-turn-edit-diff-scrollbar-thumb"
                                        aria-hidden="true"
                                        data-dragging={editDiffThumbDragging() ? "true" : undefined}
                                        style={editDiffScrollbarThumbStyle()}
                                        onPointerDown={onEditDiffThumbPointerDown}
                                      />
                                    </div>
                                    <button
                                      type="button"
                                      data-slot="session-turn-edit-diff-scrollbar-arrow"
                                      data-direction="down"
                                      aria-label={i18n.t("ui.sessionTurn.editSummary.scrollToBottom")}
                                      onClick={() => onEditDiffScrollbarArrowClick("down")}
                                      onDblClick={(e) => {
                                        e.preventDefault()
                                        onEditDiffScrollbarArrowDblClick("down")
                                      }}
                                    />
                                  </div>
                                </Show>
                              </div>
                            </Show>
                          </Show>
                        </div>
                      </Show>
                      <Show when={data.fileContextMenuActions}>
                        <FileLinkContextMenu
                          absolutePath={editDiffContextPath()}
                          position={editDiffContextPosition()}
                          open={editDiffContextOpen()}
                          onOpenChange={setEditDiffContextOpen}
                          actions={data.fileContextMenuActions!}
                        />
                      </Show>
                    </div>
                  </Show>

                  {/* 整 user turn 末尾的工具条：Copy / Fork / meta；hover 出现，最新 turn 常显 */}
                  <Show when={turnFooterVisible()}>
                    <div
                      data-slot="session-turn-assistant-footer"
                      data-pinned={props.isLatestUserTurn ? "" : undefined}
                    >
                      <Tooltip
                        value={turnCopied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
                        placement="top"
                        gutter={4}
                      >
                        <IconButton
                          icon={turnCopied() ? "check" : "copy"}
                          size="normal"
                          variant="ghost"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void onTurnFooterCopy()}
                          aria-label={turnCopied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
                        />
                      </Tooltip>
                      <Show when={props.actions?.fork}>
                        <Tooltip value={i18n.t("ui.message.forkMessage")} placement="top" gutter={4}>
                          <IconButton
                            icon="fork-split"
                            size="normal"
                            variant="ghost"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={onTurnFooterFork}
                            aria-label={i18n.t("ui.message.forkMessage")}
                          />
                        </Tooltip>
                      </Show>
                      <Show when={turnFooterMeta()}>
                        <span data-slot="session-turn-assistant-footer-meta">{turnFooterMeta()}</span>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
              {/* 流式正文的 phase 可能延迟到达，运行态必须独立放在所有可见回复之后，不能被后续动态越过。 */}
              <Show when={showThinking()}>
                <div data-slot="session-turn-thinking">
                  <TextShimmer
                    text={i18n.t("ui.sessionTurn.status.thinking")}
                    active={working()}
                    class="text-12-regular cursor-default session-turn-thinking-shimmer"
                  />
                  <Show when={!showReasoningSummaries()}>
                    <TextReveal
                      text={reasoningHeading()}
                      class="session-turn-thinking-heading"
                      travel={25}
                      duration={700}
                    />
                  </Show>
                </div>
              </Show>
              <Show when={interrupted()}>
                <div data-slot="session-turn-stopped" class="flex flex-col gap-2 pt-2">
                  <span class="self-end text-12-regular text-text-weak">{stoppedLabel()}</span>
                  <div class="h-px w-full bg-border-weak-base" aria-hidden="true" />
                </div>
              </Show>
              <Show when={error() && !showStandaloneError()}>
                <Card variant="normal" class="inline-notice-card" data-kind="error-inline">
                  {renderNoticeIcon()}
                  {renderErrorNoticeContent()}
                </Card>
              </Show>
              <Show when={showStandaloneError()}>
                <div data-slot="session-turn-assistant-final-content" aria-hidden={working()}>
                  <div data-slot="session-turn-inline-notice-wrap">
                    <Card variant="normal" class="inline-notice-card" data-kind="standalone-error">
                      {renderNoticeIcon()}
                      {renderErrorNoticeContent()}
                    </Card>
                  </div>
                </div>
              </Show>
              <Show when={showEmptyAssistantResponse()}>
                <div data-slot="session-turn-assistant-final-content" aria-hidden={working()}>
                  <div data-slot="session-turn-inline-notice-wrap">
                    <Card variant="normal" class="inline-notice-card" data-kind="empty-response">
                      {renderNoticeIcon()}
                      <span data-slot="session-turn-inline-notice-message" data-kind="empty-response-message">
                        {i18n.t("ui.sessionTurn.emptyResponse")}
                      </span>
                    </Card>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
