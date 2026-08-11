import {
  Component,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import stripAnsi from "strip-ansi"
import { ansiToHtml, escapeHtml, extractCodeInner, langFromFilePath } from "../utils/ansi"
import { getSharedHighlighter } from "@pierre/diffs"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { Dynamic } from "solid-js/web"
import {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  Session,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionAnswer,
  QuestionInfo,
} from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import type { MarkdownPathResolution } from "../context/data"
import { useSkillFile } from "../context/skill-file"
import { useFileComponent } from "../context/file"
import { useImagePreview } from "../context/image-preview"
import { type UiI18n, useI18n } from "../context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { Collapsible } from "./collapsible"
import { FileAttachmentItem } from "./file-attachment"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { SkillChip as SharedSkillChip, skillDisplayName, type SkillRef } from "./skill-chip"
import { ToolErrorCard } from "./tool-error-card"
import { toolErrorText } from "./tool-error"
import { displayImageFailureText, displayToolErrorText } from "./session-error-display"
import { Button } from "./button"
import {
  formatImageGenerationPlanNames,
  parseImageGenerationMetadataFlag,
  parseImageGenerationStorefrontPlans,
  parseImageGenerationUpgradePlans,
  resolveImageGenerationUpgradeTarget,
} from "./image-generation-plan-access"
import { Checkbox } from "./checkbox"
import { DiffChanges } from "./diff-changes"
import { Markdown } from "./markdown"
import { createMarkdownLocalPathHandler, isHtmlFilePath } from "./markdown-local-path"
import { loadingImageAspectRatio } from "./generated-image-aspect"
import { FileLinkContextMenu, primaryFileContextOpener } from "./file-link-context-menu"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  parseAddToChatUserMessageDisplay,
  composeAddToChatUserMessage,
} from "@opencode-ai/core/util/add-to-chat-composed-message"
import { parseMentionLinks } from "@opencode-ai/core/util/mention"
import { parseConversationReferences } from "@opencode-ai/core/util/conversation-reference"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"
import { Spinner } from "./spinner"
import { TextShimmer } from "./text-shimmer"
import { AnimatedCountList } from "./tool-count-summary"
import { AnimatedCountLabel } from "./tool-count-label"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { resolveWorkspaceFilePath } from "./session-turn-path"
import { animate } from "motion"
import { useLocation } from "@solidjs/router"
import { attached, inline, kind } from "./message-file"
import { parseToolPermissionReview, ToolPermissionReview, type ToolPermissionReviewData } from "./tool-permission-review"
import { resolveEditActivityFileClick } from "./message-part-file-click"
import { openWebfetchLink } from "./message-part-webfetch-link"
import {
  findPromptLinkMatches,
  type PromptLinkKind,
  type PromptLinkMatch,
} from "@opencode-ai/core/util/prompt-link"
import { UserPromptLink } from "./user-prompt-link"

function localFilePathFromPartUrl(url: string) {
  if (!url.startsWith("file://")) {
    if (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url)) return url
    return undefined
  }

  // 对话附件保存的是 file:// URL；右键文件菜单需要真实本地路径，避免复制 / 打开时带协议头。
  const parsed = new URL(url)
  const decoded = decodeURIComponent(parsed.pathname)
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) return decoded.slice(1)
  return decoded
}

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function toolInput(part: ToolPart): Record<string, unknown> | undefined {
  return objectValue(part.state.input)
}

function toolMetadata(part: ToolPart): Record<string, unknown> | undefined {
  return objectValue(objectValue(part.state)?.metadata)
}

function toolOutput(part: ToolPart): string | undefined {
  return stringValue(objectValue(part.state)?.output)
}

function toolRaw(part: ToolPart): string {
  return stringValue(objectValue(part.state)?.raw) ?? ""
}

// 真实字符串里的行数（换行个数），与流式 raw 的 \n 统计保持一致，保证生成→执行→完成的计数平滑衔接
function lineCount(text: string): number {
  const m = text.match(/\n/g)
  return m ? m.length : 0
}

// 流式累积的原始 JSON 入参里，字符串换行被编码为 \n(两字符)，据此近似「已写入行数」
function streamLineCount(raw: string): number {
  const m = raw.match(/\\n/g)
  return m ? m.length : 0
}

// 只统计 raw 里某个字段值部分的换行数（从 "field":" 之后到末尾）。用于 edit 只数 newString，
// 避免把前面已流入的 oldString 行数也算进「新增」导致虚高（newString 在参数声明顺序里靠后）。
function streamFieldLineCount(raw: string, field: string): number {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw)
  if (!m) return 0
  return streamLineCount(raw.slice(m.index + m[0].length))
}

function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s.replace(/\\(.)/g, "$1")
  }
}

// 从流式 raw / 已解析补丁里尽力提取目标文件名（write/edit 的 filePath/file，apply_patch 的补丁头）
function streamFileName(text: string): string | undefined {
  const field = text.match(/"(?:filePath|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (field?.[1]) return unescapeJsonString(field[1])
  const header = text.match(/\*\*\*\s*(?:Add|Update|Delete) File:\s*([^\n"\\]+)/)
  if (header?.[1]) return header[1].trim()
  return undefined
}

type PatchFileCount = { filePath: string; additions: number; deletions: number; pending: boolean }

// 解析补丁（已解析的真实 patchText）为按文件分段的增删统计。一个 apply_patch 可含多个
// *** Add/Update/Delete File，需拆成多个条目，否则会把多文件行数全堆到第一个文件上。
// patchText 已完整 → 所有分段内容都已定稿，pending=false。
function parsePatchFiles(patch: string): PatchFileCount[] {
  const files: PatchFileCount[] = []
  let current: PatchFileCount | undefined
  for (const line of patch.split("\n")) {
    const header = /^\*\*\*\s*(?:Add|Update|Delete) File:\s*(.+)$/.exec(line)
    if (header) {
      current = { filePath: header[1].trim(), additions: 0, deletions: 0, pending: false }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++
  }
  return files
}

// 流式阶段：从累积 raw（JSON，换行编码为 \n）里就地解析多文件补丁，按 \n 分段、按首字符判定，
// 让每个文件在其分段流入时各自实时跳动（index.html 涨满再到 styles.css…），而非全堆到第一个。
// pending：只有正在流入的最后一段是「正在编辑」，前面的段一旦有下一段开始就已完成；
// 若已见 *** End Patch，则最后一段也算完成。
function parseStreamPatchFiles(raw: string): PatchFileCount[] {
  const m = /"patchText"\s*:\s*"/.exec(raw)
  if (!m) return []
  const body = raw.slice(m.index + m[0].length)
  const files: PatchFileCount[] = []
  let current: PatchFileCount | undefined
  let ended = false
  for (const line of body.split("\\n")) {
    if (/^\*\*\*\s*End Patch/.test(line)) {
      ended = true
      continue
    }
    const header = /^\*\*\*\s*(?:Add|Update|Delete) File:\s*(.+)$/.exec(line)
    if (header) {
      current = { filePath: unescapeJsonString(header[1]).trim(), additions: 0, deletions: 0, pending: false }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++
  }
  files.forEach((file, index) => {
    file.pending = index === files.length - 1 ? !ended : false
  })
  return files
}

// 完成前（生成/执行中）用 input 或流式 raw 估算每个文件的文件名与增删行，驱动里程表逐行跳动。
// 返回数组：apply_patch 一次可含多个文件，需按补丁分段各自展示；write/edit 为单文件。
function liveEditEstimates(part: ToolPart): PatchFileCount[] {
  const input = toolInput(part)
  const raw = toolRaw(part)
  if (part.tool === "apply_patch") {
    // 注意：apply_patch 工具的入参字段是 patchText（不是 patch）
    const patchText = stringValue(input?.patchText)
    const files = patchText != null ? parsePatchFiles(patchText) : parseStreamPatchFiles(raw)
    return files.filter((f) => f.filePath)
  }
  if (part.tool === "write") {
    const filePath = stringValue(input?.filePath) ?? streamFileName(raw)
    if (!filePath) return []
    const content = stringValue(input?.content)
    // input.content 已就绪 → 内容定稿(pending=false)；仍在流式 raw → pending=true
    return [{ filePath, additions: content != null ? lineCount(content) : streamLineCount(raw), deletions: 0, pending: content == null }]
  }
  if (part.tool === "edit") {
    const filePath = stringValue(input?.filePath) ?? streamFileName(raw)
    if (!filePath) return []
    const newString = stringValue(input?.newString)
    const oldString = stringValue(input?.oldString)
    if (newString != null || oldString != null)
      return [
        {
          filePath,
          additions: newString != null ? lineCount(newString) : 0,
          deletions: oldString != null ? lineCount(oldString) : 0,
          pending: false,
        },
      ]
    // 流式阶段只数 newString 部分（含 oldString 的整段 raw 会虚高）
    return [{ filePath, additions: streamFieldLineCount(raw, "newString"), deletions: 0, pending: true }]
  }
  const filePath = stringValue(input?.filePath) ?? streamFileName(raw)
  return filePath ? [{ filePath, additions: streamLineCount(raw), deletions: 0, pending: true }] : []
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  actions?: UserActions
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  /** 最终文本真正绘制后通知 turn；普通消息不传，避免历史 Markdown 参与活动态。 */
  onTextRendered?: (input: { partID: string; text: string }) => void
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void

/** 单个“Open with …”下拉项，渲染在 editSummary 的拆分按钮菜单里。 */
export type EditSummaryOpener = {
  id: string
  label: string
  /** 可选的预渲染图标，由调用方负责按不同 OS 提供。 */
  icon?: () => JSX.Element
  /** Receives the file path (relative-to-workspace or absolute) of the featured edit. */
  onSelect: (file: string) => void | Promise<void>
}

function assistantMessageTerminal(message: AssistantMessage) {
  if (message.error) return true
  if (message.finish) return !["tool-calls", "unknown"].includes(message.finish)
  return typeof message.time.completed === "number"
}

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
  edit?: (input: { sessionID: string; messageID: string; newText: string }) => Promise<void> | void
  /** 返回该会话当前目标的 objective（仅 goal 实验开启时提供）；用户消息文本与之相同时显示「◎ 目标」常驻标识。 */
  goalObjective?: (sessionID: string) => string | undefined
  /** Desktop: open right review panel; narrow: switch to Changes tab */
  openReviewPanel?: (mode?: "turn" | "unstaged" | "staged" | "branch") => void | Promise<void>
  editSummaryRevertPending?: () => boolean
  sessionBusy?: () => boolean
  /** Only `true` when this user turn is allowed to revert session file edits (typically latest user message). */
  canRevertEditSummary?: (messageID: string) => boolean
  /**
   * Optional openers shown in the editSummary "Open" split-button dropdown menu.
   * 当返回 `undefined` 或空数组时，chevron 角标隐藏，主按钮保持原行为。
   * 第一项在视觉上不强制等于主按钮；主按钮始终调用组件内置的 `openProjectPath`，走系统默认应用。
   */
  editSummaryOpeners?: () => EditSummaryOpener[]
  /** 该消息是否"排队中"(已发送、会话忙、还没开始处理)；为真时气泡灰显并显示撤销按钮 */
  isQueued?: (messageID: string) => boolean
  /** 撤销一条排队中的消息 */
  deleteQueued?: SessionAction
  /** 弹确认框 → 调接口开启余额扣费 → 成功后重试触发该错误的原请求。 */
  enableBalanceBilling?: (input: { sessionID: string; messageID: string }) => void | Promise<void>
  /** 跳转到购买套餐页面（应用内导航）。 */
  openPurchasePage?: () => void | Promise<void>
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  actions?: UserActions
  /** 只由最终回复链路注入，用实际展示文本版本确认迟到增量也已完成绘制。 */
  onTextRendered?: (input: { partID: string; text: string }) => void
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_PACE_MS = 24
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

function step(size: number) {
  if (size <= 12) return 2
  if (size <= 48) return 4
  if (size <= 96) return 8
  return Math.min(24, Math.ceil(size / 8))
}

function next(text: string, start: number) {
  const end = Math.min(text.length, start + step(text.length - start))
  const max = Math.min(text.length, end + 8)
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? "")) return i + 1
  }
  return end
}

function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const run = () => {
    timeout = undefined
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text)
      return
    }
    const end = next(text, shown.length)
    sync(text.slice(0, end))
    if (end < text.length) timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length || timeout) return
    timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

function PacedMarkdown(props: {
  text: string
  cacheKey: string
  streaming: boolean
  resolveMarkdownPath?: (raw: string) => Promise<MarkdownPathResolution | undefined>
  openReviewPanel?: () => void | Promise<void>
  openLocalPath?: (absolutePath: string, kind?: "file" | "directory") => void | Promise<void>
  openSystemBrowserLink?: (url: string) => void | Promise<void>
  openExternalLink?: (url: string) => void | Promise<void>
  /** 非流式完整文本完成 Markdown DOM 绘制后的确认。 */
  onRenderSettled?: (text: string) => void
}) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <Markdown
        text={value()}
        cacheKey={props.cacheKey}
        streaming={props.streaming}
        resolveMarkdownPath={props.resolveMarkdownPath}
        openReviewPanel={props.openReviewPanel}
        openLocalPath={props.openLocalPath}
        openSystemBrowserLink={props.openSystemBrowserLink}
        openExternalLink={props.openExternalLink}
        onRenderSettled={props.onRenderSettled}
      />
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}

import { MessageEditBox } from "./message-edit-box"
import type { IconProps } from "./icon"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

const agentTones: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const agentPalette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentPalette[hash % agentPalette.length]
}

function taskAgent(
  raw: unknown,
  list?: readonly { name: string; color?: string }[],
): { name?: string; color?: string } {
  if (typeof raw !== "string" || !raw) return {}
  const key = raw.toLowerCase()
  const item = list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)
  return {
    name: item?.name ?? `${raw[0]!.toUpperCase()}${raw.slice(1)}`,
    color: item?.color ?? agentTones[key] ?? tone(key),
  }
}

export function getToolInfo(tool: string, input: any = {}): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case "websearch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.websearch"),
        subtitle: input.query,
      }
    case "task": {
      const type =
        typeof input.subagent_type === "string" && input.subagent_type
          ? input.subagent_type[0]!.toUpperCase() + input.subagent_type.slice(1)
          : undefined
      return {
        icon: "task",
        title: agentTitle(i18n, type),
        subtitle: input.description,
      }
    }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.description,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "apply_patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: input.name || i18n.t("ui.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

function urls(text: string | undefined) {
  if (!text) return []
  const seen = new Set<string>()
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function sessionLink(id: string | undefined, path: string, href?: (id: string) => string | undefined) {
  if (!id) return

  const direct = href?.(id)
  if (direct) return direct

  const idx = path.indexOf("/session")
  if (idx === -1) return
  return `${path.slice(0, idx)}/session/${id}`
}

function currentSession(path: string) {
  return path.match(/\/session\/([^/?#]+)/)?.[1]
}

function taskSession(
  input: Record<string, any>,
  path: string,
  sessions: Session[] | undefined,
  agents?: readonly { name: string; color?: string }[],
) {
  const parentID = currentSession(path)
  if (!parentID) return
  const description = typeof input.description === "string" ? input.description : ""
  const agent = taskAgent(input.subagent_type, agents).name
  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (agent ? session.title.includes(`@${agent}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list", "bash", "edit", "write", "apply_patch"])
const CONTEXT_GATHER_TOOLS = new Set(["read", "glob", "grep", "list"])
const HIDDEN_TOOLS = new Set(["todowrite"])

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

type PartRef = {
  messageID: string
  partID: string
}

type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}

function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

function renderable(part: PartType, showReasoningSummaries = true, includeText = true) {
  if (part.type === "tool") {
    if (HIDDEN_TOOLS.has(part.tool)) return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  }
  if (part.type === "text") return includeText && !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return !!PART_MAPPING[part.type]
}

function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return edit
}

function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  return toolDefaultOpen(part.tool, shell, edit)
}

export function AssistantParts(props: {
  messages: AssistantMessage[]
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  working?: boolean
  showReasoningSummaries?: boolean
  includeText?: boolean
  partFilter?: (part: PartType) => boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  actions?: UserActions
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => (props.partFilter ? props.partFilter(part) : true))
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true, props.includeText ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )
                const busy = createMemo(() => props.working && last() === entryAccessor().key)
                const gatherTools = createMemo(() => parts().filter(isContextGatherTool), emptyTools)
                const commandTools = createMemo(() => parts().filter((part) => part.tool === "bash"), emptyTools)
                const editTools = createMemo(
                  () =>
                    parts().filter(
                      (part) => part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch",
                    ),
                  emptyTools,
                )

                return (
                  <Show when={parts().length > 0}>
                    <>
                      <ContextToolGroup parts={gatherTools()} busy={busy()} />
                      <CommandToolGroup parts={commandTools()} busy={busy()} />
                      <EditToolGroup parts={editTools()} busy={busy()} />
                    </>
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const message = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return msgs().get(entry.ref.messageID)
                })
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.messageID)?.get(entry.ref.partID)
                })

                return (
                  <Show when={message()}>
                    <Show when={item()}>
                      <Part
                        part={item()!}
                        message={message()!}
                        showAssistantCopyPartID={props.showAssistantCopyPartID}
                        turnDurationMs={props.turnDurationMs}
                        defaultOpen={partDefaultOpen(item()!, props.shellToolDefaultOpen, props.editToolDefaultOpen)}
                        actions={props.actions}
                      />
                    </Show>
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

function isContextGatherTool(part: ToolPart) {
  return CONTEXT_GATHER_TOOLS.has(part.tool)
}

function contextToolDetail(part: ToolPart): string | undefined {
  const info = getToolInfo(part.tool, part.state.input ?? {})
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return toolErrorText(part.state.error)
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      return {
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : "",
        args,
      }
    }
    case "list":
      return {
        title: i18n.t("ui.tool.list"),
        subtitle: getDirectory(path),
      }
    case "glob":
      return {
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args,
      }
    }
    default: {
      const info = getToolInfo(part.tool, input)
      return {
        title: info.title,
        subtitle: info.subtitle || contextToolDetail(part),
        args: [],
      }
    }
  }
}

function contextToolShellCommand(part: ToolPart) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`
  const path = typeof input.path === "string" ? input.path : "."
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  if (part.tool === "read") {
    const segments = [`Get-Content -Path ${quoted(filePath ?? "")}`]
    if (offset !== undefined || limit !== undefined) {
      const options = [offset !== undefined ? `-Skip ${offset}` : "", limit !== undefined ? `-First ${limit}` : ""]
        .filter(Boolean)
        .join(" ")
      segments.push(`Select-Object ${options}`.trim())
    }
    return segments.join(" | ")
  }

  if (part.tool === "list") return `Get-ChildItem -Path ${quoted(path)}`
  if (part.tool === "glob") {
    if (pattern) return `Get-ChildItem -Path ${quoted(path)} -Recurse -Filter ${quoted(pattern)}`
    return `Get-ChildItem -Path ${quoted(path)} -Recurse`
  }
  if (part.tool === "grep") {
    const source = include
      ? `Get-ChildItem -Path ${quoted(path)} -Recurse -Include ${quoted(include)}`
      : `Get-ChildItem -Path ${quoted(path)} -Recurse`
    if (pattern) return `${source} | Select-String -Pattern ${quoted(pattern)}`
    return source
  }

  const info = getToolInfo(part.tool, input)
  return info.subtitle ? `${info.title} ${info.subtitle}`.trim() : info.title
}

function contextToolShellOutput(part: ToolPart) {
  if (part.state.status === "completed") return stripAnsi(part.state.output ?? "")
  if (part.state.status === "error") return toolErrorText(part.state.error)
  return ""
}

function contextToolSummary(parts: ToolPart[]) {
  const files = new Set(
    parts
      .filter((part) => part.tool === "read")
      .map((part) => ("input" in part.state ? (part.state.input as { filePath?: string })?.filePath : undefined))
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  )
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  return { files: files.size, search, list }
}

function ExaOutput(props: { output?: string }) {
  const links = createMemo(() => urls(props.output))

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
                data-slot="exa-tool-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {url}
              </a>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} actions={props.actions} />
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay
            message={assistantMessage() as AssistantMessage}
            parts={props.parts}
            showAssistantCopyPartID={props.showAssistantCopyPartID}
            showReasoningSummaries={props.showReasoningSummaries}
            actions={props.actions}
            onTextRendered={props.onTextRendered}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  actions?: UserActions
  onTextRendered?: (input: { partID: string; text: string }) => void
}) {
  const emptyTools: ToolPart[] = []
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageID: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.partID)
                })

                return (
                  <Show when={item()}>
                    <Part
                      part={item()!}
                      message={props.message}
                      showAssistantCopyPartID={props.showAssistantCopyPartID}
                      actions={props.actions}
                      onTextRendered={props.onTextRendered}
                    />
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

const MAX_HIGHLIGHT_CHARS = 12000
const MAX_HIGHLIGHT_LINES = 300

async function highlightRaw(raw: string, lang: string): Promise<string> {
  const highlighter = await getSharedHighlighter({
    themes: ["OpenCode"],
    langs: [],
    preferredHighlighter: "shiki-wasm",
  })
  const resolvedLang = lang in bundledLanguages ? lang : "text"
  if (!highlighter.getLoadedLanguages().includes(resolvedLang)) {
    await highlighter.loadLanguage(resolvedLang as BundledLanguage)
  }
  return highlighter.codeToHtml(raw, {
    lang: resolvedLang,
    theme: "OpenCode",
    tabindex: false,
  })
}

function BashCodeOutput(props: { raw: string; lang?: string }) {
  const [highlighted, setHighlighted] = createSignal<string | null>(null)
  const ansiHtml = createMemo(() => ansiToHtml(props.raw))

  createEffect(() => {
    const lang = props.lang
    const raw = props.raw
    if (!lang || !raw || raw.length > MAX_HIGHLIGHT_CHARS || raw.split("\n").length > MAX_HIGHLIGHT_LINES) {
      setHighlighted(null)
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const html = await highlightRaw(raw, lang)
        if (!cancelled) setHighlighted(extractCodeInner(html))
      } catch (err) {
        if (!cancelled) console.warn("[BashCodeOutput] Shiki highlight failed:", lang, err)
      }
    })()

    onCleanup(() => {
      cancelled = true
    })
  })

  const displayHtml = createMemo(() => highlighted() || ansiHtml())

  return <code innerHTML={displayHtml()} />
}

function BashCommandLine(props: { command: string; suffixHtml?: string }) {
  const [highlighted, setHighlighted] = createSignal<string | null>(null)

  createEffect(() => {
    const command = props.command
    setHighlighted(null)
    if (!command || command.length > MAX_HIGHLIGHT_CHARS) return

    let cancelled = false
    ;(async () => {
      try {
        const html = await highlightRaw(command, "bash")
        if (!cancelled) setHighlighted(extractCodeInner(html).replace(/\n$/, ""))
      } catch (err) {
        if (!cancelled) console.warn("[BashCommandLine] Shiki highlight failed:", err)
      }
    })()

    onCleanup(() => {
      cancelled = true
    })
  })

  const displayHtml = createMemo(() => {
    const prompt = '<span class="ansi-prompt">$</span>'
    const head = props.command ? `${prompt} ${highlighted() ?? escapeHtml(props.command)}` : prompt
    return head + (props.suffixHtml ?? "")
  })

  return <code innerHTML={displayHtml()} />
}

function ToolPermissionReviewForPart(props: { part: ToolPart }) {
  const review = createMemo(() => parseToolPermissionReview(toolMetadata(props.part)?.permissionReview))
  return <ToolPermissionReview review={review()} />
}

function ContextToolGroup(props: { parts: ToolPart[]; busy?: boolean }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(true)
  const visibleParts = createMemo(() =>
    props.parts.filter((part) => {
      const trigger = contextToolTrigger(part, i18n)
      const command = contextToolShellCommand(part).trim()
      const output = contextToolShellOutput(part).trim()
      return !!(command || output || trigger.title || trigger.subtitle)
    }),
  )
  const pending = createMemo(
    () =>
      !!props.busy || visibleParts().some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => contextToolSummary(visibleParts()))
  // 所有上下文收集工具（read/ls/search 等）执行完毕后，自动折叠"已收集上下文"组。
  // 必须仅限 isContextGatherTool，避免在 AssistantMessageDisplay 路径（该路径会把
  // edit/write/apply_patch 也传入 ContextToolGroup）误折叠编辑工具。
  createEffect(() => {
    if (!pending() && visibleParts().every((part) => isContextGatherTool(part))) setOpen(false)
  })

  return (
    <Show when={visibleParts().length > 0}>
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost" class="tool-collapsible">
        <Collapsible.Trigger>
          <div data-component="context-tool-group-trigger">
            <span
              data-slot="context-tool-group-title"
              class="min-w-0 flex items-center gap-2 text-14-medium text-text-weak"
            >
              <Icon name="terminal-command" size="small" class="shrink-0 text-text-weak" />
              <span data-slot="context-tool-group-label" class="shrink-0">
                <Show
                  when={pending()}
                  fallback={
                    <span data-slot="context-tool-group-label-text">
                      {i18n.t("ui.sessionTurn.status.gatheredContext")}
                    </span>
                  }
                >
                  <span data-slot="context-tool-group-label-text">
                    <TextShimmer text={i18n.t("ui.sessionTurn.status.gatheringContext")} active />
                  </span>
                </Show>
              </span>
              <span
                data-slot="context-tool-group-summary"
                class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-weak"
              >
                <AnimatedCountList
                  items={[
                    {
                      key: "file",
                      count: summary().files,
                      one: i18n.t("ui.messagePart.context.file.one"),
                      other: i18n.t("ui.messagePart.context.file.other"),
                    },
                    {
                      key: "search",
                      count: summary().search,
                      one: i18n.t("ui.messagePart.context.search.one"),
                      other: i18n.t("ui.messagePart.context.search.other"),
                    },
                    {
                      key: "list",
                      count: summary().list,
                      one: i18n.t("ui.messagePart.context.list.one"),
                      other: i18n.t("ui.messagePart.context.list.other"),
                    },
                  ]}
                  fallback=""
                />
              </span>
            </span>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-component="context-tool-group-list">
            <Index each={visibleParts()}>
              {(partAccessor, index) => {
                const trigger = createMemo(() => contextToolTrigger(partAccessor(), i18n))
                const running = createMemo(
                  () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
                )
                const status = createMemo(() => partAccessor().state.status)
                const shellCommand = createMemo(() => contextToolShellCommand(partAccessor()))
                const shellOutput = createMemo(() => contextToolShellOutput(partAccessor()))
                const rawOutput = createMemo(() => toolOutput(partAccessor()) ?? "")
                const shellLang = createMemo(() => {
                  const part = partAccessor()
                  if (part.tool !== "read") return undefined
                  const input = toolInput(part)
                  let filePath = stringValue(input?.filePath)
                  if (!filePath && Array.isArray(input?.filePaths) && input.filePaths.length > 0) {
                    filePath = stringValue(input.filePaths[0])
                  }
                  // Fallback: extract from command text (e.g. cat "app.ts" or Get-Content -Path 'app.ts')
                  if (!filePath) {
                    const cmd = contextToolShellCommand(part)
                    const match = cmd.match(/(?:cat|Get-Content)[^"']*["']([^"'\s]+)["']/)
                    if (match) filePath = match[1]
                  }
                  if (!filePath) return undefined
                  return langFromFilePath(filePath) ?? undefined
                })
                const rowLabel = createMemo(() =>
                  running()
                    ? i18n.t("ui.sessionTurn.status.gatheringContext")
                    : i18n.t("ui.sessionTurn.status.gatheredContext"),
                )
                const [copiedCommand, setCopiedCommand] = createSignal(false)
                const [copiedOutput, setCopiedOutput] = createSignal(false)
                const handleCopyCommand = async () => {
                  const content = `$ ${shellCommand()}`
                  if (!content.trim()) return
                  await navigator.clipboard.writeText(content)
                  setCopiedCommand(true)
                  setTimeout(() => setCopiedCommand(false), 2000)
                }
                const handleCopyOutput = async () => {
                  const content = shellOutput()
                  if (!content) return
                  await navigator.clipboard.writeText(content)
                  setCopiedOutput(true)
                  setTimeout(() => setCopiedOutput(false), 2000)
                }
                const [childOpen, setChildOpen] = createSignal(false)

                return (
                  <div data-slot="context-tool-group-item">
                    <Collapsible
                      open={childOpen()}
                      onOpenChange={setChildOpen}
                      variant="ghost"
                      class="tool-collapsible"
                    >
                      <Collapsible.Trigger>
                        <div data-slot="activity-tool-item-row">
                          <span data-slot="activity-tool-item-prefix">{rowLabel()}</span>
                          <span data-slot="activity-tool-item-command">
                            <TextShimmer text={shellCommand()} active={running()} />
                          </span>
                          <ToolPermissionReviewForPart part={partAccessor()} />
                          <span data-slot="activity-tool-item-spacer" />
                          <Collapsible.Arrow />
                        </div>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <div data-component="bash-output" data-variant="codex-activity">
                          <div data-slot="bash-header">
                            <span data-slot="bash-header-title">{i18n.t("ui.tool.shell")}</span>
                          </div>
                          <div data-slot="bash-command">
                            <div data-slot="bash-command-copy">
                              <Tooltip
                                value={copiedCommand() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyCommand")}
                                placement="top"
                                gutter={4}
                              >
                                <IconButton
                                  icon={copiedCommand() ? "check" : "copy"}
                                  size="small"
                                  variant="secondary"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={handleCopyCommand}
                                  aria-label={
                                    copiedCommand() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyCommand")
                                  }
                                />
                              </Tooltip>
                            </div>
                            <pre data-slot="bash-pre">
                              <BashCommandLine command={shellCommand()} />
                            </pre>
                          </div>
                          <div data-slot="bash-output-section">
                            <Show when={shellOutput()}>
                              <div data-slot="bash-output-copy">
                                <Tooltip
                                  value={copiedOutput() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyOutput")}
                                  placement="top"
                                  gutter={4}
                                >
                                  <IconButton
                                    icon={copiedOutput() ? "check" : "copy"}
                                    size="small"
                                    variant="secondary"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={handleCopyOutput}
                                    aria-label={
                                      copiedOutput() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyOutput")
                                    }
                                  />
                                </Tooltip>
                              </div>
                            </Show>
                            <div data-slot="bash-output-body">
                              <Show
                                when={shellOutput()}
                                fallback={<div data-slot="bash-empty">{trigger().subtitle || trigger().title}</div>}
                              >
                                <div data-slot="bash-scroll" data-scrollable>
                                  <pre data-slot="bash-pre" data-section="output">
                                    <BashCodeOutput raw={rawOutput()} lang={shellLang()} />
                                  </pre>
                                </div>
                              </Show>
                            </div>
                          </div>
                          <div data-slot="bash-status">
                            <Show when={status() === "completed"}>
                              <span data-slot="bash-status-text" data-status="success">
                                <Icon name="check-small" size="small" />
                                {i18n.t("ui.messagePart.activity.commands.status.success")}
                              </span>
                            </Show>
                            <Show when={status() === "error"}>
                              <span data-slot="bash-status-text" data-status="error">
                                <Icon name="close-small" size="small" />
                                {i18n.t("ui.messagePart.activity.commands.status.error")}
                              </span>
                            </Show>
                          </div>
                        </div>
                      </Collapsible.Content>
                    </Collapsible>
                  </div>
                )
              }}
            </Index>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </Show>
  )
}

function CommandToolGroup(props: { parts: ToolPart[]; busy?: boolean }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(true)
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const titleText = createMemo(() =>
    pending() ? i18n.t("ui.messagePart.activity.commands.active") : i18n.t("ui.messagePart.activity.commands.done"),
  )
  // 所有命令执行完毕后，自动折叠"已运行"组，与"已处理"外层折叠行为保持一致
  createEffect(() => {
    if (!pending()) setOpen(false)
  })

  return (
    <Show when={props.parts.length > 0}>
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost" class="tool-collapsible">
        <Collapsible.Trigger>
          <div data-component="activity-tool-group-trigger" data-kind="command">
            <span
              data-slot="activity-tool-group-title"
              class="min-w-0 flex items-center gap-2 text-14-medium text-text-weak"
            >
              <Icon name="terminal" size="small" class="shrink-0 text-text-weak" />
              <span data-slot="activity-tool-group-label" class="shrink-0">
                {titleText()}
              </span>
              <span
                data-slot="activity-tool-group-summary"
                class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-weak"
              >
                <span data-slot="activity-tool-group-count">
                  <AnimatedCountLabel
                    one={i18n.t("ui.messagePart.activity.commands.one")}
                    other={i18n.t("ui.messagePart.activity.commands.other")}
                    count={props.parts.length}
                  />
                </span>
              </span>
            </span>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-component="activity-tool-group-list" data-kind="command">
            <Index each={props.parts}>
              {(partAccessor) => {
                const running = createMemo(
                  () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
                )
                const status = createMemo(() => partAccessor().state.status)
                const cmd = createMemo(() => {
                  const part = partAccessor()
                  return stringValue(toolInput(part)?.command) ?? stringValue(toolMetadata(part)?.command) ?? ""
                })
                const description = createMemo(() => {
                  const part = partAccessor()
                  return stringValue(toolInput(part)?.description) ?? ""
                })
                const outputText = createMemo(() => {
                  const part = partAccessor()
                  const out = stripAnsi(toolOutput(part) ?? stringValue(toolMetadata(part)?.output) ?? "")
                  const header = cmd() ? `$ ${cmd()}` : "$"
                  return `${header}${out ? "\n\n" + out : ""}`
                })
                const outputOnly = createMemo(() => {
                  const part = partAccessor()
                  return stripAnsi(toolOutput(part) ?? stringValue(toolMetadata(part)?.output) ?? "")
                })
                const cmdRawOutput = createMemo(() => {
                  const part = partAccessor()
                  return toolOutput(part) ?? stringValue(toolMetadata(part)?.output) ?? ""
                })
                const [copiedCommand, setCopiedCommand] = createSignal(false)
                const [copiedOutput, setCopiedOutput] = createSignal(false)
                const handleCopyCommand = async () => {
                  const content = cmd() ? `$ ${cmd()}` : "$"
                  if (!content.trim()) return
                  await navigator.clipboard.writeText(content)
                  setCopiedCommand(true)
                  setTimeout(() => setCopiedCommand(false), 2000)
                }
                const handleCopyOutput = async () => {
                  const content = outputOnly()
                  if (!content) return
                  await navigator.clipboard.writeText(content)
                  setCopiedOutput(true)
                  setTimeout(() => setCopiedOutput(false), 2000)
                }
                const [childOpen, setChildOpen] = createSignal(true)
                // 命令执行完毕后自动折叠子项
                createEffect(() => {
                  if (!running()) setChildOpen(false)
                })
                return (
                  <div data-slot="activity-tool-group-item" data-kind="command">
                    <Collapsible
                      open={childOpen()}
                      onOpenChange={setChildOpen}
                      variant="ghost"
                      class="tool-collapsible"
                    >
                      <Collapsible.Trigger>
                        <div data-slot="activity-tool-item-row">
                          <span data-slot="activity-tool-item-prefix">{titleText()}</span>
                          <Show when={cmd()}>
                            <span data-slot="activity-tool-item-command">
                              <TextShimmer text={cmd()} active={running()} />
                            </span>
                          </Show>
                          <Show when={description()}>
                            <span data-slot="activity-tool-item-desc">{description()}</span>
                          </Show>
                          <ToolPermissionReviewForPart part={partAccessor()} />
                          <span data-slot="activity-tool-item-spacer" />
                          <Collapsible.Arrow />
                        </div>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <div data-component="bash-output" data-variant="codex-activity">
                          <div data-slot="bash-header">
                            <span data-slot="bash-header-title">{i18n.t("ui.tool.shell")}</span>
                          </div>
                          <div data-slot="bash-command">
                            <div data-slot="bash-command-copy">
                              <Tooltip
                                value={copiedCommand() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyCommand")}
                                placement="top"
                                gutter={4}
                              >
                                <IconButton
                                  icon={copiedCommand() ? "check" : "copy"}
                                  size="small"
                                  variant="secondary"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={handleCopyCommand}
                                  aria-label={
                                    copiedCommand() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyCommand")
                                  }
                                />
                              </Tooltip>
                            </div>
                            <pre data-slot="bash-pre">
                              <BashCommandLine command={cmd()} />
                            </pre>
                          </div>
                          <div data-slot="bash-output-section">
                            <Show when={outputOnly()}>
                              <div data-slot="bash-output-copy">
                                <Tooltip
                                  value={copiedOutput() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyOutput")}
                                  placement="top"
                                  gutter={4}
                                >
                                  <IconButton
                                    icon={copiedOutput() ? "check" : "copy"}
                                    size="small"
                                    variant="secondary"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={handleCopyOutput}
                                    aria-label={
                                      copiedOutput() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyOutput")
                                    }
                                  />
                                </Tooltip>
                              </div>
                            </Show>
                            <div data-slot="bash-output-body">
                              <Show
                                when={outputOnly()}
                                fallback={
                                  <div data-slot="bash-empty">
                                    {i18n.t("ui.messagePart.activity.commands.status.success")}
                                  </div>
                                }
                              >
                                <div data-slot="bash-scroll" data-scrollable>
                                  <pre data-slot="bash-pre" data-section="output">
                                    <BashCodeOutput raw={cmdRawOutput()} />
                                  </pre>
                                </div>
                              </Show>
                            </div>
                          </div>
                          <div data-slot="bash-status">
                            <Show when={status() === "completed"}>
                              <span data-slot="bash-status-text" data-status="success">
                                <Icon name="check-small" size="small" />
                                {i18n.t("ui.messagePart.activity.commands.status.success")}
                              </span>
                            </Show>
                            <Show when={status() === "error"}>
                              <span data-slot="bash-status-text" data-status="error">
                                <Icon name="close-small" size="small" />
                                {i18n.t("ui.messagePart.activity.commands.status.error")}
                              </span>
                            </Show>
                          </div>
                        </div>
                      </Collapsible.Content>
                    </Collapsible>
                  </div>
                )
              }}
            </Index>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </Show>
  )
}

type EditSummaryItem = (
  | {
      kind: "edit"
      filePath: string
      additions?: number
      deletions?: number
      pending: boolean
      before: { name: string; contents: string }
      after: { name: string; contents: string }
    }
  | { kind: "write"; filePath: string; contents: string }
  | { kind: "apply_patch"; filePath: string; additions: number; deletions: number; fileDiff: unknown }
  | { kind: "streaming"; filePath: string; additions: number; deletions: number; pending: boolean }
) & { review?: ToolPermissionReviewData }

function EditToolGroup(props: { parts: ToolPart[]; busy?: boolean }) {
  const data = useData()
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const [open, setOpen] = createSignal(true)
  const [fileContextPath, setFileContextPath] = createSignal("")
  const [fileContextPosition, setFileContextPosition] = createSignal({ x: 0, y: 0 })
  const [fileContextOpen, setFileContextOpen] = createSignal(false)
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )

  const items = createMemo<EditSummaryItem[]>(() => {
    const out: EditSummaryItem[] = []
    for (const part of props.parts) {
      const review = parseToolPermissionReview(toolMetadata(part)?.permissionReview)
      // 完成前（生成/执行中）统一走实时估算：用流式 raw / 已解析 input 估算文件名与增删行，
      // 让计数器随内容流入逐行往上跳；完成时再切回下面基于 filediff 的精确渲染。
      if (part.state.status !== "completed") {
        for (const [index, live] of liveEditEstimates(part).entries())
          out.push({
            kind: "streaming",
            filePath: live.filePath,
            additions: live.additions,
            deletions: live.deletions,
            pending: live.pending,
            review: index === 0 ? review : undefined,
          })
        continue
      }

      if (part.tool === "edit") {
        const filediff = objectValue(toolMetadata(part)?.filediff) as Record<string, unknown> | undefined
        const filePath = (stringValue(filediff?.file) ?? stringValue(toolInput(part)?.filePath) ?? "").toString()
        if (!filePath) continue
        const oldString = (stringValue(toolInput(part)?.oldString) ?? "").toString()
        const newString = (stringValue(toolInput(part)?.newString) ?? "").toString()
        out.push({
          kind: "edit",
          filePath,
          additions: typeof filediff?.additions === "number" ? filediff.additions : undefined,
          deletions: typeof filediff?.deletions === "number" ? filediff.deletions : undefined,
          // 完成前的编辑已在上面按 streaming 处理，走到这里的都是 completed
          pending: false,
          before: { name: filePath, contents: (stringValue(filediff?.before) ?? oldString).toString() },
          after: { name: filePath, contents: (stringValue(filediff?.after) ?? newString).toString() },
          review,
        })
        continue
      }

      if (part.tool === "write") {
        const filePath = (stringValue(toolInput(part)?.filePath) ?? "").toString()
        if (!filePath) continue
        out.push({
          kind: "write",
          filePath,
          contents: (stringValue(toolInput(part)?.content) ?? "").toString(),
          review,
        })
        continue
      }

      if (part.tool === "apply_patch") {
        const list = patchFiles(toolMetadata(part)?.files)
        for (const [index, f] of list.entries()) {
          out.push({
            kind: "apply_patch",
            filePath: f.filePath,
            additions: f.additions,
            deletions: f.deletions,
            fileDiff: f.view.fileDiff,
            review: index === 0 ? review : undefined,
          })
        }
      }
    }
    return out
  })

  const count = createMemo(() => items().length)
  const titleText = createMemo(() =>
    pending() ? i18n.t("ui.messagePart.activity.edits.active") : i18n.t("ui.messagePart.activity.edits.done"),
  )

  const resolveFilePath = (filePath: string) => resolveWorkspaceFilePath(data.directory, filePath)

  const openPath = async (filePath: string, ctrlKey?: boolean, metaKey?: boolean) => {
    const absolute = resolveFilePath(filePath)
    const browserTarget = resolveEditActivityFileClick({
      absolutePath: absolute,
      ctrlKey,
      metaKey,
      canOpenExternal: !!data.openExternalLink,
      canOpenSystem: !!data.openSystemBrowserLink,
    })
    if (browserTarget?.type === "system" && data.openSystemBrowserLink) {
      await data.openSystemBrowserLink(browserTarget.value)
      return
    }
    if (browserTarget?.type === "builtin" && data.openExternalLink) {
      await data.openExternalLink(browserTarget.value)
      return
    }
    const api = (globalThis as any).api as { openPath?: (path: string) => Promise<void> } | undefined
    await api?.openPath?.(absolute)
  }

  // 活动行里的文件名不是 Markdown 链接，右键时要手动接入同一套文件菜单。
  const onEditActivityFileContextMenu = (event: MouseEvent, filePath: string) => {
    if (!data.fileContextMenuActions) return
    event.preventDefault()
    event.stopPropagation()
    setFileContextPath(resolveFilePath(filePath))
    setFileContextPosition({ x: event.clientX, y: event.clientY })
    setFileContextOpen(true)
  }

  return (
    <Show when={count() > 0}>
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost" class="tool-collapsible">
        <Collapsible.Trigger>
          <div data-component="activity-tool-group-trigger" data-kind="edit">
            <span
              data-slot="activity-tool-group-title"
              class="min-w-0 flex items-center gap-2 text-14-medium text-text-weak"
            >
              <Icon name="edit-file" size="small" class="shrink-0 text-text-weak scale-[0.88]" />
              <span data-slot="activity-tool-group-label" class="shrink-0">
                {titleText()}
              </span>
              <span
                data-slot="activity-tool-group-summary"
                class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-weak"
              >
                <AnimatedCountLabel
                  one={i18n.t("ui.messagePart.activity.edits.one")}
                  other={i18n.t("ui.messagePart.activity.edits.other")}
                  count={count()}
                />
              </span>
            </span>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-component="activity-tool-group-list" data-kind="edit">
            <Index each={items()}>
              {(itemAccessor) => {
                const item = createMemo(() => itemAccessor())
                const filename = createMemo(() => getFilename(item().filePath))
                const changes = createMemo(() => {
                  const current = item()
                  if (current.kind === "streaming" || current.kind === "apply_patch")
                    return { additions: current.additions, deletions: current.deletions }
                  if (current.kind === "edit") {
                    const additions = current.additions
                    const deletions = current.deletions
                    if (typeof additions === "number" && typeof deletions === "number") return { additions, deletions }
                    // 运行中先挂在 0，完成时值到达触发里程表滚动
                    if (current.pending) return { additions: 0, deletions: 0 }
                  }
                  return undefined
                })
                const changesPending = createMemo(() => {
                  const current = item()
                  return (current.kind === "streaming" && current.pending) || (current.kind === "edit" && current.pending)
                })
                const [childOpen, setChildOpen] = createSignal(false)
                return (
                  <div data-slot="activity-tool-group-item" data-kind="edit">
                    <Collapsible
                      open={childOpen()}
                      onOpenChange={setChildOpen}
                      variant="ghost"
                      class="tool-collapsible"
                    >
                      <Collapsible.Trigger>
                        <div data-slot="activity-tool-item-row">
                          <span data-slot="activity-tool-item-prefix">
                            {item().kind === "streaming" && (item() as { pending: boolean }).pending
                              ? i18n.t("ui.messagePart.activity.edits.active")
                              : i18n.t("ui.messagePart.activity.edits.done")}
                          </span>
                          <button
                            type="button"
                            data-slot="activity-tool-item-file"
                            data-absolute-path={resolveFilePath(item().filePath)}
                            onClick={(e) => {
                              e.stopPropagation()
                              void openPath(item().filePath, e.ctrlKey, e.metaKey)
                            }}
                            onContextMenu={(event) => onEditActivityFileContextMenu(event, item().filePath)}
                          >
                            {filename()}
                          </button>
                          <Show when={changes()}>
                            <span data-slot="activity-tool-item-diff">
                              <DiffChanges changes={changes()!} pending={changesPending()} />
                            </span>
                          </Show>
                          <ToolPermissionReview review={item().review} />
                          <Collapsible.Arrow />
                        </div>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <div data-component="activity-edit-preview">
                          {(() => {
                            const current = item()
                            // 生成/执行中还没有可展示的 diff，仅显示行数跳动，预览留空
                            if (current.kind === "streaming") return null
                            if (current.kind === "apply_patch") {
                              return <Dynamic component={fileComponent} mode="diff" fileDiff={current.fileDiff} />
                            }
                            if (current.kind === "edit") {
                              return (
                                <Dynamic
                                  component={fileComponent}
                                  mode="diff"
                                  before={current.before}
                                  after={current.after}
                                />
                              )
                            }
                            return (
                              <Dynamic
                                component={fileComponent}
                                mode="text"
                                file={{
                                  name: current.filePath,
                                  contents: current.contents,
                                  cacheKey: checksum(current.contents),
                                }}
                                overflow="scroll"
                              />
                            )
                          })()}
                        </div>
                      </Collapsible.Content>
                    </Collapsible>
                  </div>
                )
              }}
            </Index>
            <Show when={data.fileContextMenuActions}>
              <FileLinkContextMenu
                absolutePath={fileContextPath()}
                position={fileContextPosition()}
                open={fileContextOpen()}
                onOpenChange={setFileContextOpen}
                actions={data.fileContextMenuActions!}
              />
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </Show>
  )
}

const PREVIEW_LEN = 280

function UserMessageExcerptTag(props: { excerpts: string[] }) {
  const i18n = useI18n()
  const label = createMemo(() => {
    const n = props.excerpts.length
    return i18n.t(n === 1 ? "ui.message.excerptSelection.one" : "ui.message.excerptSelection.other", { count: n })
  })
  const tooltipBody = createMemo(() => (
    <div class="flex max-w-[min(90vw,22rem)] max-h-56 flex-col gap-2 overflow-y-auto text-left text-12-regular text-text-invert-base">
      <For each={props.excerpts}>
        {(snippet) => {
          const body = snippet.length > PREVIEW_LEN ? `${snippet.slice(0, PREVIEW_LEN)}…` : snippet
          return (
            <div class="min-w-0 whitespace-pre-wrap break-words text-12-regular leading-snug">
              {'"'}
              {body}
              {'"'}
            </div>
          )
        }}
      </For>
    </div>
  ))
  return (
    <div data-slot="user-message-excerpts" class="mb-2">
      <div class="inline-flex max-w-full items-center rounded-full border border-border-weak-base bg-background-stronger">
        <Tooltip value={tooltipBody()} placement="top" openDelay={400}>
          <div
            role="note"
            data-component="user-message-excerpt-tag"
            aria-label={i18n.t("ui.message.excerptCard")}
            class="inline-flex min-w-0 max-w-[min(100%,14rem)] cursor-default select-none items-center gap-1.5 py-1 pl-2 pr-2.5 text-12-regular text-text-strong"
          >
            <Icon name="speech-bubble" size="small" class="shrink-0 text-icon-weak" />
            <span class="min-w-0 truncate">{label()}</span>
          </div>
        </Tooltip>
      </div>
    </div>
  )
}

const USER_MESSAGE_COLLAPSE_CHARS = 420
const USER_MESSAGE_COLLAPSE_LINES = 8

function UserMessageText(props: {
  text: string
  skillMessage: boolean
  references: FilePart[]
  agents: AgentPart[]
  part?: TextPart
  onDblClick: () => void
}) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const shouldCollapse = createMemo(() => {
    const value = props.text.trim()
    if (!value) return false
    return value.length > USER_MESSAGE_COLLAPSE_CHARS || value.split(/\r?\n/).length > USER_MESSAGE_COLLAPSE_LINES
  })
  const collapsed = createMemo(() => shouldCollapse() && !expanded())

  createEffect(() => {
    props.text
    setExpanded(false)
  })

  return (
    <div data-slot="user-message-text-wrap" data-collapsible={shouldCollapse() ? "true" : undefined}>
      <div
        data-slot="user-message-text"
        data-content={props.skillMessage ? "skill" : undefined}
        data-collapsed={collapsed() ? "true" : undefined}
        onDblClick={props.onDblClick}
      >
        <HighlightedText text={props.text} references={props.references} agents={props.agents} part={props.part} />
        <Show when={shouldCollapse()}>
          <button
            type="button"
            data-slot="user-message-expand-toggle"
            aria-expanded={expanded()}
            onClick={(event) => {
              event.stopPropagation()
              setExpanded((value) => !value)
            }}
          >
            <span>{expanded() ? i18n.t("ui.message.collapse") : i18n.t("ui.message.expand")}</span>
            <Icon name="chevron-down" size="small" aria-hidden="true" />
          </button>
        </Show>
      </div>
    </div>
  )
}

export function UserMessageDisplay(props: { message: UserMessage; parts: PartType[]; actions?: UserActions }) {
  const data = useData()
  const imagePreview = useImagePreview()
  const i18n = useI18n()
  const [state, setState] = createStore({
    copied: false,
    busy: false,
    editing: false,
    draft: "",
  })
  const copied = () => state.copied
  const busy = () => state.busy
  const editing = () => state.editing
  const draft = () => state.draft
  // 思考过程未结束(会话忙)时禁止编辑：双击气泡与「编辑」按钮两个入口都受此限制。
  const editLocked = createMemo(() => busy() || !!props.actions?.sessionBusy?.())

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")
  const skillMessage = createMemo(() => !!skillMetadata(textPart()))

  const addToChatDisplay = createMemo(() => parseAddToChatUserMessageDisplay(text()))

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() => files().filter(attached))

  const imageAttachments = createMemo(() => attachments().filter((f) => f.mime.startsWith("image/")))
  const fileAttachments = createMemo(() => attachments().filter((f) => !f.mime.startsWith("image/")))

  const inlineFiles = createMemo(() => files().filter(inline))

  const agents = createMemo(() => (props.parts?.filter((p) => p.type === "agent") as AgentPart[]) ?? [])

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.find((p) => p.id === providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return timefmt().format(created)
  })

  const metaHead = createMemo(() => {
    const agent = props.message.agent
    const items = [agent ? agent[0]?.toUpperCase() + agent.slice(1) : "", model()]
    return items.filter((x) => !!x).join("\u00A0\u00B7\u00A0")
  })

  const metaTail = stamp

  const openImagePreview = (file: FilePart) => {
    const images = imageAttachments().map((item) => ({
      src: item.url,
      alt: item.filename ?? i18n.t("ui.message.attachment.alt"),
    }))
    const initialIndex = Math.max(0, imageAttachments().findIndex((item) => item.url === file.url))
    imagePreview.show({
      src: file.url,
      alt: file.filename ?? i18n.t("ui.message.attachment.alt"),
      images,
      initialIndex,
    })
  }
  const [attachmentContextPath, setAttachmentContextPath] = createSignal("")
  const [attachmentContextPosition, setAttachmentContextPosition] = createSignal({ x: 0, y: 0 })
  const [attachmentContextOpen, setAttachmentContextOpen] = createSignal(false)
  const openFileAttachment = (url: string) => {
    const path = localFilePathFromPartUrl(url)
    if (!path) return
    if (isHtmlFilePath(path) && data.fileContextMenuActions?.openInBrowser) {
      void data.fileContextMenuActions.openInBrowser(path)
      return
    }
    // 左键直接执行右键菜单首项，确保“直接点击”和“在 Cursor 中打开”保持同一套 opener 选择。
    const opener = data.fileContextMenuActions ? primaryFileContextOpener(data.fileContextMenuActions, path) : undefined
    void (opener ? opener.onSelect() : data.openLocalPath?.(path))
  }
  const onFileAttachmentContextMenu = (event: MouseEvent, url: string) => {
    if (!data.fileContextMenuActions) return
    const path = localFilePathFromPartUrl(url)
    if (!path) return
    event.preventDefault()
    event.stopPropagation()
    setAttachmentContextPath(path)
    setAttachmentContextPosition({ x: event.clientX, y: event.clientY })
    setAttachmentContextOpen(true)
  }

  const handleCopy = async () => {
    const raw = text()
    if (!raw) return
    const parsed = addToChatDisplay()
    const content =
      parsed && (parsed.excerpts.length > 0 || parsed.body.trim())
        ? [...parsed.excerpts.map((ex) => `"${ex}"`), parsed.body.trim() ? parsed.body.trim() : undefined]
            .filter((x): x is string => !!x)
            .join("\n\n")
        : raw
    await navigator.clipboard.writeText(content)
    setState("copied", true)
    setTimeout(() => setState("copied", false), 2000)
  }

  const revert = () => {
    const act = props.actions?.revert
    if (!act || busy()) return
    setState("busy", true)
    void Promise.resolve()
      .then(() =>
        act({
          sessionID: props.message.sessionID,
          messageID: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  const handleEdit = (newText: string) => {
    const act = props.actions?.edit
    if (!act || busy()) return
    const parsed = addToChatDisplay()
    const newWire =
      parsed && parsed.excerpts.length > 0
        ? composeAddToChatUserMessage(parsed.excerpts, newText.trim())
        : newText.trim()
    const result = act({
      sessionID: props.message.sessionID,
      messageID: props.message.id,
      newText: newWire,
    })
    if (result && "then" in result) {
      result.then(() => setState({ editing: false, draft: "" }))
    } else {
      setState({ editing: false, draft: "" })
    }
  }

  const cancelEdit = () => setState({ editing: false, draft: "" })

  const startEdit = () => {
    if (editLocked()) return
    const parsed = addToChatDisplay()
    setState({ editing: true, draft: parsed ? parsed.body : text() })
  }

  return (
    <div data-component="user-message" data-state={props.actions?.isQueued?.(props.message.id) ? "queued" : undefined}>
      <Show when={props.message.automationID}>
        <div data-slot="user-message-automation-badge">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
            <path
              d="M12 7v5l3 2"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{i18n.t("ui.message.sentViaAutomation")}</span>
        </div>
      </Show>
      <Show when={attachments().length > 0}>
        <div data-slot="user-message-attachments">
          <Show when={imageAttachments().length > 0}>
            <div data-slot="user-message-attachment-row">
              <For each={imageAttachments()}>
                {(file) => {
                  const name = file.filename ?? i18n.t("ui.message.attachment.alt")

                  return (
                    <div
                      data-slot="user-message-attachment"
                      data-type="image"
                      data-clickable="true"
                      onClick={() => openImagePreview(file)}
                    >
                      <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
          <Show when={fileAttachments().length > 0}>
            <div data-slot="user-message-attachment-row">
              <For each={fileAttachments()}>
                {(file) => {
                  const name = file.filename ?? i18n.t("ui.message.attachment.alt")

                  return (
                    <div
                      data-slot="user-message-attachment"
                      data-type="file"
                      data-context-menu={data.fileContextMenuActions ? "true" : undefined}
                      data-clickable="true"
                      title={name}
                      onClick={() => openFileAttachment(file.url)}
                      onContextMenu={(event) => onFileAttachmentContextMenu(event, file.url)}
                    >
                      <FileAttachmentItem filename={name} path={file.url} />
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
          <Show when={data.fileContextMenuActions}>
            <FileLinkContextMenu
              absolutePath={attachmentContextPath()}
              position={attachmentContextPosition()}
              open={attachmentContextOpen()}
              onOpenChange={setAttachmentContextOpen}
              actions={data.fileContextMenuActions!}
            />
          </Show>
        </div>
      </Show>
      <Show when={text()}>
        <Show
          when={editing()}
          fallback={
            <>
              <div data-slot="user-message-row">
                <div data-slot="user-message-body">
                  <Show when={addToChatDisplay()} keyed>
                    {(parsed) => (
                      <>
                        <UserMessageExcerptTag excerpts={parsed.excerpts} />
                        <Show when={parsed.body.trim()}>
                          <UserMessageText
                            text={parsed.body}
                            skillMessage={skillMessage()}
                            references={inlineFiles()}
                            agents={agents()}
                            part={textPart()}
                            onDblClick={startEdit}
                          />
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={!addToChatDisplay()}>
                    <UserMessageText
                      text={text()}
                      skillMessage={skillMessage()}
                      references={inlineFiles()}
                      agents={agents()}
                      part={textPart()}
                      onDblClick={startEdit}
                    />
                  </Show>
                </div>
                <Show when={props.actions?.isQueued?.(props.message.id) && props.actions?.deleteQueued}>
                  <span data-slot="user-message-cancel">
                    <Tooltip value={i18n.t("ui.common.cancel")} placement="top" gutter={4}>
                      <IconButton
                        icon="close-small"
                        size="normal"
                        variant="ghost"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation()
                          void props.actions?.deleteQueued?.({
                            sessionID: props.message.sessionID,
                            messageID: props.message.id,
                          })
                        }}
                        aria-label={i18n.t("ui.common.cancel")}
                      />
                    </Tooltip>
                  </span>
                </Show>
              </div>
              {/* 复刻 Codex：这条消息是当前会话目标时，气泡下方常驻「◎ 目标」标识（非按钮，不随 hover） */}
              <Show
                when={(() => {
                  const objective = props.actions?.goalObjective?.(props.message.sessionID)
                  return !!objective && objective.trim() === text().trim()
                })()}
              >
                <div
                  data-slot="user-message-goal-badge"
                  class="mt-1 flex w-full items-center justify-end gap-1 text-12-regular text-text-weak"
                >
                  <Icon name="target" size="small" aria-hidden="true" />
                  <span>{i18n.t("ui.message.setGoal")}</span>
                </div>
              </Show>
              <div data-slot="user-message-copy-wrapper">
                <Show when={metaHead() || metaTail()}>
                  <span data-slot="user-message-meta-wrap">
                    <Show when={metaHead()}>
                      <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
                        {metaHead()}
                      </span>
                    </Show>
                    <Show when={metaHead() && metaTail()}>
                      <span data-slot="user-message-meta-sep" class="text-12-regular text-text-weak cursor-default">
                        {"\u00A0\u00B7\u00A0"}
                      </span>
                    </Show>
                    <Show when={metaTail()}>
                      <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
                        {metaTail()}
                      </span>
                    </Show>
                  </span>
                </Show>
                <Tooltip
                  value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
                  placement="top"
                  gutter={4}
                >
                  <IconButton
                    icon={copied() ? "check" : "copy"}
                    size="normal"
                    variant="ghost"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleCopy()
                    }}
                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
                  />
                </Tooltip>
                <Show when={props.actions?.edit}>
                  <Tooltip
                    value={
                      editLocked()
                        ? i18n.t("ui.message.editLockedThinking")
                        : i18n.t("ui.message.editMessage")
                    }
                    placement="top"
                    gutter={4}
                  >
                    <IconButton
                      icon="pencil-line"
                      size="normal"
                      variant="ghost"
                      disabled={editLocked()}
                      // 禁用态的原生 button 不会派发指针事件，导致 Tooltip 无法在悬浮时弹出；
                      // 关闭其指针事件让悬浮落到外层 Tooltip 触发器，从而显示「AI生成中，无法编辑」。
                      style={{ "pointer-events": editLocked() ? "none" : undefined }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation()
                        startEdit()
                      }}
                      aria-label={
                        editLocked()
                          ? i18n.t("ui.message.editLockedThinking")
                          : i18n.t("ui.message.editMessage")
                      }
                    />
                  </Tooltip>
                </Show>
              </div>
            </>
          }
        >
          <Show when={addToChatDisplay()} keyed>
            {(parsed) => (
              <>
                <div data-slot="user-message-body" class="mb-2">
                  <UserMessageExcerptTag excerpts={parsed.excerpts} />
                </div>
                <MessageEditBox
                  initialText={draft()}
                  allowEmptySubmit={parsed.excerpts.length > 0}
                  onSend={handleEdit}
                  onCancel={cancelEdit}
                />
              </>
            )}
          </Show>
          <Show when={!addToChatDisplay()}>
            <MessageEditBox initialText={draft()} onSend={handleEdit} onCancel={cancelEdit} />
          </Show>
        </Show>
      </Show>
    </div>
  )
}

type HighlightSegment =
  | {
      text: string
      type?: "file" | "agent"
      addonKey?: undefined
      skill?: undefined
      conversationID?: undefined
    }
  | { text: string; type: "plugin"; addonKey: string; skill?: undefined; conversationID?: undefined }
  | { text: string; type: "skill"; addonKey?: undefined; skill: SkillRef; conversationID?: undefined }
  | { text: string; type: "conversation"; addonKey?: undefined; skill?: undefined; conversationID: string }
  | {
      text: string
      type: "prompt-link"
      addonKey?: undefined
      skill?: undefined
      conversationID?: undefined
      href: string
      linkKind: PromptLinkKind
    }

// 与 Codex 兼容的插件 mention markdown link: `[@<name>](plugin://<addon>@<marketplace>)`
// 渲染为 chip 时只显示 `@<name>`,把整段 markdown 隐去。
type PluginRef = { start: number; end: number; type: "plugin"; name: string; addonKey: string }
function findPluginRefs(text: string): PluginRef[] {
  return parseMentionLinks(text, ["plugin"]).map((link) => ({
    start: link.start,
    end: link.end,
    type: "plugin" as const,
    name: link.label,
    addonKey: link.id,
  }))
}

function PluginChip(props: { name: string; addonKey: string }) {
  const data = useData()
  const meta = createMemo(() => data.resolvePluginMeta?.(props.addonKey))
  const label = createMemo(() => meta()?.display_name?.trim() || props.name)
  const color = createMemo(() => meta()?.brand_color)
  const clickable = () => !!data.openPluginDetail
  const open = () => void data.openPluginDetail?.(props.addonKey)
  return (
    <span
      data-highlight="plugin"
      data-plugin-key={props.addonKey}
      data-clickable={clickable() ? "" : undefined}
      role={clickable() ? "button" : undefined}
      tabindex={clickable() ? 0 : undefined}
      aria-label={clickable() ? `打开插件 ${label()}` : undefined}
      style={color() ? { color: color() } : undefined}
      onClick={
        clickable()
          ? (event: MouseEvent) => {
              event.stopPropagation()
              open()
            }
          : undefined
      }
      onKeyDown={
        clickable()
          ? (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                open()
              }
            }
          : undefined
      }
    >
      <Show when={meta()?.logo}>
        <img src={meta()!.logo} alt="" data-slot="plugin-chip-logo" />
      </Show>
      <span data-slot="plugin-chip-label">{label()}</span>
    </span>
  )
}

function ConversationChip(props: { id: string; title: string }) {
  const data = useData()
  const clickable = () => !!data.openConversation
  return (
    <span
      data-highlight="conversation"
      data-conversation-id={props.id}
      data-clickable={clickable() ? "" : undefined}
      role={clickable() ? "button" : undefined}
      tabindex={clickable() ? 0 : undefined}
      onClick={
        clickable()
          ? (event: MouseEvent) => {
              event.stopPropagation()
              void data.openConversation?.(props.id)
            }
          : undefined
      }
      onKeyDown={
        clickable()
          ? (event: KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              void data.openConversation?.(props.id)
            }
          : undefined
      }
    >
      <Icon name="speech-bubble" size="small" />
      <span>{props.title}</span>
    </span>
  )
}

function skillMetadata(part: TextPart | undefined): SkillRef | undefined {
  const skill = part?.metadata?.skill
  if (!skill || typeof skill !== "object") return undefined
  const raw = skill as Record<string, unknown>
  if (typeof raw.name !== "string" || !raw.name.trim()) return undefined
  return {
    name: raw.name.trim(),
    location: typeof raw.location === "string" && raw.location.trim() ? raw.location : undefined,
    arguments: typeof raw.arguments === "string" && raw.arguments.trim() ? raw.arguments.trim() : undefined,
  }
}

function MessageSkillChip(props: { skill: SkillRef }) {
  const data = useData()
  return <SharedSkillChip skill={props.skill} openSkillFile={useSkillFile() ?? data.openSkillFile} />
}

type PromptLinkRef = PromptLinkMatch & { type: "prompt-link" }

function HighlightedText(props: { text: string; references: FilePart[]; agents: AgentPart[]; part?: TextPart }) {
  const segments = createMemo(() => {
    const text = props.text
    const skill = skillMetadata(props.part)
    if (skill) {
      return [
        { text: skillDisplayName(skill.name), type: "skill" as const, skill },
        ...(skill.arguments ? [{ text: ` ${skill.arguments}` }] : []),
      ]
    }

    const conversationRefs = parseConversationReferences(text).map((reference) => ({
      ...reference,
      type: "conversation" as const,
    }))
    // 持久化文本里的 Markdown 文件引用与裸 URL 在这里恢复为结构化节点；特殊 mention 仍拥有更高优先级。
    const promptLinks: PromptLinkRef[] = findPromptLinkMatches(text).map((reference) => ({
      ...reference,
      type: "prompt-link",
    }))
    const allRefs: Array<
      | { start: number; end: number; type: "file" | "agent" }
      | PluginRef
      | (typeof conversationRefs)[number]
      | PromptLinkRef
    > = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
      ...findPluginRefs(text),
      ...conversationRefs,
      ...promptLinks,
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      if (ref.type === "plugin") {
        // 显示 `@<name>` 而不是原始 markdown,addon key 透传到 dom attr 备后端 part 实装时关联
        result.push({ text: `@${ref.name}`, type: "plugin", addonKey: ref.addonKey })
      } else if (ref.type === "conversation") {
        result.push({ text: ref.title, type: "conversation", conversationID: ref.id })
      } else if (ref.type === "prompt-link") {
        // 只展示用户写下的 label，完整本地路径仅保留为点击目标和 title，不再泄露到消息正文。
        result.push({ text: ref.displayText, type: "prompt-link", href: ref.href, linkKind: ref.kind })
      } else {
        result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      }
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return (
    <For each={segments()}>
      {(segment) =>
        segment.type === "plugin" ? (
          <PluginChip
            name={segment.text.startsWith("@") ? segment.text.slice(1) : segment.text}
            addonKey={segment.addonKey}
          />
        ) : segment.type === "conversation" ? (
          <ConversationChip id={segment.conversationID} title={segment.text} />
        ) : segment.type === "skill" ? (
          <MessageSkillChip skill={segment.skill} />
        ) : segment.type === "prompt-link" ? (
          <UserPromptLink text={segment.text} href={segment.href} kind={segment.linkKind} />
        ) : (
          <span data-highlight={segment.type}>{segment.text}</span>
        )
      }
    </For>
  )
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        actions={props.actions}
        onTextRendered={props.onTextRendered}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

function ImageGenerationPlanDeniedDetails(props: { metadata: Record<string, unknown> }) {
  const data = useData()
  const i18n = useI18n()
  const upgradePlans = createMemo(() => parseImageGenerationUpgradePlans(props.metadata.upgradePlans))
  const metadataSupportedPlans = createMemo(() => parseImageGenerationUpgradePlans(props.metadata.supportedPlans))
  const metadataPurchaseEnabled = createMemo(() => parseImageGenerationMetadataFlag(props.metadata.purchaseEnabled))
  const metadataPlanCatalogAvailable = createMemo(() =>
    parseImageGenerationMetadataFlag(props.metadata.planCatalogAvailable),
  )
  // 目录失败或历史关闭都会持久化 supportedPlans=[]；只有成功目录或兼容旧版的非空列表才是完整结论。
  const hasAuthoritativeMetadataSupportedPlans = createMemo(
    () =>
      Array.isArray(props.metadata.supportedPlans) &&
      (metadataPlanCatalogAvailable() === true ||
        (metadataPlanCatalogAvailable() === undefined && metadataSupportedPlans().length > 0)),
  )
  const cachedPlanCatalog = createMemo(() => data.purchasePlanCatalog?.())
  const cachedSupportedPlans = createMemo(() => parseImageGenerationStorefrontPlans(cachedPlanCatalog()?.plans))
  // 新消息的完整 supportedPlans 最优先；旧消息先用当前真实目录，目录尚未成功时才用 upgradePlans 临时兜底。
  const supportedPlans = createMemo(() => {
    if (hasAuthoritativeMetadataSupportedPlans()) return metadataSupportedPlans()
    if (cachedPlanCatalog() !== null && cachedPlanCatalog() !== undefined) return cachedSupportedPlans()
    return upgradePlans()
  })
  const [catalogRequested, setCatalogRequested] = createSignal(false)
  createEffect(() => {
    if (cachedPlanCatalog() !== undefined) {
      if (catalogRequested()) setCatalogRequested(false)
      return
    }
    if (hasAuthoritativeMetadataSupportedPlans() || catalogRequested()) return
    const load = data.loadPurchasePlanCatalog
    if (!load) return
    // 多个历史拒绝卡可同时触发；宿主 QueryClient 会合并同一 query key 的真实请求。
    setCatalogRequested(true)
    void load().catch(() => {})
  })
  // 缓存来自当前账号，优先于历史 metadata；两侧都只接受真实布尔值。
  const purchaseEnabled = createMemo(
    () => parseImageGenerationMetadataFlag(cachedPlanCatalog()?.enabled) ?? metadataPurchaseEnabled(),
  )
  const planCatalogAvailable = createMemo(() => {
    if (cachedPlanCatalog() === null) return false
    if (cachedPlanCatalog() !== undefined) return true
    return metadataPlanCatalogAvailable()
  })
  const purchaseUrl = createMemo(() => {
    const cached = cachedPlanCatalog()?.purchase_url
    if (typeof cached === "string" && cached.trim()) return cached
    return props.metadata.purchaseUrl
  })
  const target = createMemo(() =>
    resolveImageGenerationUpgradeTarget({
      supportedPlans: supportedPlans(),
      upgradePlans: upgradePlans(),
      purchaseEnabled: purchaseEnabled(),
      planCatalogAvailable: planCatalogAvailable(),
      hasInAppHandler: !!data.openPurchasePlans,
      hasExternalHandler: !!data.openExternalLink,
      purchaseUrl: purchaseUrl(),
    }),
  )

  // 点击升级时优先保留 app 内登录态；只有宿主没有用户中心能力时才调用已校验的公开购买地址。
  const openUpgrade = () => {
    const next = target()
    if (next?.type === "in-app") {
      void data.openPurchasePlans?.()
      return
    }
    if (next?.type === "external") void data.openExternalLink?.(next.url)
  }

  return (
    <div data-slot="image-generation-plan-denied" class="mt-3 grid gap-1.5">
      <Show
        when={supportedPlans().length > 0}
        fallback={
          <div class="grid gap-1">
            <span class="text-13-medium text-text-strong">{i18n.t("ui.imageGeneration.planDenied.plansTitle")}</span>
            <span class="text-12-regular leading-normal text-text-weak">
              {i18n.t(
                purchaseEnabled() === false
                  ? "ui.imageGeneration.planDenied.plansDisabled"
                  : planCatalogAvailable() === true
                    ? "ui.imageGeneration.planDenied.plansEmpty"
                    : "ui.imageGeneration.planDenied.plansUnavailable",
              )}
            </span>
          </div>
        }
      >
        <div data-slot="image-generation-supported-plans" class="flex min-w-0 flex-wrap items-baseline gap-1">
          <span class="text-13-regular text-text-weak">{i18n.t("ui.imageGeneration.planDenied.plansLabel")}</span>
          <span class="min-w-0 break-words text-13-medium text-text-strong">
            {formatImageGenerationPlanNames(supportedPlans(), i18n.locale())}
          </span>
        </div>
      </Show>
      <Show when={target()}>
        <button
          type="button"
          data-slot="image-generation-purchase-plans-link"
          class="w-fit cursor-pointer text-left text-12-regular text-text-interactive-base hover:underline focus-visible:underline"
          onClick={openUpgrade}
        >
          {i18n.t("ui.imageGeneration.planDenied.upgrade")}
        </button>
      </Show>
    </div>
  )
}

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`\u202A${getDirectory(props.path)}\u202C`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}
  const toolImageAttachment = (item: FilePart) => {
    if (item.filename?.startsWith("wanlai-image-loading-")) return false
    return item.mime.startsWith("image/") || !!item.filename?.startsWith("wanlai-image-")
  }

  const input = () => part().state?.input ?? emptyInput
  const partMetadata = () => {
    const state = part().state as { metadata?: Record<string, any>; attachments?: FilePart[] }
    const metadata = state.metadata ?? emptyMetadata
    if (part().tool !== "image_generation") return metadata
    const attachments = (state.attachments ?? []).filter(toolImageAttachment)
    if (attachments.length === 0) return metadata
    return { ...metadata, generatedImageAttachmentCount: attachments.length }
  }
  const taskId = createMemo(() => {
    if (part().tool !== "task") return
    const value = partMetadata().sessionId
    if (typeof value === "string" && value) return value
  })
  const taskHref = createMemo(() => {
    if (part().tool !== "task") return
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref)
  })
  const taskSubtitle = createMemo(() => {
    if (part().tool !== "task") return undefined
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })
  const errorText = createMemo(() => {
    if (part().state.status !== "error") return ""
    if (part().tool === "image_generation" && ((part().state as { attachments?: FilePart[] }).attachments ?? []).some(toolImageAttachment))
      return ""
    return displayToolErrorText((part().state as { error?: unknown }).error, i18n.t)
  })
  const imageGenerationPlanDenied = createMemo(
    () =>
      part().tool === "image_generation" &&
      part().state.status === "error" &&
      partMetadata().imageGenerationPlanDenied === true,
  )
  const permissionReview = createMemo(() => parseToolPermissionReview(partMetadata().permissionReview))

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)

  return (
    <Show when={!hideQuestion()}>
      <div data-component="tool-part-wrapper">
        <ToolPermissionReview review={permissionReview()} />
        <Switch>
          <Match when={errorText()}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")
              if (part().tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-text-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
                  tool={part().tool}
                  error={imageGenerationPlanDenied() ? i18n.t("ui.imageGeneration.planDenied.message") : error()}
                  defaultOpen={imageGenerationPlanDenied() || props.defaultOpen}
                  subtitle={
                    imageGenerationPlanDenied() ? i18n.t("ui.imageGeneration.planDenied.subtitle") : taskSubtitle()
                  }
                  href={taskHref()}
                >
                  {/* 套餐拒绝由服务端 metadata 明确标记，避免普通生图错误误展示升级入口。 */}
                  <Show when={imageGenerationPlanDenied()}>
                    <ImageGenerationPlanDeniedDetails metadata={partMetadata()} />
                  </Show>
                </ToolErrorCard>
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              metadata={partMetadata()}
              // @ts-expect-error
              output={part().state.output}
              status={part().state.status}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

export function MessageDivider(props: { label: string }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} />
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as TextPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && !assistantMessageTerminal(props.message as AssistantMessage),
  )
  const text = () => {
    const raw = (part().text ?? "").trim()
    if (!raw) return raw
    if (props.message.role !== "assistant") return raw
    return displayImageFailureText(raw, i18n.t)
  }
  const [ctxMenuPath, setCtxMenuPath] = createSignal("")
  const [ctxMenuPos, setCtxMenuPos] = createSignal({ x: 0, y: 0 })
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false)
  const openReviewPanel = () => props.actions?.openReviewPanel?.("turn")
  const openMarkdownLocalPath = createMarkdownLocalPathHandler(data)

  const onFileLinkContextMenu = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a.markdown-file-link")
    if (!(link instanceof HTMLAnchorElement)) return
    const abs = link.getAttribute("data-absolute-path")
    if (!abs) return
    e.preventDefault()
    setCtxMenuPath(abs)
    setCtxMenuPos({ x: e.clientX, y: e.clientY })
    setCtxMenuOpen(true)
  }

  return (
    <Show when={text()}>
      <div data-component="text-part">
        <div data-slot="text-part-body" onContextMenu={onFileLinkContextMenu}>
          {/* 不要按 streaming() 在 PacedMarkdown / Markdown 之间切换：那会在流式结束瞬间
              销毁重建整段正文 DOM，浏览器滚动锚点随之消失，正在阅读的用户被直接顶飞。
              PacedMarkdown 在 streaming=false 时由 createPacedValue 立即同步完整文本，
              与直接渲染 Markdown 等价，因此常驻即可。 */}
          <PacedMarkdown
            text={text()}
            cacheKey={part().id}
            streaming={streaming()}
            resolveMarkdownPath={data.resolveMarkdownPath}
            openReviewPanel={props.actions?.openReviewPanel ? openReviewPanel : undefined}
            openLocalPath={openMarkdownLocalPath}
            openSystemBrowserLink={data.openSystemBrowserLink}
            openExternalLink={data.openExternalLink}
            // 必须透传 Markdown 当次真正绘制的展示文本；异步回调时重新读取 part() 会把尚未绘制的迟到 delta
            // 误报为已完成绘制，导致回合展示态提前结束。
            onRenderSettled={(renderedText) =>
              props.onTextRendered?.({ partID: part().id, text: renderedText })
            }
          />
          <Show when={data.fileContextMenuActions}>
            <FileLinkContextMenu
              absolutePath={ctxMenuPath()}
              position={ctxMenuPos()}
              open={ctxMenuOpen()}
              onOpenChange={setCtxMenuOpen}
              actions={data.fileContextMenuActions!}
            />
          </Show>
        </div>
      </div>
    </Show>
  )
}

PART_MAPPING["file"] = function FilePartDisplay(props) {
  const imagePreview = useImagePreview()
  const i18n = useI18n()
  const part = () => props.part as FilePart
  const type = () => kind(part())
  const name = () => part().filename ?? i18n.t("ui.message.attachment.alt")
  const loading = () => name().startsWith("wanlai-image-loading-")

  // 生图占位的 SVG 里编码着请求 size 换算出的 viewBox。解析它拿到宽高比，
  // 一旦算出就锁存：provider 会就地替换同一个 part（id 不变，本组件实例存活），
  // 于是这个比例能继续作用于成图解码前的那一帧，两个状态同高，不产生突变。
  const [aspectRatio, setAspectRatio] = createSignal<string | undefined>()
  createEffect(() => {
    if (aspectRatio() || !loading()) return
    setAspectRatio(loadingImageAspectRatio(part().url))
  })
  const openImagePreview = () => {
    if (loading()) return
    if (type() !== "image") return
    imagePreview.show({ src: part().url, alt: name() })
  }

  return (
    <div
      data-component="assistant-file-part"
      data-type={type()}
      data-loading={loading() ? "true" : undefined}
      data-clickable={!loading() && type() === "image" ? "true" : undefined}
      title={type() === "file" ? name() : undefined}
      // 覆盖 CSS 里的方形兜底：有请求比例时占位与成图解码前都按真实比例预留高度。
      style={aspectRatio() ? { "aspect-ratio": aspectRatio() } : undefined}
      onClick={openImagePreview}
    >
      <Show when={!loading()} fallback={<div data-slot="assistant-file-loading" />}>
        <Show
          when={type() === "image"}
          fallback={
            <div data-slot="assistant-file-card">
              <FileIcon node={{ path: name(), type: "file" }} />
              <span data-slot="assistant-file-name">{name()}</span>
            </div>
          }
        >
          <img data-slot="assistant-file-image" src={part().url} alt={name()} />
        </Show>
      </Show>
    </div>
  )
}

// 思考组级「显示原文」共享状态：由 SessionTurn 在思考组顶部提供一个总开关，
// 组内所有 reasoning part 共用，避免每段各自一个按钮。无 Provider 时回退为 part 自管。
export const ReasoningOriginalContext = createContext<Accessor<boolean>>()

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ReasoningPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && !assistantMessageTerminal(props.message as AssistantMessage),
  )
  // 思考翻译开启时 originalText 只作为「显示原文」来源；默认内容必须来自 text，避免翻译完成前泄露英文。
  // 处于思考组内时由组级 Provider 统一控制；否则 part 自管（兼容其它渲染路径）。
  const groupShowOriginal = useContext(ReasoningOriginalContext)
  const [localShowOriginal, setLocalShowOriginal] = createSignal(false)
  const showOriginal = () => (groupShowOriginal ? groupShowOriginal() : localShowOriginal())
  const hasOriginal = () => !!part().text?.trim() && !!part().originalText?.trim()
  const text = () => (showOriginal() && part().originalText?.trim() ? part().originalText! : (part().text ?? "")).trim()
  const [ctxMenuPath, setCtxMenuPath] = createSignal("")
  const [ctxMenuPos, setCtxMenuPos] = createSignal({ x: 0, y: 0 })
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false)
  const openReviewPanel = () => props.actions?.openReviewPanel?.("turn")
  const openMarkdownLocalPath = createMarkdownLocalPathHandler(data)

  const onFileLinkContextMenu = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a.markdown-file-link")
    if (!(link instanceof HTMLAnchorElement)) return
    const abs = link.getAttribute("data-absolute-path")
    if (!abs) return
    e.preventDefault()
    setCtxMenuPath(abs)
    setCtxMenuPos({ x: e.clientX, y: e.clientY })
    setCtxMenuOpen(true)
  }

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" onContextMenu={onFileLinkContextMenu}>
        {/* 同 text part：常驻 PacedMarkdown，避免流式结束时整段思考 DOM 销毁重建。
            思考区通常位于视口上方，重建会把用户正在读的位置直接顶飞。
            cacheKey 带 :original 后缀，保证切换原文/译文时重新解析。 */}
        <PacedMarkdown
          text={text()}
          cacheKey={part().id + (showOriginal() ? ":original" : "")}
          streaming={streaming()}
          resolveMarkdownPath={data.resolveMarkdownPath}
          openReviewPanel={props.actions?.openReviewPanel ? openReviewPanel : undefined}
          openLocalPath={openMarkdownLocalPath}
          openSystemBrowserLink={data.openSystemBrowserLink}
          openExternalLink={data.openExternalLink}
        />
        <Show when={hasOriginal() && !streaming() && !groupShowOriginal}>
          <button
            type="button"
            data-slot="reasoning-original-toggle-inline"
            class="mt-1 cursor-pointer text-12-regular text-text-interactive-base hover:underline"
            onClick={() => setLocalShowOriginal((v) => !v)}
          >
            {showOriginal() ? i18n.t("ui.reasoning.hideOriginal") : i18n.t("ui.reasoning.showOriginal")}
          </button>
        </Show>
        <Show when={data.fileContextMenuActions}>
          <FileLinkContextMenu
            absolutePath={ctxMenuPath()}
            position={ctxMenuPos()}
            open={ctxMenuOpen()}
            onOpenChange={setCtxMenuOpen}
            actions={data.fileContextMenuActions!}
          />
        </Show>
      </div>
    </Show>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.offset) args.push("offset=" + props.input.offset)
    if (props.input.limit) args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

function ToolOutputMarkdown(props: { text: string }) {
  const data = useData()
  const [ctxMenuPath, setCtxMenuPath] = createSignal("")
  const [ctxMenuPos, setCtxMenuPos] = createSignal({ x: 0, y: 0 })
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false)
  const openMarkdownLocalPath = createMarkdownLocalPathHandler(data)

  const onFileLinkContextMenu = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a.markdown-file-link")
    if (!(link instanceof HTMLAnchorElement)) return
    const abs = link.getAttribute("data-absolute-path")
    if (!abs) return
    e.preventDefault()
    setCtxMenuPath(abs)
    setCtxMenuPos({ x: e.clientX, y: e.clientY })
    setCtxMenuOpen(true)
  }

  return (
    <div onContextMenu={onFileLinkContextMenu}>
      <Markdown
        text={props.text}
        resolveMarkdownPath={data.resolveMarkdownPath}
        openLocalPath={openMarkdownLocalPath}
        openSystemBrowserLink={data.openSystemBrowserLink}
        openExternalLink={data.openExternalLink}
      />
      <Show when={data.fileContextMenuActions}>
        <FileLinkContextMenu
          absolutePath={ctxMenuPath()}
          position={ctxMenuPos()}
          open={ctxMenuOpen()}
          onOpenChange={setCtxMenuOpen}
          actions={data.fileContextMenuActions!}
        />
      </Show>
    </div>
  )
}

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(props.input.path || "/") }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <ToolOutputMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <ToolOutputMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <ToolOutputMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    const openUrl = () => {
      const next = url()
      if (!next) return
      openWebfetchLink(next, data.openExternalLink)
    }
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        clickable={!!url()}
        onTriggerClick={openUrl}
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <span
                  data-slot="basic-tool-tool-subtitle"
                  class="subagent-link"
                >
                  {url()}
                </span>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <span
                data-component="tool-action"
                aria-hidden="true"
              >
                <Icon name="square-arrow-top-right" size="small" />
              </span>
            </Show>
          </div>
        }
      />
    )
  },
})
ToolRegistry.register({
  name: "websearch",
  render(props) {
    const i18n = useI18n()
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: i18n.t("ui.tool.websearch"),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "image_generation",
  render(props) {
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const count = createMemo(() => {
      const value = props.metadata.imageCount
      return typeof value === "number" && Number.isFinite(value) ? value : undefined
    })
    const total = createMemo(() => {
      const value = props.metadata.totalImageCount
      return typeof value === "number" && Number.isFinite(value) ? value : undefined
    })
    const attachmentCount = createMemo(() =>
      typeof props.metadata.generatedImageAttachmentCount === "number" &&
      Number.isFinite(props.metadata.generatedImageAttachmentCount)
        ? Math.max(0, Math.floor(props.metadata.generatedImageAttachmentCount))
        : 0,
    )
    const countLimitText = createMemo(() => {
      const requested = props.metadata.requestedImageCount
      const max = props.metadata.maxImageCount
      const effective = total() ?? count()
      if (
        typeof requested !== "number" ||
        !Number.isFinite(requested) ||
        typeof max !== "number" ||
        !Number.isFinite(max) ||
        typeof effective !== "number" ||
        !Number.isFinite(effective) ||
        requested <= effective
      )
        return undefined
      return `当前最多一次生成${Math.max(1, Math.floor(max))}张图片，所以已先生成${Math.max(1, Math.floor(effective))}张。`
    })
    const subtitle = createMemo(() => {
      if (pending()) {
        const done = count()
        const all = total()
        if (done !== undefined && all !== undefined) return `${done}/${all}`
        return "Generating"
      }
      if (props.output?.trim()) return props.output.trim()
      if (props.status === "error" && attachmentCount() > 0) {
        return `已生成${attachmentCount()}张图片，后续生成已停止。`
      }
      return "No image was returned"
    })
    return (
      <BasicTool
        {...props}
        icon="photo"
        hideDetails
        trigger={
          <div data-slot="basic-tool-tool-info-structured" class="image-generation-output">
            <div data-slot="basic-tool-tool-info-main" class="image-generation-output">
              <span data-slot="basic-tool-tool-title">{pending() ? "Generating image" : "Image generation"}</span>
              <Show when={!pending()}>
                <span data-slot="basic-tool-tool-subtitle" class="image-generation-output">
                  {[countLimitText(), subtitle()].filter(Boolean).join("\n")}
                </span>
              </Show>
              <Show when={pending()}>
                <span data-slot="basic-tool-tool-subtitle">
                  {[subtitle(), countLimitText()].filter(Boolean).join("\n")}
                </span>
              </Show>
            </div>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const location = useLocation()
    const childSessionId = createMemo(() => {
      const value = props.metadata.sessionId
      if (typeof value === "string" && value) return value
      return taskSession(props.input, location.pathname, data.store.session, data.store.agent)
    })
    const agent = createMemo(() => taskAgent(props.input.subagent_type, data.store.agent))
    const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
    const tone = createMemo(() => agent().color)
    const subtitle = createMemo(() => {
      const value = props.input.description
      if (typeof value === "string" && value) return value
      return childSessionId()
    })
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))
    const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

    const open = () => {
      const id = childSessionId()
      if (!id) return
      if (data.navigateToSession) {
        data.navigateToSession(id)
        return
      }
      const value = href()
      if (value) window.location.assign(value)
    }

    const navigate = (event: MouseEvent) => {
      if (!data.navigateToSession) return
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      open()
    }

    const trigger = () => (
      <div data-component="task-tool-card">
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <Show when={running()}>
              <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--icon-interactive-base)" }}>
                <Spinner />
              </span>
            </Show>
            <span data-component="task-tool-title" style={{ color: tone() ?? "var(--text-strong)" }}>
              {title()}
            </span>
            <Show when={subtitle()}>
              <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
            </Show>
          </div>
        </div>
        <Show when={clickable()}>
          <div data-component="task-tool-action">
            <Icon name="square-arrow-top-right" size="small" />
          </div>
        </Show>
      </div>
    )

    return (
      <BasicTool
        icon="task"
        status={props.status}
        trigger={trigger()}
        hideDetails
        triggerHref={href()}
        clickable={clickable()}
        onTriggerClick={navigate}
      />
    )
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = props.input.command ?? props.metadata.command ?? ""
      const out = stripAnsi(props.output || props.metadata.output || "")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const cmdText = createMemo(() => props.input.command ?? props.metadata.command ?? "")
    const outputHtml = createMemo(() => {
      const out = props.output || props.metadata.output || ""
      return out ? "\n\n" + ansiToHtml(out) : ""
    })
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={props.metadata?.background}>
                <span data-slot="bash-background-badge">
                  {i18n.t("ui.tool.shell.background")} ({String(props.metadata?.backgroundId ?? "")})
                </span>
              </Show>
              <Show when={!pending() && props.input.description}>
                <ShellSubmessage text={props.input.description} animate={sawPending} />
              </Show>
            </div>
          </div>
        }
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="small"
                variant="secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </Tooltip>
          </div>
          <div data-slot="bash-scroll" data-scrollable>
            <pre data-slot="bash-pre">
              <BashCommandLine command={cmdText()} suffixHtml={outputHtml()} />
            </pre>
          </div>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.metadata?.filediff?.file || props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    const title = () =>
      pending() ? i18n.t("ui.messagePart.activity.edits.active") : i18n.t("ui.messagePart.activity.edits.done")
    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={title()} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff!} />
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  before={{
                    name: props.metadata?.filediff?.file || props.input.filePath,
                    contents: props.metadata?.filediff?.before || props.input.oldString,
                  }}
                  after={{
                    name: props.metadata?.filediff?.file || props.input.filePath,
                    contents: props.metadata?.filediff?.after || props.input.newString,
                  }}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div data-component="write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: props.input.filePath,
                    contents: props.input.content,
                    cacheKey: checksum(props.input.content),
                  }}
                  overflow="scroll"
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFiles(props.metadata.files))
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const single = createMemo(() => {
      const list = files()
      if (list.length !== 1) return
      return list[0]
    })
    const [expanded, setExpanded] = createSignal<string[]>([])
    let seeded = false

    createEffect(() => {
      const list = files()
      if (list.length === 0) return
      if (seeded) return
      seeded = true
      setExpanded(list.filter((f) => f.type !== "delete").map((f) => f.filePath))
    })

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
    })

    return (
      <Show
        when={single()}
        fallback={
          <div data-component="apply-patch-tool">
            <BasicTool
              {...props}
              icon="code-lines"
              defer
              trigger={{
                title: i18n.t("ui.tool.patch"),
                subtitle: subtitle(),
              }}
            >
              <Show when={files().length > 0}>
                <Accordion
                  multiple
                  data-scope="apply-patch"
                  style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
                  value={expanded()}
                  onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={files()}>
                    {(file) => {
                      const active = createMemo(() => expanded().includes(file.filePath))
                      const [visible, setVisible] = createSignal(false)

                      createEffect(() => {
                        if (!active()) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      })

                      return (
                        <Accordion.Item value={file.filePath} data-type={file.type}>
                          <StickyAccordionHeader>
                            <Accordion.Trigger>
                              <div data-slot="apply-patch-trigger-content">
                                <div data-slot="apply-patch-file-info">
                                  <FileIcon node={{ path: file.relativePath, type: "file" }} />
                                  <div data-slot="apply-patch-file-name-container">
                                    <Show when={file.relativePath.includes("/")}>
                                      <span data-slot="apply-patch-directory">{`\u202A${getDirectory(file.relativePath)}\u202C`}</span>
                                    </Show>
                                    <span data-slot="apply-patch-filename">{getFilename(file.relativePath)}</span>
                                  </div>
                                </div>
                                <div data-slot="apply-patch-trigger-actions">
                                  <Switch>
                                    <Match when={file.type === "add"}>
                                      <span data-slot="apply-patch-change" data-type="added">
                                        {i18n.t("ui.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("ui.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("ui.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                  <Icon name="chevron-grabber-vertical" size="small" />
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </StickyAccordionHeader>
                          <Accordion.Content>
                            <Show when={visible()}>
                              <div data-component="apply-patch-file-diff">
                                <Dynamic component={fileComponent} mode="diff" fileDiff={file.view.fileDiff} />
                              </div>
                            </Show>
                          </Accordion.Content>
                        </Accordion.Item>
                      )
                    }}
                  </For>
                </Accordion>
              </Show>
            </BasicTool>
          </div>
        }
      >
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="code-lines"
            defer
            trigger={
              <div data-component="edit-trigger">
                <div data-slot="message-part-title-area">
                  <div data-slot="message-part-title">
                    <span data-slot="message-part-title-text">
                      <TextShimmer text={i18n.t("ui.tool.patch")} active={pending()} />
                    </span>
                    <Show when={!pending()}>
                      <span data-slot="message-part-title-filename">{getFilename(single()!.relativePath)}</span>
                    </Show>
                  </div>
                  <Show when={!pending() && single()!.relativePath.includes("/")}>
                    <div data-slot="message-part-path">
                      <span data-slot="message-part-directory">{getDirectory(single()!.relativePath)}</span>
                    </div>
                  </Show>
                </div>
                <div data-slot="message-part-actions">
                  <Show when={!pending()}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Show>
                </div>
              </div>
            }
          >
            <ToolFileAccordion
              path={single()!.relativePath}
              actions={
                <Switch>
                  <Match when={single()!.type === "add"}>
                    <span data-slot="apply-patch-change" data-type="added">
                      {i18n.t("ui.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("ui.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("ui.patch.action.moved")}
                    </span>
                  </Match>
                  <Match when={true}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Match>
                </Switch>
              }
            >
              <div data-component="apply-patch-file-diff">
                <Dynamic component={fileComponent} mode="diff" fileDiff={single()!.view.fileDiff} />
              </div>
            </ToolFileAccordion>
          </BasicTool>
        </div>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <span
                    data-slot="message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionInfo[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionAnswer[])
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const title = createMemo(() => props.input.name || i18n.t("ui.tool.skill"))
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
        </div>
      </div>
    )

    return <BasicTool icon="brain" status={props.status} trigger={trigger()} hideDetails />
  },
})
