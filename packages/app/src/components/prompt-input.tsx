import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useNavigate } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import type { AddonAvailable } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  Show,
  For,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  untrack,
  lazy,
  Suspense,
} from "solid-js"
import { sessionRouteActive } from "@/context/session-active"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  FileReferencePart,
  isPromptEqual,
  LinkPart,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  PluginAttachmentPart,
  FileAttachmentPart,
  SkillPart,
  ConversationAttachmentPart,
  resetPromptDraft,
} from "@/context/prompt"
import { SKILL_ICON_PATH, skillDisplayName } from "@opencode-ai/ui/skill-chip"
import { useData, useSkillFile } from "@opencode-ai/ui/context"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSync } from "@/context/sync"
import { findMessageIndexByID } from "@/context/message-order"
import { useComments } from "@/context/comments"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DockShellForm, DockTray } from "@opencode-ai/ui/dock-surface"
import { showToast } from "@opencode-ai/ui/toast"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useImagePreview } from "@opencode-ai/ui/context/image-preview"
import { SessionContextUsage } from "@/components/session-context-usage"
import { DialogPermissionFullAccess } from "@/components/dialog-permission-full-access"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { formatServerError } from "@/utils/server-errors"
import { type PermissionMode, usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform, type InstalledOpener } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { BranchPickerControl, ExecutionModeControl, useScratchMode } from "@/components/session-environment-controls"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit, type FollowupDraft } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { builtinSlashCommands, orderedSlashCommands } from "./prompt-input/slash-commands"
import { addonMentionKey } from "@/utils/plugin-migration"
import { PromptAddToChatSelectionTag } from "./prompt-input/add-to-chat-selection-tag"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptFileAttachments } from "./prompt-input/file-attachments"
import {
  canPreviewPastedAttachment,
  isValidPastedJson,
  pastedAttachmentKind,
  type PastedAttachmentKind,
} from "./prompt-input/pasted-attachment"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"

const PastedAttachmentPreview = lazy(() =>
  import("./prompt-input/pasted-attachment-preview").then((mod) => ({ default: mod.PastedAttachmentPreview })),
)
import { promptPlaceholder } from "./prompt-input/placeholder"
import { canRestorePastedText, removeExactPastedAnchorParts, restorePastedTextContent } from "./prompt-input/paste"
import { ghostSuggestion, isAcceptSuggestionKey } from "./prompt-input/suggestion"
import {
  IMAGE_GENERATION_COUNTS,
  IMAGE_GENERATION_SIZES,
  imageGenerationSizeLabel,
  imageGenerationSizeParts,
  isImageGenerationModel,
  normalizeImageGenerationSize,
} from "./prompt-input/image-generation"
import { createQueryPending } from "@/utils/query-pending"
import { loadAgentsQuery, loadProvidersQuery } from "@/context/global-sync/bootstrap"
import { recordIssueAction, recordIssueEvent, stableHash } from "@/utils/issue-report-snapshot"
import { getDefaultEditorOpener } from "@/utils/default-opener"
import { QUICK_CHAT_ATTACH_EVENT, openQuickChat, type QuickChatAttachDetail, type QuickChatReference } from "@/utils/quick-chat"
import { openNewSession } from "@/utils/new-session"
import { dispatchOpenLocalFile } from "@/utils/open-local-file"
import {
  findPromptLinkMatches,
  normalizePromptHref,
  serializePromptLink,
  stripFileLocationSuffix,
} from "@/utils/prompt-links"
import { PromptLinkPopover, type PromptLinkPopoverDraft } from "./prompt-input/link-popover"

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  onNewSessionWorktreeCreate?: () => void
  edit?: {
    id: string
    prompt: Prompt
    context: FollowupDraft["context"]
    addToChatSnippets?: string[]
  }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  // 真实运行态下的 steer 单独判定，不能复用 working，避免把已失效的残留 busy 当成引导。
  shouldSteer?: () => boolean
  workingOverride?: () => boolean
  suppressSuggestion?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onSteer?: (draft: FollowupDraft) => Promise<void> | void
  onAbort?: () => void
  // 停止按钮需要把当前活动回合传给服务端，旧页面的迟到请求不能中断新回合。
  activeTurnID?: (sessionID: string) => string | undefined
  // abort RPC 完成后通知页面恢复停止前未 ACK 的引导。
  onAbortComplete?: (sessionID: string) => void
  onBeforeSubmitExistingSession?: (sessionID: string) => Promise<boolean> | boolean
  onSubmit?: () => void
  isGoalModeActive?: () => boolean
  onGoalSubmit?: (objective: string, sessionID: string) => void
  /** 退出 goal 输入态（不清除已存在的目标）：在 goal armed 时跑斜杠命令后调用 */
  onExitGoalMode?: () => void
  /** 「+」菜单里的「追求目标」开关 + footer「目标」chip（仅在 goal 实验开启时提供）；切换进入/退出 goal 模式 */
  onGoalModeToggle?: () => void
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

const CONVERSATION_ICON_PATH =
  "M17.5 9.75C17.5 5.875 14.667 3.55 10.21 3.55C5.754 3.55 2.92 5.875 2.92 9.75C2.92 10.756 3.61 12.464 3.716 12.72C3.79 12.921 4.096 14.003 2.92 15.606C4.54 16.381 6.26 15.108 6.26 15.108C7.45 15.74 8.867 15.883 10.21 15.883C14.667 15.883 17.5 13.558 17.5 9.75Z"

const NON_EMPTY_TEXT = /[^\s\u200B]/

const ImageGenerationSizeDialog: Component<{
  value: string
  onSelect: (value: string) => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const initial = imageGenerationSizeParts(props.value) ?? { width: 1024, height: 1024 }
  const [width, setWidth] = createSignal(String(initial.width))
  const [height, setHeight] = createSignal(String(initial.height))
  const apply = (value: string) => {
    props.onSelect(value)
    dialog.close()
  }

  return (
    <Dialog
      fit
      title={language.t("prompt.imageGeneration.size.title")}
      description={language.t("prompt.imageGeneration.size.description")}
      class="codex-dialog w-[min(760px,calc(100vw-48px))]"
    >
      <div class="grid gap-5 px-5 pb-5">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <For each={IMAGE_GENERATION_SIZES}>
            {(item) => {
              const active = () => props.value === item.value
              return (
                <button
                  type="button"
                  class="min-h-[88px] rounded-xl border px-4 py-3 text-left transition-colors"
                  classList={{
                    "border-[rgb(124,98,238)] bg-[rgba(124,98,238,0.08)] text-[rgb(91,70,194)] dark:text-[rgb(177,161,255)]":
                      active(),
                    "border-border-weaker-base bg-background-base hover:bg-surface-base-hover": !active(),
                  }}
                  onClick={() => apply(item.value)}
                >
                  <div class="text-18-bold">{language.t(item.labelKey as Parameters<typeof language.t>[0])}</div>
                  <div class="mt-2 text-14-regular text-text-muted">{item.hint}</div>
                </button>
              )
            }}
          </For>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label class="grid gap-2 text-13-bold text-text-base">
            {language.t("prompt.imageGeneration.size.width")}
            <input
              value={width()}
              inputmode="numeric"
              class="h-11 rounded-lg border border-border-weaker-base bg-background-base px-3 text-15-bold outline-none focus:border-[rgb(124,98,238)]"
              onInput={(event) => setWidth(event.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
            />
          </label>
          <label class="grid gap-2 text-13-bold text-text-base">
            {language.t("prompt.imageGeneration.size.height")}
            <input
              value={height()}
              inputmode="numeric"
              class="h-11 rounded-lg border border-border-weaker-base bg-background-base px-3 text-15-bold outline-none focus:border-[rgb(124,98,238)]"
              onInput={(event) => setHeight(event.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
            />
          </label>
          <Button
            type="button"
            size="large"
            onClick={() => apply(normalizeImageGenerationSize(`${width()}x${height()}`))}
          >
            {language.t("prompt.imageGeneration.size.apply")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const queryClient = useQueryClient()

  // plugin pill 渲染时 inline 注入 logo / 品牌色,从 plugins 页 prefetch 的 query cache 拿,
  // miss 时降级到 `@<name>` 文本(不影响 wire text 序列化)。
  const lookupPluginMeta = (addonKey: string) => {
    // key 必须含 locale，与 availableAddons query 一致；否则精确匹配 miss → chip 拿不到 logo/品牌色。
    const list = queryClient.getQueryData<AddonAvailable[]>(["addon", "available", "global", language.locale()])
    return list?.find((p) => p.key === addonKey)
  }

  const sync = useSync()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const imagePreview = useImagePreview()
  const data = useData()
  const openSkillFile = useSkillFile() ?? data.openSkillFile
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const navigate = useNavigate()
  // 与顶部「在编辑器中打开」共用主进程扫描能力；读取用户在顶部下拉里选择过的默认编辑器。
  const [fileAttachmentOpeners] = createResource<InstalledOpener[], boolean>(
    () => platform.platform === "desktop" && typeof platform.listInstalledOpeners === "function",
    async (enabled) => {
      if (!enabled) return []
      return (await platform.listInstalledOpeners?.()) ?? []
    },
  )
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement
  const [linkDraft, setLinkDraft] = createSignal<PromptLinkPopoverDraft>()

  const mirror = { input: false }
  const inset = 12
  const space = `${inset}px`

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const openFileAttachment = (attachment: FileAttachmentPart) => {
    const editor = getDefaultEditorOpener(fileAttachmentOpeners() ?? [])
    if (editor) {
      void (platform.invokeOpener
        ? platform.invokeOpener(editor, attachment.path)
        : platform.openPath?.(attachment.path, editor.app))
      return
    }
    void platform.openPath?.(attachment.path)
  }

  type PastedPreviewState = {
    path: string
    kind: PastedAttachmentKind
    filename: string
    saved: string
    draft: string
    saving: boolean
  }

  const [pastedPreview, setPastedPreview] = createSignal<PastedPreviewState | null>(null)

  const closePastedPreview = () => setPastedPreview(null)

  const writePastedPreviewFile = async (path: string, draft: string) => {
    const writeFile = platform.writeFile
    if (!writeFile) throw new Error("writeFile unavailable")
    try {
      await writeFile(path, draft, { overwrite: true })
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Older desktop builds reject overwrite; fall back to temp create + replace.
      if (!message.includes("File already exists") || !platform.trashFile || !platform.renameFile) throw err
      const tmp = `${path}.__wl_editing_${Date.now()}`
      await writeFile(tmp, draft)
      try {
        await platform.trashFile(path)
        await platform.renameFile(tmp, path)
      } catch (moveErr) {
        void platform.trashFile(tmp).catch(() => undefined)
        throw moveErr
      }
    }
  }

  const savePastedPreview = async () => {
    const current = pastedPreview()
    if (!current) return true
    if (current.draft === current.saved) return true
    if (current.kind === "json" && !isValidPastedJson(current.draft)) {
      showToast({
        variant: "error",
        title: language.t("prompt.attachment.preview.invalidJson"),
      })
      return false
    }
    if (!platform.writeFile) {
      showToast({
        variant: "error",
        title: language.t("prompt.attachment.preview.saveFailed"),
      })
      return false
    }
    const draft = current.draft
    const path = current.path
    setPastedPreview((prev) => (prev ? { ...prev, saving: true } : prev))
    try {
      await writePastedPreviewFile(path, draft)
      const nextParts = prompt.current().map((part) => {
        if (part.type !== "file" || part.path !== path || !part.pastedText) return part
        return { ...part, pastedText: { characterCount: draft.length } }
      })
      prompt.set(nextParts, prompt.cursor())
      setPastedPreview((prev) => {
        if (!prev || prev.path !== path) return prev
        return { ...prev, saved: draft, draft: prev.draft === draft ? draft : prev.draft, saving: false }
      })
      return true
    } catch (err) {
      setPastedPreview((prev) => (prev ? { ...prev, saving: false } : prev))
      showToast({
        variant: "error",
        title: language.t("prompt.attachment.preview.saveFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  const openPastedPreview = (input: {
    path: string
    kind: PastedAttachmentKind
    filename: string
    content: string
  }) => {
    setPastedPreview({
      path: input.path,
      kind: input.kind,
      filename: input.filename,
      saved: input.content,
      draft: input.content,
      saving: false,
    })
  }

  const handleFileAttachmentOpen = async (attachment: FileAttachmentPart) => {
    const kind = pastedAttachmentKind(attachment.path)
    if (!kind) {
      const current = pastedPreview()
      if (current && current.draft !== current.saved) {
        if (!(await savePastedPreview())) return
      }
      closePastedPreview()
      openFileAttachment(attachment)
      return
    }

    const current = pastedPreview()
    if (current?.path === attachment.path) {
      const el = document.querySelector<HTMLTextAreaElement>(
        '[data-component="pasted-attachment-preview"] textarea',
      )
      el?.focus()
      return
    }

    if (current && current.draft !== current.saved) {
      if (!(await savePastedPreview())) return
    }

    const data = await sdk.client.file.read({ path: attachment.path }).then((x) => x.data).catch(() => undefined)
    if (!data || data.type === "binary" || typeof data.content !== "string") {
      showToast({
        variant: "error",
        title: language.t("prompt.attachment.preview.loadFailed"),
      })
      openFileAttachment(attachment)
      return
    }
    if (!canPreviewPastedAttachment(data.content.length)) {
      openFileAttachment(attachment)
      return
    }

    openPastedPreview({
      path: attachment.path,
      kind,
      filename: attachment.content.replace(/^@/, "") || getFilename(attachment.path),
      content: data.content,
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  // 与命令面板/渲染侧对齐：在 revert 状态下也只取「最后一条可见用户消息」，
  // 否则记录到被 revert 的隐藏消息上会让提示永远匹配不到、整体丢失。
  const lastUserMessageID = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    const messages = sync.data.message[id]
    if (!messages) return undefined
    const revert = info()?.revert?.messageID
    // 输入框锚点只查看 revert 边界前的时间线，兼容不具备时间序的旧远控 ID。
    const index = revert ? findMessageIndexByID(messages, revert) : messages.length
    // 锚点尚未随历史分页加载时，当前消息都是撤销后的隐藏后缀，不能拿来承载输入框状态。
    const visibleEnd = index < 0 ? 0 : index
    return messages.slice(0, visibleEnd).findLast((item) => item.role === "user")?.id
  })
  const status = createMemo(
    () =>
      sync.data.session_status[params.id ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => props.workingOverride?.() ?? status()?.type !== "idle")
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const fileAttachments = createMemo(() =>
    prompt.current().filter((part): part is FileAttachmentPart => part.type === "file"),
  )
  const imagePreviewIssueData = (attachment: ImageAttachmentPart) => ({
    filename_hash: stableHash(attachment.filename),
    mime: attachment.mime,
    data_url_bytes: attachment.dataUrl.length,
    data_url_prefix_hash: stableHash(attachment.dataUrl.slice(0, 2048)),
    device_pixel_ratio: window.devicePixelRatio,
    zoom: window.visualViewport?.scale,
  })
  const openImageAttachmentPreview = (attachment: ImageAttachmentPart) => {
    recordIssueAction("prompt.imagePreview.open", imagePreviewIssueData(attachment))
    const images = imageAttachments().map((item) => ({
      src: item.dataUrl,
      alt: item.filename,
    }))
    imagePreview.show({
      src: attachment.dataUrl,
      alt: attachment.filename,
      images,
      initialIndex: Math.max(
        0,
        imageAttachments().findIndex((item) => item.id === attachment.id),
      ),
      onLoad: (event) => {
        const img = event.currentTarget as HTMLImageElement
        recordIssueAction("prompt.imagePreview.load", {
          ...imagePreviewIssueData(attachment),
          natural_width: img.naturalWidth,
          natural_height: img.naturalHeight,
          rendered_width: img.clientWidth,
          rendered_height: img.clientHeight,
        })
      },
      onError: () => {
        recordIssueEvent({
          type: "error",
          name: "prompt.imagePreview.error",
          message: "image preview failed",
          stack: new Error("prompt.imagePreview.error").stack,
          data: imagePreviewIssueData(attachment),
        })
      },
    })
  }

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
    imageCount: number
    imageSize: string
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
    imageCount: 1,
    imageSize: "auto",
  })

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))
  const imageGenerationModel = createMemo(() => {
    const model = local.model.current()
    if (!model || store.mode === "shell") return false
    return isImageGenerationModel({
      id: model.id,
      name: model.name,
      capabilities: model.capabilities,
    })
  })
  const imageSizeLabel = createMemo(() => {
    const label = imageGenerationSizeLabel(store.imageSize)
    if (label.startsWith("prompt.")) return language.t(label as Parameters<typeof language.t>[0])
    return label
  })

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const snippetCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.addToChat.count()
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0 && snippetCount() === 0
  })
  const stopping = createMemo(() => {
    if (!working()) return false
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0
  })
  // 复刻 Codex 两段式 ESC：第一次 ESC 把停止按钮切到「Esc」确认态，再按一次才真正中断；3s 无操作或轮结束自动复位
  const [escArmed, setEscArmed] = createSignal(false)
  let escArmTimer: number | undefined
  const armEsc = () => {
    setEscArmed(true)
    window.clearTimeout(escArmTimer)
    escArmTimer = window.setTimeout(() => setEscArmed(false), 3000)
  }
  const disarmEsc = () => {
    window.clearTimeout(escArmTimer)
    setEscArmed(false)
  }
  createEffect(() => {
    if (!working()) disarmEsc()
  })
  onCleanup(() => window.clearTimeout(escArmTimer))
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return false
    const messages = sync.data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? (store.mode === "shell" ? "git status" : language.t(EXAMPLES[store.placeholder])) : "",
      suggest: suggest(),
      imageGeneration: imageGenerationModel(),
      goalMode: props.isGoalModeActive?.(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const [dismissedSuggestion, setDismissedSuggestion] = createSignal<string | undefined>(undefined)
  const sessionSuggestion = createMemo(() => (params.id ? sync.data.session_suggestion[params.id] : undefined))
  const ghost = createMemo(() =>
    ghostSuggestion({
      suggestion: sessionSuggestion(),
      dirty: prompt.dirty(),
      dismissed: dismissedSuggestion() === sessionSuggestion(),
      working: working(),
      mode: store.mode,
      imageGeneration: imageGenerationModel(),
      popover: store.popover !== null,
      enabled: sync.data.config.prompt_suggestions !== false,
      suppressed: props.suppressSuggestion?.() === true,
    }),
  )

  createEffect(
    on(
      () => params.id,
      () => {
        setDismissedSuggestion(undefined)
      },
      { defer: true },
    ),
  )

  // 新建议到达：重置上一条的 dismissed（相同文本也重新展示）；用户正在编辑时到达则直接视为已忽略
  createEffect(
    on(
      sessionSuggestion,
      (current) => {
        if (!current) return
        setDismissedSuggestion(prompt.dirty() ? current : undefined)
      },
      { defer: true },
    ),
  )

  // 用户实际输入（打字/粘贴/IME）后，本条建议本轮不再出现（含清空输入后）；
  // 历史导航、消息编辑等程序化填充不触发 input 事件，因而不会误杀建议
  const dismissSuggestionOnInput = () => {
    const current = sessionSuggestion()
    if (current) setDismissedSuggestion(current)
  }

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = async () => {
    // 桌面端和 Web 端都使用 input[type=file]，在 onChange 中统一处理
    // 桌面端通过 getPathForFile 获取绝对路径，Web 端只有文件名
    fileInputRef?.click()
  }

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => {
    if (!sessionRouteActive()) return []
    return [
      {
        id: "file.attach",
        title: language.t("prompt.action.attachFile"),
        category: language.t("command.category.file"),
        keybind: "mod+u",
        disabled: store.mode !== "normal",
        onSelect: pick,
      },
      {
        id: "prompt.mode.shell",
        title: language.t("command.prompt.mode.shell"),
        category: language.t("command.category.session"),
        keybind: shellModeKey,
        disabled: store.mode === "shell",
        onSelect: () => setMode("shell"),
      },
      {
        id: "prompt.mode.normal",
        title: language.t("command.prompt.mode.normal"),
        category: language.t("command.category.session"),
        keybind: normalModeKey,
        disabled: store.mode === "normal",
        onSelect: () => setMode("normal"),
      },
      {
        id: "prompt.plan",
        title: language.t("prompt.plan.label"),
        category: language.t("command.category.session"),
        slash: "plan",
        slashAliases: ["计划", "計劃"],
        disabled: store.mode !== "normal",
        onSelect: () => togglePlanMode(),
      },
    ]
  })

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editorRef.focus()
      setCursorPosition(editorRef, cursor)
      queueScroll()
    })
  }

  // 进入 goal 输入态时把焦点移到编辑器，否则焦点会留在「+」触发器上导致打字不进输入框（覆盖 +菜单/斜杠等所有入口）
  createEffect(
    on(
      () => props.isGoalModeActive?.() ?? false,
      (active, prev) => {
        if (active && !prev) restoreFocus()
      },
      { defer: true },
    ),
  )

  const renderEditorWithCursor = (parts: Prompt) => {
    // currentCursor() 读取 DOM selection,editor 未获焦时返回 null;
    // 回退到 prompt.cursor()(由 prompt.set 写入),用 untrack 避免把光标变化纳入响应式追踪链路。
    const cursor = currentCursor() ?? untrack(() => prompt.cursor())
    renderEditor(parts)
    if (cursor !== null && cursor !== undefined) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    params.id
    if (params.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image" && part.type !== "file"))
    })
  }

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )
  const agentNames = createMemo(() => local.agent.list().map((agent) => agent.name))

  // 主动拉一次已安装插件 —— composer 首次 mount 就 fetch,即便用户没访问过 plugins 页,
  // `@` 弹层也能拿到完整候选;与 plugins 页 / detail 页共享同一份 query cache,无重复请求。
  // description 字段用于弹层右侧灰色说明文字。
  const availableAddons = createQuery(() => ({
    queryKey: ["addon", "available", "global", language.locale()],
    queryFn: async () => (await globalSDK.client.addon.available({ locale: language.locale() })).data ?? [],
  }))
  const pluginList = createMemo<AtOption[]>(() => {
    const list = availableAddons.data ?? []
    return list
      .filter((p) => p.installed && !p.disabled)
      .map((p) => ({
        type: "plugin" as const,
        addonKey: addonMentionKey(p),
        name: p.name,
        display: p.display_name?.trim() || p.name,
        description: p.description?.trim() || undefined,
        // 弹层 / chip 优先用 composer_icon(单色小图,如 cloudflare-small.svg),
        // 缺省再 fallback 到 logo(品牌全彩 PNG,主要给卡片/详情页 hero 用)。
        logo: p.composer_icon || p.logo,
        brandColor: p.brand_color,
      }))
  })

  // 「+」菜单 → 插件子菜单用的已安装列表。与 pluginList 同源(availableAddons),
  // icon 取法与插入输入框的 chip 一致(composer_icon 单色小图优先,缺省再 fallback logo),
  // 保证子菜单里看到的图标 == 选中后落到聊天框 chip 上的图标。
  const installedPlugins = createMemo(() =>
    (availableAddons.data ?? [])
      .filter((p) => p.installed && !p.disabled)
      .map((p) => ({
        addonKey: addonMentionKey(p),
        name: p.name,
        display: p.display_name?.trim() || p.name,
        logo: p.composer_icon || p.logo,
        brandColor: p.brand_color,
      })),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else if (option.type === "plugin") {
      // chip 显示文本用 display_name(无 @ 前缀,与 @ 弹层和卡片一致),
      // wire text 由 submit.ts draftText 用 part.name + part.addonKey 还原成完整 markdown link。
      const display = option.display.trim() || option.name
      addPart({
        type: "plugin",
        name: option.name,
        addonKey: option.addonKey,
        content: display,
        start: 0,
        end: 0,
      })
    } else {
      // file: 作为附件添加，不插入编辑器文本
      addReference(option.path)
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    if (x.type === "agent") return `agent:${x.name}`
    if (x.type === "plugin") return `plugin:${x.addonKey}`
    return `file:${x.path}`
  }

  const {
    flat: atFlat,
    grouped: atGrouped,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const plugins = pluginList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents, ...plugins, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...plugins, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.type === "plugin") return "plugin"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "plugin") return 1
        if (category === "recent") return 2
        return 3
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = builtinSlashCommands(command.options)

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
      location: cmd.location,
    }))

    return orderedSlashCommands({ builtin, custom })
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      if (cmd.source === "skill") {
        const part: SkillPart = {
          type: "skill",
          name: cmd.trigger,
          location: cmd.location,
          content: text,
          start: 0,
          end: text.length,
        }
        prompt.set([part, ...images], text.length)
        requestAnimationFrame(() => {
          renderEditor([part])
          editorRef.focus()
          setCursorPosition(editorRef, text.length)
          queueScroll()
        })
        return
      }

      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.commandID ?? cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const promptFilePath = (href: string) => {
    const withoutLocation = stripFileLocationSuffix(href.trim())
    if (/^file:\/\//i.test(withoutLocation)) {
      try {
        const pathname = decodeURIComponent(new URL(withoutLocation).pathname)
        if (/^\/[A-Za-z]:[\\/]/.test(pathname)) return pathname.slice(1)
        return pathname
      } catch {
        return withoutLocation.replace(/^file:\/\//i, "")
      }
    }
    if (/^(?:\/[A-Za-z]:[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/.test(withoutLocation)) return withoutLocation
    const relative = withoutLocation.replace(/^(?:\.\/[\\/])/, "")
    return `${sdk.directory.replace(/[\\/]$/, "")}/${relative}`
  }

  const openPromptFile = async (href: string) => {
    const path = promptFilePath(href)
    const resolved = await data.resolveMarkdownPath?.(stripFileLocationSuffix(href))
    const absolutePath = resolved?.absolutePath ?? path
    // 普通文件（含工作区外的已授权 Skill 文件）统一进入应用内工作台，只有目录才交给系统文件管理器。
    if (resolved?.kind !== "directory") {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
      layout.fileTree.open()
      layout.fileTree.setTab("all")
      const tab = files.tab(absolutePath)
      void tabs().open(tab, { preview: false })
      tabs().setActive(tab)
      void files.load(absolutePath)
      return
    }
    if (data.openLocalPath) {
      await data.openLocalPath(absolutePath, resolved?.kind ?? "file")
      return
    }
    if (platform.openPath) {
      await platform.openPath(absolutePath)
      return
    }
    dispatchOpenLocalFile(absolutePath)
  }

  const closePromptLinkPopover = () => {
    const current = linkDraft()
    current?.element.setAttribute("aria-expanded", "false")
    setLinkDraft()
  }

  const openPromptLinkPopover = (element: HTMLElement) => {
    const href = element.dataset.href
    const displayText = element.dataset.content ?? element.textContent ?? ""
    if (!href || !displayText) return
    closePromptLinkPopover()
    element.setAttribute("aria-expanded", "true")
    // 记录裸 URL 身份，地址编辑完成后才能同步可见文字并保留纯文本提交格式。
    setLinkDraft({
      element,
      displayText,
      href,
      plain: element.dataset.plain === "true",
      mode: "actions",
      value: "",
      showHrefError: false,
    })
  }

  const setCursorAfterElement = (element: Node) => {
    const range = document.createRange()
    const selection = window.getSelection()
    range.setStartAfter(element)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const savePromptLink = (displayText: string, href: string | null, plain: boolean) => {
    const draft = linkDraft()
    if (!draft) return
    const replacement = href
      ? createInlineReference(
          displayText,
          href,
          findPromptLinkMatches(serializePromptLink(displayText, href))[0]?.kind ?? "link",
          plain,
        )
      : document.createTextNode(displayText)
    draft.element.replaceWith(replacement)
    setCursorAfterElement(replacement)
    closePromptLinkPopover()
    handleInput()
  }

  const createSvgIcon = (pathData: string, className: string) => {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    icon.setAttribute("viewBox", "0 0 20 20")
    icon.setAttribute("aria-hidden", "true")
    icon.setAttribute("class", className)
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", pathData)
    path.setAttribute("fill", "currentColor")
    icon.appendChild(path)
    return icon
  }

  const createInlineReference = (displayText: string, href: string, kind: "link" | "file", plain = false) => {
    const reference = document.createElement("span")
    reference.dataset.type = kind === "file" ? "file-reference" : "link"
    reference.dataset.content = displayText
    reference.dataset.href = href
    if (plain) reference.dataset.plain = "true"
    reference.setAttribute("contenteditable", "false")
    reference.setAttribute("role", "button")
    reference.setAttribute("tabindex", "0")
    reference.setAttribute("aria-expanded", "false")
    reference.setAttribute("title", href)
    reference.className = kind === "file" ? "prompt-input-file-reference" : "prompt-input-link-reference"
    reference.style.cursor = "pointer"

    const isGitHub = kind === "link" && /^https?:\/\/(?:www\.)?github\.com\//i.test(href)
    if (isGitHub) {
      reference.appendChild(
        createSvgIcon(
          "M10 1.625a8.333 8.333 0 0 0-2.635 16.238c.417.078.57-.181.57-.402 0-.198-.007-.724-.01-1.421-2.32.504-2.81-1.12-2.81-1.12-.38-.965-.927-1.222-.927-1.222-.758-.519.058-.508.058-.508.838.059 1.278.86 1.278.86.745 1.276 1.955.908 2.43.694.076-.54.292-.909.53-1.118-1.853-.21-3.8-.927-3.8-4.126 0-.912.326-1.657.86-2.241-.086-.211-.373-1.06.082-2.21 0 0 .7-.224 2.292.856a7.94 7.94 0 0 1 4.172 0c1.59-1.08 2.29-.856 2.29-.856.456 1.15.17 1.999.083 2.21.535.584.858 1.329.858 2.241 0 3.208-1.95 3.912-3.807 4.119.3.259.567.77.567 1.553 0 1.121-.01 2.026-.01 2.301 0 .224.15.484.574.401A8.333 8.333 0 0 0 10 1.625",
          "prompt-input-link-icon",
        ),
      )
    }
    if (kind === "file") {
      reference.appendChild(
        createSvgIcon("M4.167 2.5h7.5L15.833 6.667v10.833H4.167V2.5Zm7.5 0v4.167h4.166", "prompt-input-file-icon"),
      )
    }
    const label = document.createElement("span")
    label.dataset.slot = "prompt-reference-label"
    label.textContent = displayText
    reference.appendChild(label)

    const activate = (event: MouseEvent | KeyboardEvent) => {
      event.stopPropagation()
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
      }
      if (kind === "file") {
        void openPromptFile(href)
        return
      }
      openPromptLinkPopover(reference)
    }
    reference.addEventListener("click", activate)
    reference.addEventListener("keydown", activate)
    return reference
  }

  const createPill = (
    part:
      | FileAttachmentPart
      | FileReferencePart
      | LinkPart
      | AgentPart
      | PluginAttachmentPart
      | SkillPart
      | ConversationAttachmentPart,
  ) => {
    if (part.type === "link" || part.type === "file-reference") {
      return createInlineReference(
        part.content,
        part.href,
        part.type === "link" ? "link" : "file",
        part.type === "link" && part.plain,
      )
    }
    const pill = document.createElement("span")
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") {
      pill.setAttribute("data-path", part.path)
      pill.setAttribute("title", part.path)
      pill.textContent = "@" + getFilename(part.path)
    } else if (part.type === "agent") {
      pill.setAttribute("data-name", part.name)
      pill.textContent = part.content
    } else if (part.type === "plugin") {
      pill.setAttribute("data-name", part.name)
      pill.setAttribute("data-addon-key", part.addonKey)
      // plugin pill 视觉: [logo? img] @display_name(品牌色)
      // 注意整体 textContent 仍是 part.content (`@<name>`),保证 parseFromDOM 取出来的
      // start/end 长度与 prompt model 一致,光标 / 删除位移都不会错位。
      const meta = lookupPluginMeta(part.addonKey)
      if (meta?.brand_color) pill.style.color = meta.brand_color
      // composer_icon(单色小图)优先,缺省再 fallback 到 logo
      const iconSrc = meta?.composer_icon || meta?.logo
      if (iconSrc) {
        const img = document.createElement("img")
        img.src = iconSrc
        img.alt = ""
        img.setAttribute("data-slot", "plugin-chip-logo")
        pill.appendChild(img)
      }
      const label = document.createElement("span")
      label.setAttribute("data-slot", "plugin-chip-label")
      label.textContent = part.content
      pill.appendChild(label)
      // 与 skill pill 一致:注入 openPluginDetail 时 pill 可点击跳转插件详情页。
      const open = data.openPluginDetail
      if (open) {
        const displayName = meta?.display_name?.trim() || part.name
        pill.setAttribute("role", "button")
        pill.setAttribute("tabindex", "0")
        pill.setAttribute("aria-label", `打开插件 ${displayName}`)
        pill.style.cursor = "pointer"
        const handler = (event: KeyboardEvent | MouseEvent) => {
          event.stopPropagation()
          if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return
          if (event instanceof KeyboardEvent) event.preventDefault()
          void open(part.addonKey)
        }
        pill.addEventListener("click", handler)
        pill.addEventListener("keydown", handler)
      }
    } else if (part.type === "skill") {
      pill.setAttribute("data-component", "skill-chip")
      pill.setAttribute("data-name", part.name)
      pill.setAttribute("data-content", part.content)
      pill.setAttribute("skill-mention-name", part.name)
      pill.setAttribute("skill-mention-display-name", skillDisplayName(part.name))
      pill.setAttribute("skill-mention-path", part.location ?? "")
      if (part.location) {
        pill.setAttribute("data-location", part.location)
        pill.setAttribute("title", part.location)
      }
      pill.style.cursor = part.location && openSkillFile ? "pointer" : "default"
      pill.addEventListener("click", (event) => {
        event.stopPropagation()
        if (!part.location) return
        void openSkillFile?.({
          path: part.location,
          name: part.name,
          displayName: skillDisplayName(part.name),
        })
      })

      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      icon.setAttribute("data-slot", "skill-chip-icon")
      icon.setAttribute("width", "20")
      icon.setAttribute("height", "20")
      icon.setAttribute("viewBox", "0 0 20 20")
      icon.setAttribute("fill", "none")
      icon.setAttribute("aria-hidden", "true")
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", SKILL_ICON_PATH)
      path.setAttribute("fill", "currentColor")
      icon.appendChild(path)
      pill.appendChild(icon)

      const label = document.createElement("span")
      label.setAttribute("data-slot", "skill-chip-label")
      label.textContent = skillDisplayName(part.name)
      pill.appendChild(label)
    } else if (part.type === "conversation") {
      pill.setAttribute("data-component", "conversation-chip")
      pill.setAttribute("data-conversation-id", part.id)
      pill.setAttribute("data-title", part.title)
      pill.setAttribute("data-transcript", part.transcript)
      pill.setAttribute("aria-label", part.title)
      if (platform.platform === "desktop") {
        pill.setAttribute("role", "button")
        pill.setAttribute("tabindex", "0")
        pill.style.cursor = "pointer"
      }

      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      icon.setAttribute("data-slot", "conversation-chip-icon")
      icon.setAttribute("width", "16")
      icon.setAttribute("height", "16")
      icon.setAttribute("viewBox", "0 0 20 20")
      icon.setAttribute("fill", "none")
      icon.setAttribute("aria-hidden", "true")
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", CONVERSATION_ICON_PATH)
      path.setAttribute("stroke", "currentColor")
      path.setAttribute("stroke-linecap", "round")
      icon.appendChild(path)
      pill.appendChild(icon)

      const label = document.createElement("span")
      label.setAttribute("data-slot", "conversation-chip-label")
      label.textContent = part.content
      pill.appendChild(label)

      const handler = (event: KeyboardEvent | MouseEvent) => {
        event.stopPropagation()
        if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return
        if (event instanceof KeyboardEvent) event.preventDefault()
        openQuickChat(part.id)
      }
      if (platform.platform === "desktop") {
        pill.addEventListener("click", handler)
        pill.addEventListener("keydown", handler)
      }
    }
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        // 纯文本中的 Markdown 链接需要先规范化成可交互节点，避免只显示颜色却无法点击。
        if (findPromptLinkMatches(text).length > 0) return false
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "file-reference") return true
      if (el.dataset.type === "link") return true
      if (el.dataset.type === "agent") return true
      if (el.dataset.type === "plugin") return true
      if (el.dataset.type === "skill") return true
      if (el.dataset.type === "conversation") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        let cursor = 0
        for (const link of findPromptLinkMatches(part.content)) {
          const before = part.content.slice(cursor, link.start)
          if (before) editorRef.appendChild(createTextFragment(before))
          editorRef.appendChild(createInlineReference(link.displayText, link.href, link.kind, link.plain))
          cursor = link.end
        }
        const after = part.content.slice(cursor)
        if (after) editorRef.appendChild(createTextFragment(after))
        continue
      }
      // file parts are rendered as attachments outside the editor
      if (
        part.type === "link" ||
        part.type === "file-reference" ||
        part.type === "agent" ||
        part.type === "plugin" ||
        part.type === "skill" ||
        part.type === "conversation"
      ) {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM()
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        // file parts are attachments, not rendered in editor
        reconcile(parts.filter((part) => part.type !== "image" && part.type !== "file"))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const pushText = (content: string) => {
      let cursor = 0
      for (const link of findPromptLinkMatches(content)) {
        const before = content.slice(cursor, link.start)
        if (before) {
          parts.push({ type: "text", content: before, start: position, end: position + before.length })
          position += before.length
        }
        if (link.kind === "file") {
          parts.push({
            type: "file-reference",
            path: link.href,
            href: link.href,
            content: link.displayText,
            start: position,
            end: position + link.displayText.length,
          })
        } else {
          parts.push({
            type: "link",
            href: link.href,
            // DOM 纯文本扫描出的裸 URL 必须保留身份，后续编辑地址时才会同步可见文字。
            ...(link.plain ? { plain: true } : {}),
            content: link.displayText,
            start: position,
            end: position + link.displayText.length,
          })
        }
        position += link.displayText.length
        cursor = link.end
      }
      const after = content.slice(cursor)
      if (!after) return
      parts.push({ type: "text", content: after, start: position, end: position + after.length })
      position += after.length
    }

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (content) pushText(content)
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushPlugin = (plugin: HTMLElement) => {
      const content = plugin.textContent ?? ""
      parts.push({
        type: "plugin",
        name: plugin.dataset.name!,
        addonKey: plugin.dataset.addonKey!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushSkill = (skill: HTMLElement) => {
      const content = skill.dataset.content || `/${skill.dataset.name ?? ""} `
      parts.push({
        type: "skill",
        name: skill.dataset.name!,
        location: skill.dataset.location || skill.getAttribute("skill-mention-path") || undefined,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushConversation = (conversation: HTMLElement) => {
      const title = conversation.dataset.title || conversation.textContent || "Conversation"
      const content = conversation.textContent || title
      parts.push({
        type: "conversation",
        id: conversation.dataset.conversationId!,
        title,
        transcript: conversation.dataset.transcript ?? "",
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.dataset.type === "link") {
        flushText()
        const content = el.dataset.content ?? el.textContent ?? ""
        parts.push({
          type: "link",
          href: el.dataset.href ?? "",
          ...(el.dataset.plain === "true" ? { plain: true } : {}),
          content,
          start: position,
          end: position + content.length,
        })
        position += content.length
        return
      }
      if (el.dataset.type === "file-reference") {
        flushText()
        const content = el.dataset.content ?? el.textContent ?? ""
        parts.push({
          type: "file-reference",
          path: el.dataset.href ?? "",
          href: el.dataset.href ?? "",
          content,
          start: position,
          end: position + content.length,
        })
        position += content.length
        return
      }
      if (el.dataset.type === "plugin") {
        flushText()
        pushPlugin(el)
        return
      }
      if (el.dataset.type === "skill") {
        flushText()
        pushSkill(el)
        return
      }
      if (el.dataset.type === "conversation") {
        flushText()
        pushConversation(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    dismissSuggestionOnInput()
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const files = fileAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0 && files.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images, ...files], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file") {
      // file parts are attachments, not pills in the editor
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      // 文件附件不插入正文，但仍要遵循编辑器选择替换语义，避免粘贴附件后残留被选中的旧文本。
      range.deleteContents()
      const nextCursor = getCursorPosition(editorRef)
      handleInput()
      const filePart = part as FileAttachmentPart
      const current = prompt.current()
      prompt.set([...current, filePart], nextCursor)
      return true
    }

    if (part.type === "agent" || part.type === "plugin" || part.type === "skill" || part.type === "conversation") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const triggerMatch =
        part.type === "skill"
          ? textBeforeCursor.match(/\/(\S*)$/)
          : part.type === "conversation"
            ? undefined
            : textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(part.type === "skill" && part.content.endsWith(" ") ? "\u200B" : " ")

      if (triggerMatch) {
        const start = triggerMatch.index ?? cursorPosition - triggerMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const attachQuickChat = (event: Event) => {
    const detail = (event as CustomEvent<QuickChatAttachDetail>).detail
    if (!detail?.id || !detail.title || !detail.transcript) return
    // 回执写回 detail：调用方据此区分「已插入」「已引用过」「根本没人接」三种结果。
    // 同一个会话只引用一次，重复点不该在输入框里堆出多个相同引用。
    if (editorRef.querySelector(`[data-conversation-id="${CSS.escape(detail.id)}"]`)) {
      detail.result = "duplicate"
      return
    }
    // 按 addPart 的真实结果回执：它在光标不在编辑器内等情况下会返回 false，
    // 若无条件标记成功，又会变成「提示已添加但引用没进去」。
    if (
      addPart({
        type: "conversation",
        id: detail.id,
        title: detail.title,
        transcript: detail.transcript,
        content: detail.title,
        start: 0,
        end: detail.title.length,
      })
    ) {
      detail.result = "added"
    }
  }
  window.addEventListener(QUICK_CHAT_ATTACH_EVENT, attachQuickChat)
  onCleanup(() => window.removeEventListener(QUICK_CHAT_ATTACH_EVENT, attachQuickChat))

  const acceptSuggestion = () => {
    const text = ghost()
    if (!text) return false
    if (!addPart({ type: "text", content: text, start: 0, end: 0 })) return false
    setDismissedSuggestion(text)
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, prompt, mode === "shell" ? [] : historyComments())
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        const message = sync.data.message[params.id ?? ""]?.find((item): item is typeof item & { role: "user" } => {
          return item.id === id && item.role === "user"
        })
        if (message?.agent) local.agent.set(message.agent)

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        prompt.addToChat.replace(edit.addToChatSnippets ?? [])
        requestAnimationFrame(() => {
          editorRef.focus()
          setCursorPosition(editorRef, promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addAttachments, addReference, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
    projectDirectory: () => sdk.directory,
  })

  const restoringPastedText = new Set<string>()
  const removeFileAttachment = (path: string) => {
    if (pastedPreview()?.path === path) closePastedPreview()
    prompt.set(
      prompt.current().filter((part) => part.type !== "file" || part.path !== path),
      prompt.cursor(),
    )
  }
  const showPastedTextInTextField = (attachment: FileAttachmentPart) => {
    if (restoringPastedText.has(attachment.path)) return
    restoringPastedText.add(attachment.path)

    // 保留用户点击前的编辑器选区；读取成功后在该位置插入，并仅移除对应的临时附件卡片。
    void (async () => {
      try {
        const preview = pastedPreview()
        if (preview?.path === attachment.path && preview.draft !== preview.saved) {
          if (!(await savePastedPreview())) return
        }

        const live = prompt.current().find((part) => part.type === "file" && part.path === attachment.path)
        const characterCount =
          live && live.type === "file" ? live.pastedText?.characterCount : attachment.pastedText?.characterCount
        if (!canRestorePastedText(characterCount)) return

        const response = await sdk.client.file.read({ path: attachment.path })
        const content = response.data?.content
        if (response.data?.type !== "text" || typeof content !== "string" || !canRestorePastedText(content.length)) {
          throw new Error("pasted text is not restorable")
        }
        const restored = restorePastedTextContent(content)
        if (!addPart({ type: "text", content: restored, start: 0, end: 0 })) {
          throw new Error("pasted text could not be inserted")
        }
        const anchor = attachment.content.startsWith("@") ? attachment.content : `@${attachment.content}`
        if (pastedPreview()?.path === attachment.path) closePastedPreview()
        // 恢复正文后移除文件卡片，并删掉编排器插入的精确 @锚点文本，避免孤儿 @Alice.json。
        prompt.set(
          removeExactPastedAnchorParts(
            prompt.current().filter((part) => part.type !== "file" || part.path !== attachment.path),
            anchor,
          ),
          prompt.cursor(),
        )
        recordIssueAction("prompt.paste.textAttachment.restored", {
          chars: restored.length,
          path_hash: stableHash(attachment.path),
        })
      } catch (error: unknown) {
        recordIssueEvent({
          type: "error",
          name: "prompt.paste.textAttachment.restoreFailed",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          data: { path_hash: stableHash(attachment.path) },
        })
        showToast({ title: language.t("prompt.toast.pastedTextRestoreFailed.title"), variant: "error" })
      } finally {
        restoringPastedText.delete(attachment.path)
      }
    })()
  }

  const variants = createMemo(() => ["default", ...local.model.variant.list()])
  const permissionLabel = createMemo(() => {
    if (permission.mode() === "ask") return language.t("prompt.permission.default")
    if (permission.mode() === "full_access") return language.t("prompt.permission.full")
    return language.t("prompt.permission.auto")
  })
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false)
  const [permissionMenuOpen, setPermissionMenuOpen] = createSignal(false)
  const updatePermissionMode = async (value: PermissionMode) => {
    try {
      await permission.setMode(value)
    } catch (err) {
      showToast({
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
        variant: "error",
      })
      throw err
    }
  }
  const confirmFullAccess = () => {
    setPermissionMenuOpen(false)
    dialog.show(() => (
      <DialogPermissionFullAccess onConfirm={() => updatePermissionMode("full_access")} />
    ))
  }
  // 1:1 复刻 Codex：「计划模式」toggle，on 时切到 plan agent，off 时切回第一个非 plan agent（一般是 build）
  const isPlanMode = createMemo(() => local.agent.current()?.name === "plan")
  const disablePlanMode = () => {
    const fallback = agentNames().find((name) => name !== "plan") ?? agentNames()[0]
    if (fallback) local.agent.set(fallback)
  }
  const toggleGoalMode = () => {
    if (!props.isGoalModeActive?.() && isPlanMode()) disablePlanMode()
    props.onGoalModeToggle?.()
    restoreFocus()
  }
  const togglePlanMode = () => {
    if (isPlanMode()) {
      disablePlanMode()
    } else if (agentNames().includes("plan")) {
      if (props.isGoalModeActive?.()) props.onGoalModeToggle?.()
      local.agent.set("plan")
    } else {
      showToast({ title: language.t("prompt.plan.unavailable") })
    }
    restoreFocus()
  }
  createEffect(
    on(
      () => props.isGoalModeActive?.() ?? false,
      (active) => {
        if (active && isPlanMode()) disablePlanMode()
      },
    ),
  )

  const [effortStub, setEffortStub] = createSignal<string>("medium")
  const effortValue = createMemo(() => local.model.variant.current() ?? effortStub())
  const modelSupportsEffort = createMemo(() => local.model.variant.list().length > 0)
  const setEffort = (value: string) => {
    setEffortStub(value)
    local.model.variant.set(value)
  }

  const { inScratchMode, newSessionProject, isScratchProject, scratchChatDir, setScratchChatDir } = useScratchMode()

  // 项目根 tag：仅在尚无用户消息（新会话/空会话）时显示，避免对话开始后干扰
  const projectTag = createMemo(() => {
    const project = sync.project
    const path = project?.worktree ?? sdk.directory
    if (!path) return undefined
    const name = project?.name?.trim() || getFilename(path)
    if (!name) return undefined
    if (hasUserPrompt()) return undefined
    return { name, path }
  })

  // 新会话项目选择器：列出可见项目（过滤散对话目录）
  const projectPickerList = createMemo(() =>
    layout.projects
      .list()
      .filter((project) => !isScratchProject(project.worktree))
      .map((project) => ({
        project,
        label: project.name?.trim() || getFilename(project.worktree),
      })),
  )
  const goToProject = (worktree: string) => {
    if (!worktree) return
    server.projects.touch(worktree)
    openNewSession({ slug: base64Encode(worktree), reset: resetPromptDraft, navigate })
  }

  // 切到无项目模式：跳到 scratch dir 的新会话页；signal 还没 ready 时直接 await ensure
  const detachFromProject = async () => {
    let scratch = scratchChatDir()
    if (!scratch && platform.ensureScratchChatDir) {
      try {
        scratch = await platform.ensureScratchChatDir()
        if (scratch) setScratchChatDir(scratch)
      } catch {
        return
      }
    }
    if (!scratch) return
    openNewSession({ slug: base64Encode(scratch), reset: resetPromptDraft, navigate })
  }

  const { abort, handleSubmit } = createPromptSubmit({
    info,
    imageAttachments,
    commentCount,
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    shouldSteer: props.shouldSteer,
    onSteer: props.onSteer,
    onAbort: props.onAbort,
    activeTurnID: props.activeTurnID,
    onAbortComplete: props.onAbortComplete,
    // submit.ts 的异步链显式消费页面解析后的身份，不能回退到常驻父路由可能滞后的 params.id。
    sessionID: () => params.id,
    routeIdentity: sessionKey,
    syncEditorBeforeSubmit: () => {
      // 提交按钮可能由鼠标点击触发,此时 contenteditable 的最后一次 DOM 变更未必已经写入 prompt store。
      // 先按当前 DOM 解析一次,保证“看见什么就提交什么”,也避免失败后的后续输入被空 prompt 分支吞掉。
      if (composing()) return
      handleInput()
    },
    onBeforeSubmitExistingSession: props.onBeforeSubmitExistingSession,
    flushPermissionMode: permission.flush,
    onSubmit: props.onSubmit,
    isGoalModeActive: props.isGoalModeActive,
    onGoalSubmit: props.onGoalSubmit,
    onExitGoalMode: props.onExitGoalMode,
    imageGeneration: () => ({
      enabled: imageGenerationModel(),
      count: store.imageCount,
      size: store.imageSize,
    }),
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        // 复刻 Codex：第一次 ESC 进入「Esc」确认态，再按一次才中断
        if (escArmed()) {
          disarmEsc()
          void abort()
        } else {
          armEsc()
        }
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (isAcceptSuggestionKey(event) && ghost()) {
      if (acceptSuggestion()) {
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      // 先同步 contenteditable 再判断空输入：忙态空回车不能等同于点击停止按钮，有真实新内容时仍正常引导。
      if (!composing()) handleInput()
      if (working() && blank()) return
      void handleSubmit(event)
    }
  }

  // 这三个 query 只消费 isLoading：不要用 useQueries（会把全量 data 深拷贝进 store，
  // composer 每次挂载/目录切换白付数百 ms 的深度 unwrap），只订阅加载态
  const agentsPending = createQueryPending(queryClient, () => loadAgentsQuery(sdk.directory, sdk.client))
  const globalProvidersPending = createQueryPending(queryClient, () =>
    loadProvidersQuery(null, globalSDK.client, queryClient),
  )
  const providersPending = createQueryPending(queryClient, () =>
    loadProvidersQuery(sdk.directory, sdk.client, queryClient),
  )

  const agentsLoading = () => agentsPending()
  const agentsShouldFadeIn = createMemo((prev) => prev ?? agentsLoading())
  const providersLoading = () => agentsLoading() || providersPending() || globalProvidersPending()
  const providersShouldFadeIn = createMemo((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready().promise,
    (p) => p,
  )

  return (
    <div class="relative size-full _max-h-[320px] flex flex-col gap-2 mb-2">
      {(promptReady(), null)}
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atGrouped={atGrouped() ?? []}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <Show when={pastedPreview()?.path}>
        <Suspense
          fallback={
            <div class="min-h-[200px] w-full animate-pulse rounded-xl border border-border-base bg-surface-raised-stronger-non-alpha" />
          }
        >
          <PastedAttachmentPreview
            path={pastedPreview()!.path}
            kind={pastedPreview()!.kind}
            filename={pastedPreview()!.filename}
            value={pastedPreview()!.draft}
            dirty={pastedPreview()!.draft !== pastedPreview()!.saved}
            saving={pastedPreview()!.saving}
            onInput={(value) => {
              const current = pastedPreview()
              if (!current) return
              setPastedPreview({ ...current, draft: value })
            }}
            onSave={savePastedPreview}
            onClose={closePastedPreview}
            onOpenExternal={() => {
              const current = pastedPreview()
              if (!current) return
              void (async () => {
                if (current.draft !== current.saved && !(await savePastedPreview())) return
                const latest = pastedPreview() ?? current
                closePastedPreview()
                openFileAttachment({
                  type: "file",
                  path: latest.path,
                  content: "@" + latest.filename,
                  start: 0,
                  end: 0,
                })
              })()
            }}
          />
        </Suspense>
      </Show>
      {/* 输入框外壳由 dock-surface 的 codex 变体统一控制，避免局部 Tailwind 背景覆盖 wanlai 主题 token。 */}
      <Show when={!params.id && store.mode !== "shell"}>
        <div data-component="prompt-new-session-topbar" class="px-8 pt-2">
          <div class="flex min-w-0 items-center gap-5 overflow-hidden rounded-t-[18px] px-4 pb-4 pt-2.5">
            <DropdownMenu placement="top-start" gutter={4} open={projectMenuOpen()} onOpenChange={setProjectMenuOpen}>
              <DropdownMenu.Trigger
                as={Button}
                type="button"
                variant="ghost"
                class="min-w-0 max-w-[220px] h-7 px-1.5 text-13-regular text-text-strong hover:!bg-transparent"
                data-action="prompt-new-session-project"
                aria-label={language.t("session.new.project.picker")}
              >
                <Icon
                  name="folder-branch"
                  size="small"
                  class="shrink-0 text-icon-weak"
                  style="width:17px;height:17px"
                  viewBox="0 0 75 75"
                />
                <span class="truncate">{newSessionProject()?.name ?? language.t("session.new.project.empty")}</span>
                <Icon
                  name={projectMenuOpen() ? "chevron-up" : "chevron-down"}
                  size="small"
                  class="shrink-0"
                />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="codex-chat-menu min-w-[260px]">
                  <DropdownMenu.Group>
                    <For each={projectPickerList()}>
                      {(item) => {
                        const worktree = item.project.worktree
                        return (
                          <DropdownMenu.Item onSelect={() => goToProject(worktree)}>
                            <Icon
                              name="folder-branch"
                              size="small"
                              class="text-icon-weak"
                              style="width:15px;height:15px"
                              viewBox="0 0 75 75"
                            />
                            <DropdownMenu.ItemLabel class="truncate">{item.label}</DropdownMenu.ItemLabel>
                            <Show when={newSessionProject()?.path === worktree}>
                              <Icon name="check-small" size="small" class="text-icon-weak ml-auto" />
                            </Show>
                          </DropdownMenu.Item>
                        )
                      }}
                    </For>
                  </DropdownMenu.Group>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onSelect={() => command.trigger("project.open")}>
                    <Icon name="folder-add-left" size="small" class="text-icon-weak" />
                    <DropdownMenu.ItemLabel>{language.t("sidebar.filter.add.project")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <Show when={!inScratchMode()}>
                    <DropdownMenu.Item onSelect={detachFromProject}>
                      <Icon name="folder-add-left" size="small" class="text-icon-weak rotate-180" />
                      <DropdownMenu.ItemLabel>{language.t("session.new.project.detach")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </Show>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
            <Show when={!inScratchMode()}>
              <ExecutionModeControl variant="footer" />
            </Show>
            <BranchPickerControl variant="footer" onNewSessionWorktreeCreate={props.onNewSessionWorktreeCreate} />
          </div>
        </div>
      </Show>
      <DockShellForm
        onSubmit={handleSubmit}
        data-variant="codex"
        data-prompt-mode={imageGenerationModel() ? "image-generation" : store.mode}
        classList={{
          "group/prompt-input": true,
          "max-h-[360px] overflow-hidden": true,
          "-mt-3": !params.id && store.mode !== "shell",
          "focus-within:shadow-xs-border": false,
          // "border-icon-info-active border-dashed": store.draggingType !== null,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <PromptDragOverlay
          type={store.draggingType}
          label={language.t(store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
        />
        <PromptContextItems
          items={contextItems()}
          projectTag={undefined}
          active={(item) => {
            const active = comments.active()
            return !!item.commentID && item.commentID === active?.id && item.path === active?.file
          }}
          openComment={openComment}
          remove={(item) => {
            if (item.commentID) comments.remove(item.path, item.commentID)
            prompt.context.remove(item.key)
          }}
          t={(key) => language.t(key as Parameters<typeof language.t>[0])}
        />
        <PromptAddToChatSelectionTag />
        <Show when={imageAttachments().length > 0 || fileAttachments().length > 0}>
          <div class="flex min-w-0 max-w-full flex-nowrap items-start gap-2 overflow-x-auto px-3 pt-3 pb-2 no-scrollbar">
            <PromptImageAttachments
              class="contents"
              attachments={imageAttachments()}
              onOpen={openImageAttachmentPreview}
              onRemove={removeAttachment}
              removeLabel={language.t("prompt.attachment.remove")}
            />
            <PromptFileAttachments
              class="contents"
              attachments={fileAttachments()}
              onOpen={handleFileAttachmentOpen}
              onRemove={removeFileAttachment}
              onShowInTextField={showPastedTextInTextField}
              pastedTextLabel={language.t("prompt.attachment.pastedText")}
              showInTextFieldLabel={language.t("prompt.attachment.showInTextField")}
              removeLabel={language.t("prompt.attachment.remove")}
            />
          </div>
        </Show>
        <div
          class="relative pb-12"
          onMouseDown={(e) => {
            const target = e.target
            if (!(target instanceof HTMLElement)) return
            if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) {
              return
            }
            editorRef?.focus()
          }}
        >
          <div
            class="prompt-input-scrollbar relative max-h-[192px] overflow-y-auto"
            ref={(el) => (scrollRef = el)}
            style={{ "scroll-padding-bottom": space }}
          >
            <div
              data-component="prompt-input"
              ref={(el) => {
                editorRef = el
                props.ref?.(el)
              }}
              role="textbox"
              aria-multiline="true"
              aria-label={ghost() ?? placeholder()}
              contenteditable="true"
              autocapitalize={store.mode === "normal" ? "sentences" : "off"}
              autocorrect={store.mode === "normal" ? "on" : "off"}
              spellcheck={store.mode === "normal"}
              inputMode="text"
              // @ts-expect-error
              autocomplete="off"
              onInput={handleInput}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              classList={{
                "select-text": true,
                "w-full pl-4 pr-4 pt-3 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap cursor-text": true,
                "[&_[data-type=file]]:text-syntax-property": true,
                "[&_[data-type=agent]]:text-syntax-type": true,
                "[&_[data-type=plugin]]:text-syntax-type [&_[data-type=plugin]]:font-medium": true,
                "[&_[data-type=plugin]]:align-baseline [&_[data-type=plugin]]:whitespace-nowrap": true,
                "[&_[data-type=plugin]_[data-slot=plugin-chip-logo]]:inline-block [&_[data-type=plugin]_[data-slot=plugin-chip-logo]]:align-[-0.2em] [&_[data-type=plugin]_[data-slot=plugin-chip-logo]]:mr-1 [&_[data-type=plugin]_[data-slot=plugin-chip-logo]]:size-3.5 [&_[data-type=plugin]_[data-slot=plugin-chip-logo]]:rounded-sm [&_[data-type=plugin]_[data-slot=plugin-chip-logo]]:object-cover": true,
                "[&_[data-type=conversation]]:inline-flex [&_[data-type=conversation]]:items-center [&_[data-type=conversation]]:gap-1 [&_[data-type=conversation]]:align-baseline [&_[data-type=conversation]]:whitespace-nowrap [&_[data-type=conversation]]:text-text-interactive-base [&_[data-type=conversation]]:font-medium": true,
                "[&_[data-type=conversation]_[data-slot=conversation-chip-icon]]:shrink-0 [&_[data-type=conversation]_[data-slot=conversation-chip-icon]]:align-[-0.16em]": true,
                "font-mono!": store.mode === "shell",
                "font-sans": true,
              }}
              style={{ "padding-bottom": space }}
            />
            <div
              class="absolute top-0 inset-x-0 pl-4 pr-4 pt-3 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate"
              classList={{ "font-mono!": store.mode === "shell" }}
              style={{ "padding-bottom": space, display: prompt.dirty() ? "none" : undefined }}
            >
              {ghost() ?? placeholder()}
            </div>
          </div>

          <div class="pointer-events-none absolute inset-x-2.5 bottom-2.5 z-20 flex h-9 min-w-0 items-center gap-2 overflow-hidden">
            <div class="pointer-events-none order-2 ml-auto flex h-9 min-w-0 items-center">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_FILE_TYPES.join(",")}
                class="hidden"
                onChange={(e) => {
                  const list = e.currentTarget.files
                  if (list) void addAttachments(Array.from(list))
                  e.currentTarget.value = ""
                }}
              />

              <div class="pointer-events-auto flex w-full min-w-0 items-center justify-end gap-1 overflow-hidden [&>[data-slot=hover-card-trigger]]:!w-6 [&>[data-slot=hover-card-trigger]]:shrink-0">
                {/* 1:1 复刻 Codex：上下文进度环位于模型按钮左侧 */}
                <Show when={store.mode !== "shell"}>
                  <SessionContextUsage placement="top" />
                </Show>
                <Show when={imageGenerationModel()}>
                  <DropdownMenu placement="top-end" gutter={4}>
                    <DropdownMenu.Trigger
                      as={Button}
                      variant="ghost"
                      size="normal"
                      style={control()}
                      class="text-13-regular text-text-base"
                      data-action="prompt-image-count"
                    >
                      <Icon name="photo" size="small" class="text-icon-weak" />
                      <span>{language.t("prompt.imageGeneration.count", { count: String(store.imageCount) })}</span>
                      <Icon name="chevron-down" size="small" class="shrink-0" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="codex-chat-menu min-w-[120px] [&_[data-slot=dropdown-menu-item]]:pl-1">
                        <For each={IMAGE_GENERATION_COUNTS}>
                          {(count) => (
                            <DropdownMenu.Item
                              onSelect={() => {
                                setStore("imageCount", count)
                                restoreFocus()
                              }}
                            >
                              <DropdownMenu.ItemLabel>
                                {language.t("prompt.imageGeneration.count", { count: String(count) })}
                              </DropdownMenu.ItemLabel>
                              <Show when={store.imageCount === count}>
                                <Icon name="check-small" size="small" class="text-icon-weak ml-auto" />
                              </Show>
                            </DropdownMenu.Item>
                          )}
                        </For>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                  <Button
                    type="button"
                    variant="ghost"
                    size="normal"
                    style={control()}
                    class="max-w-[170px] text-13-regular text-text-base"
                    data-action="prompt-image-size"
                    onClick={() =>
                      dialog.show(() => (
                        <ImageGenerationSizeDialog
                          value={store.imageSize}
                          onSelect={(value) => {
                            setStore("imageSize", value)
                            restoreFocus()
                          }}
                        />
                      ))
                    }
                  >
                    <Icon name="layout-bottom" size="small" class="text-icon-weak" />
                    <span class="truncate">{imageSizeLabel()}</span>
                    <Icon name="chevron-down" size="small" class="shrink-0" />
                  </Button>
                </Show>
                {/* 1:1 复刻 Codex：模型选择器位于麦克风左侧 */}
                <Show when={store.mode !== "shell"}>
                  <div
                    data-component="prompt-model-control"
                    class="min-w-0 flex-1 overflow-hidden [&>div]:w-full [&>div]:min-w-0 [&>div]:overflow-hidden"
                    style={providersShouldFadeIn() ? { animation: "fade-in 0.3s" } : undefined}
                  >
                    {/* 1:1 复刻 Codex：模型 dropdown — 顶部 effort radio + 底部"其他模型 ›"（统一 paid/unpaid） */}
                    <DropdownMenu placement="top-end" gutter={4}>
                      <TooltipKeybind
                        placement="top"
                        gutter={4}
                        title={language.t("command.model.choose")}
                        keybind={command.keybind("model.choose")}
                      >
                        <DropdownMenu.Trigger
                          as={Button}
                          variant="ghost"
                          size="normal"
                          style={control()}
                          class="group w-full min-w-0 max-w-[320px] overflow-hidden text-13-regular text-text-base"
                          data-action="prompt-model"
                        >
                          <Show when={local.model.current()?.provider?.id}>
                            <ProviderIcon
                              id={local.model.current()?.provider?.id ?? ""}
                              class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                              style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                            />
                          </Show>
                          <span class="truncate">
                            {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                            <Show when={effortValue()}>
                              {(v) => (
                                <span class="ml-1 text-text-weak">
                                  {language.t(`prompt.model.effort.${v() as "low" | "medium" | "high" | "xhigh"}`)}
                                </span>
                              )}
                            </Show>
                          </span>
                          <Icon name="chevron-down" size="small" class="shrink-0" />
                        </DropdownMenu.Trigger>
                      </TooltipKeybind>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class="codex-chat-menu min-w-[180px] [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
                          {/* 1:1 复刻 Codex：始终显示 effort 4 档；
                              当前 model 若不支持 variants，set 静默忽略，UI 仅展示标准 4 档。 */}
                          <DropdownMenu.Group>
                            <DropdownMenu.GroupLabel class="!px-1 !py-1 flex items-center gap-2">
                              <span>{language.t("prompt.model.effort")}</span>
                              <Show when={!modelSupportsEffort()}>
                                <span class="text-text-weak text-12-regular">
                                  {language.t("prompt.model.effort.unsupported")}
                                </span>
                              </Show>
                            </DropdownMenu.GroupLabel>
                            <DropdownMenu.RadioGroup
                              class="mt-1"
                              value={effortValue()}
                              onChange={(v) => {
                                setEffort(String(v))
                                restoreFocus()
                              }}
                            >
                              <For each={["low", "medium", "high", "xhigh"] as const}>
                                {(v) => (
                                  <DropdownMenu.RadioItem value={v} disabled={!modelSupportsEffort()}>
                                    <DropdownMenu.ItemLabel>
                                      {language.t(`prompt.model.effort.${v}`)}
                                    </DropdownMenu.ItemLabel>
                                    <DropdownMenu.ItemIndicator>
                                      <Icon name="check-small" size="small" class="text-icon-weak" />
                                    </DropdownMenu.ItemIndicator>
                                  </DropdownMenu.RadioItem>
                                )}
                              </For>
                            </DropdownMenu.RadioGroup>
                          </DropdownMenu.Group>
                          <DropdownMenu.Separator />
                          {/* 当前模型 + 其他模型入口（按 paid/unpaid 选 dialog） */}
                          <DropdownMenu.Item
                            onSelect={() => {
                              if (providers.paid().length > 0) {
                                void import("@/components/dialog-select-model").then((x) => {
                                  dialog.show(() => (
                                    <x.DialogSelectModel model={local.model} afterMessageID={lastUserMessageID()} />
                                  ))
                                })
                              } else {
                                void import("@/components/dialog-select-model-unpaid").then((x) => {
                                  dialog.show(() => (
                                    <x.DialogSelectModelUnpaid
                                      model={local.model}
                                      afterMessageID={lastUserMessageID()}
                                    />
                                  ))
                                })
                              }
                            }}
                          >
                            <Show when={local.model.current()?.provider?.id}>
                              <ProviderIcon id={local.model.current()?.provider?.id ?? ""} class="size-4 shrink-0" />
                            </Show>
                            <DropdownMenu.ItemLabel>
                              {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                            </DropdownMenu.ItemLabel>
                            <Icon name="chevron-right" size="small" class="text-icon-weak ml-auto" />
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  </div>
                </Show>
                {/* 1:1 复刻 Codex：提交按钮左侧增加语音输入按钮（功能暂未接入，点击 stub） */}
                <Tooltip placement="top" value={language.t("prompt.action.voice")}>
                  <Button
                    data-action="prompt-voice"
                    type="button"
                    variant="ghost"
                    class="size-8 shrink-0 p-0"
                    disabled={store.mode !== "normal"}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    onClick={() => {
                      showToast({ title: language.t("prompt.action.voice.comingSoon") })
                    }}
                    aria-label={language.t("prompt.action.voice")}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 20 20"
                      fill="none"
                      aria-hidden="true"
                      class="text-text-base"
                    >
                      <path
                        d="M10 12.5C11.3807 12.5 12.5 11.3807 12.5 10V5C12.5 3.61929 11.3807 2.5 10 2.5C8.61929 2.5 7.5 3.61929 7.5 5V10C7.5 11.3807 8.61929 12.5 10 12.5Z"
                        stroke="currentColor"
                        stroke-width="1.25"
                        stroke-linecap="square"
                      />
                      <path
                        d="M15.625 9.16667V10C15.625 13.1066 13.1066 15.625 10 15.625C6.8934 15.625 4.375 13.1066 4.375 10V9.16667M10 15.625V17.9167M7.5 17.9167H12.5"
                        stroke="currentColor"
                        stroke-width="1.25"
                        stroke-linecap="square"
                      />
                    </svg>
                  </Button>
                </Tooltip>
                <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                  <Show
                    when={stopping() && escArmed()}
                    fallback={
                      <IconButton
                        data-action="prompt-submit"
                        type="submit"
                        // 不使用原生 disabled:contenteditable 可见文本和 prompt store 短暂不同步时,
                        // disabled 会阻止 submit 前同步执行,导致“看见有字但发送无效”。
                        aria-disabled={!working() && blank()}
                        tabIndex={store.mode === "normal" ? undefined : -1}
                        icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                        variant="primary"
                        class={`size-7 rounded-[48px] ${!stopping() && blank() ? "bg-icon-strong-disabled" : "bg-icon-strong-base"}`}
                        aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                      />
                    }
                  >
                    {/* 复刻 Codex：ESC 确认态——按钮显示「Esc」，点击或再按 ESC 中断 */}
                    <button
                      data-action="prompt-submit"
                      type="submit"
                      class="flex size-7 items-center justify-center rounded-[48px] bg-icon-strong-base text-[10px] font-medium text-background-base"
                      aria-label={language.t("prompt.action.stop")}
                    >
                      Esc
                    </button>
                  </Show>
                </Tooltip>
              </div>
            </div>

            <div class="pointer-events-none order-1 flex h-9 min-w-0 items-center">
              <div
                aria-hidden={store.mode !== "normal"}
                class="pointer-events-auto flex w-full min-w-0 items-center gap-1 overflow-hidden"
                style={{
                  "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                }}
              >
                {/* 1:1 复刻 Codex：「+」按钮 dropdown 三项 — 添加照片和文件 / 计划模式 toggle / 插件 ›
                  「计划模式」toggle 切换 plan agent；「插件 ›」二级子菜单列出已安装插件,
                  点选即把该插件以 mention pill 插入输入框(复用 @ 弹层的 handleAtSelect)。 */}
                <DropdownMenu placement="top-start" gutter={4}>
                  <DropdownMenu.Trigger
                    as={Button}
                    data-action="prompt-attach"
                    type="button"
                    variant="ghost"
                    class="size-9 shrink-0 rounded-[12px] p-0"
                    style={buttons()}
                    disabled={store.mode !== "normal"}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    aria-label={language.t("prompt.action.attachFile")}
                  >
                    <Icon name="plus" class="size-4.5" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="codex-chat-menu [&_[data-slot=dropdown-menu-item]]:pl-1 [&_[data-slot=dropdown-menu-sub-trigger]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
                      <DropdownMenu.Item onSelect={() => pick()}>
                        <div class="flex size-5 shrink-0 items-center justify-center">
                          {/* 1:1 复刻 Codex：回形针图标 */}
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="text-icon-weak"
                            aria-hidden="true"
                          >
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                        </div>
                        <DropdownMenu.ItemLabel>{language.t("prompt.action.attachFile")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item closeOnSelect={false} onSelect={togglePlanMode}>
                        <div class="flex size-5 shrink-0 items-center justify-center">
                          <Icon name="task" size="small" class="text-icon-weak" />
                        </div>
                        <DropdownMenu.ItemLabel>{language.t("prompt.plan.label")}</DropdownMenu.ItemLabel>
                        <div
                          class="relative shrink-0 transition-colors duration-150"
                          style={{
                            width: "30px",
                            height: "18px",
                            "border-radius": "999px",
                            background: isPlanMode()
                              ? "rgb(33, 130, 255)"
                              : "light-dark(rgba(0,0,0,0.16), rgba(255,255,255,0.18))",
                          }}
                          aria-hidden="true"
                        >
                          <div
                            class="absolute top-1/2 transition-[left,background,box-shadow] duration-150"
                            style={{
                              width: "12px",
                              height: "12px",
                              "border-radius": "999px",
                              left: isPlanMode() ? "15px" : "3px",
                              transform: "translateY(-50%)",
                              background: "#ffffff",
                              "box-shadow": "0 1px 2px rgba(0,0,0,0.18)",
                            }}
                          />
                        </div>
                      </DropdownMenu.Item>
                      <Show when={props.onGoalModeToggle}>
                        <DropdownMenu.Item onSelect={() => props.onGoalModeToggle?.()}>
                          <div class="flex size-5 shrink-0 items-center justify-center">
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.6"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              class="text-icon-weak"
                              aria-hidden="true"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <circle cx="12" cy="12" r="5" />
                              <circle cx="12" cy="12" r="1.5" />
                            </svg>
                          </div>
                          <DropdownMenu.ItemLabel>{language.t("prompt.goal.label")}</DropdownMenu.ItemLabel>
                          <div
                            class="relative shrink-0 transition-colors duration-150"
                            style={{
                              width: "30px",
                              height: "18px",
                              "border-radius": "999px",
                              background: props.isGoalModeActive?.()
                                ? "rgb(33, 130, 255)"
                                : "light-dark(rgba(0,0,0,0.16), rgba(255,255,255,0.18))",
                            }}
                            aria-hidden="true"
                          >
                            <div
                              class="absolute top-1/2 transition-[left,background,box-shadow] duration-150"
                              style={{
                                width: "12px",
                                height: "12px",
                                "border-radius": "999px",
                                left: props.isGoalModeActive?.() ? "15px" : "3px",
                                transform: "translateY(-50%)",
                                background: "#ffffff",
                                "box-shadow": "0 1px 2px rgba(0,0,0,0.18)",
                              }}
                            />
                          </div>
                        </DropdownMenu.Item>
                      </Show>
                      <DropdownMenu.Sub>
                        <DropdownMenu.SubTrigger>
                          <div class="flex size-5 shrink-0 items-center justify-center">
                            <Icon name="apps-grid" size="small" class="text-icon-weak" />
                          </div>
                          <span class="flex-1">{language.t("prompt.plugins.label")}</span>
                          <Icon name="chevron-right" size="small" class="text-icon-weak ml-auto" />
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.SubContent class="codex-chat-menu max-h-[min(60vh,360px)] min-w-[240px] overflow-y-auto [&_[data-slot=dropdown-menu-item]]:pl-1">
                            <DropdownMenu.Group>
                              <Show when={installedPlugins().length > 0}>
                                <DropdownMenu.GroupLabel>
                                  {language.t(
                                    installedPlugins().length === 1
                                      ? "prompt.plugins.installed.one"
                                      : "prompt.plugins.installed.other",
                                    { count: installedPlugins().length },
                                  )}
                                </DropdownMenu.GroupLabel>
                              </Show>
                              <Show
                                when={installedPlugins().length > 0}
                                fallback={
                                  <div class="px-2.5 py-1.5 text-13-regular text-text-weak">
                                    {language.t("prompt.plugins.empty")}
                                  </div>
                                }
                              >
                                <For each={installedPlugins()}>
                                  {(plugin) => (
                                    <DropdownMenu.Item
                                      onSelect={() => {
                                        handleAtSelect({
                                          type: "plugin",
                                          addonKey: plugin.addonKey,
                                          name: plugin.name,
                                          display: plugin.display,
                                        })
                                        restoreFocus()
                                      }}
                                    >
                                      <div class="flex size-5 shrink-0 items-center justify-center">
                                        <Show
                                          when={plugin.logo}
                                          fallback={
                                            <div
                                              class="size-5 rounded-md flex items-center justify-center shrink-0 text-11-medium text-white"
                                              style={{ "background-color": plugin.brandColor || "#71717A" }}
                                            >
                                              {(plugin.display.charAt(0) || "?").toUpperCase()}
                                            </div>
                                          }
                                        >
                                          <img
                                            src={plugin.logo}
                                            alt=""
                                            class="size-5 rounded-md shrink-0 object-cover bg-surface-base"
                                          />
                                        </Show>
                                      </div>
                                      <DropdownMenu.ItemLabel>{plugin.display}</DropdownMenu.ItemLabel>
                                    </DropdownMenu.Item>
                                  )}
                                </For>
                              </Show>
                            </DropdownMenu.Group>
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Sub>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>

                {/* 1:1 复刻 Codex：计划模式开启时，+ 旁出现「计划」chip，点击关闭 */}
                <Show when={isPlanMode()}>
                  <Tooltip placement="top" value={language.t("prompt.plan.disable")}>
                    <Button
                      data-action="prompt-plan-chip"
                      type="button"
                      variant="ghost"
                      size="normal"
                      style={control()}
                      class="group text-13-regular text-text-base shrink-0"
                      onClick={togglePlanMode}
                      aria-label={language.t("prompt.plan.disable")}
                    >
                      <Icon name="task" size="small" class="shrink-0 group-hover:hidden" />
                      <Icon name="close-small" size="small" class="hidden shrink-0 group-hover:flex" />
                      <span>{language.t("prompt.plan.label")}</span>
                    </Button>
                  </Tooltip>
                </Show>
                <Show when={props.isGoalModeActive?.() && props.onGoalModeToggle}>
                  <Tooltip placement="top" value={language.t("session.goal.chip.tooltip")} gutter={4}>
                    <Button
                      data-action="prompt-goal-chip"
                      type="button"
                      variant="ghost"
                      size="normal"
                      style={control()}
                      class="group text-13-regular text-text-base shrink-0"
                      onClick={toggleGoalMode}
                      aria-label={language.t("session.goal.chip.tooltip")}
                    >
                      <Icon name="target" size="small" class="shrink-0 group-hover:hidden" />
                      <Icon name="close-small" size="small" class="hidden shrink-0 group-hover:flex" />
                      <span>{language.t("session.goal.chip")}</span>
                    </Button>
                  </Tooltip>
                </Show>

                {/* 1:1 复刻 Codex：紧贴 + 按钮的「默认权限 ▾」 */}
                <Show when={!agentsLoading()}>
                  <DropdownMenu
                    placement="top-start"
                    gutter={4}
                    open={permissionMenuOpen()}
                    onOpenChange={setPermissionMenuOpen}
                  >
                    <DropdownMenu.Trigger
                      as={Button}
                      type="button"
                      variant="ghost"
                      size="normal"
                      style={control()}
                      class="min-w-0 max-w-[200px] flex-1 text-13-regular text-text-base"
                      data-action="prompt-permission"
                      data-permission-mode={permission.mode()}
                      aria-label={language.t("prompt.permission.label")}
                    >
                      <Show when={permission.mode() === "ask"}>
                        <Icon name="hand" size="small" class="text-icon-weak" viewBox="0 0 1024 1024" />
                      </Show>
                      <Show when={permission.mode() === "auto_review"}>
                        <Icon name="circle-check" size="small" class="text-icon-weak" />
                      </Show>
                      <Show when={permission.mode() === "full_access"}>
                        <Icon name="warning" size="small" class="permission-full-access-icon" />
                      </Show>
                      <span class="truncate">{permissionLabel()}</span>
                      <Icon name="chevron-down" size="small" class="shrink-0" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="codex-chat-menu min-w-[320px] [&_[data-slot=dropdown-menu-radio-item]]:items-start [&_[data-slot=dropdown-menu-radio-item]]:py-2 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
                        <DropdownMenu.Group>
                          <DropdownMenu.GroupLabel class="!px-1 !py-1">
                            {language.t("prompt.permission.label")}
                          </DropdownMenu.GroupLabel>
                          <DropdownMenu.RadioGroup
                            class="mt-1"
                            value={permission.mode()}
                            onChange={(value) => {
                              if (value === "ask" || value === "auto_review" || value === "full_access") {
                                if (value === "full_access") confirmFullAccess()
                                else {
                                  setPermissionMenuOpen(false)
                                  void updatePermissionMode(value).catch(() => undefined)
                                }
                              }
                              if (value !== "full_access") restoreFocus()
                            }}
                          >
                            <DropdownMenu.RadioItem value="ask">
                              <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                                <Icon name="hand" size="small" class="text-icon-weak" viewBox="0 0 1024 1024" />
                              </div>
                              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <DropdownMenu.ItemLabel>
                                  {language.t("prompt.permission.default")}
                                </DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemDescription class="whitespace-normal leading-snug">
                                  {language.t("prompt.permission.default.description")}
                                </DropdownMenu.ItemDescription>
                              </div>
                              <DropdownMenu.ItemIndicator>
                                <Icon name="check-small" size="small" class="text-icon-weak" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                            <DropdownMenu.RadioItem value="auto_review">
                              <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                                <Icon name="circle-check" size="small" class="text-icon-weak" />
                              </div>
                              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <DropdownMenu.ItemLabel>{language.t("prompt.permission.auto")}</DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemDescription class="whitespace-normal leading-snug">
                                  {language.t("prompt.permission.auto.description")}
                                </DropdownMenu.ItemDescription>
                              </div>
                              <DropdownMenu.ItemIndicator>
                                <Icon name="check-small" size="small" class="text-icon-weak" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                            <DropdownMenu.RadioItem value="full_access" data-permission-item="full_access">
                              <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                                <Icon name="warning" size="small" class="text-icon-weak" />
                              </div>
                              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <DropdownMenu.ItemLabel>{language.t("prompt.permission.full")}</DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemDescription class="whitespace-normal leading-snug">
                                  {language.t("prompt.permission.full.description")}
                                </DropdownMenu.ItemDescription>
                              </div>
                              <DropdownMenu.ItemIndicator>
                                <Icon name="check-small" size="small" class="text-icon-weak" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          </DropdownMenu.RadioGroup>
                        </DropdownMenu.Group>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </DockShellForm>
      <Show when={store.mode === "shell"}>
        {/* 仅在 shell 状态条 / 新会话项目选择器需要时渲染托盘；普通对话保持 Codex 输入框完整圆角。 */}
        <DockTray
          attach="top"
          data-variant="codex"
          class="pt-2"
          // 使用 wanlai-theme 的背景 token 并与上方 codex composer 本体同表面，
          // 避免硬编码浅色在暗色/系统主题下割裂成白块。
          style={{
            border: "0",
            background: "var(--composer-bg, var(--background-base))",
          }}
        >
          {/* shell 模式状态条（仅在 shell 模式下渲染） */}
          <Show when={store.mode === "shell"}>
            <div class="px-1.75 pb-2 flex items-center gap-2 min-w-0">
              <div class="h-7 flex items-center gap-1.5 min-w-0 flex-1 px-2 rounded" style={{ ...shell() }}>
                <Icon name="console" />
                <span class="truncate text-13-medium text-text-base">{language.t("prompt.mode.shell")}</span>
                <div class="flex-1" />
                <Button
                  variant="ghost"
                  class="text-text-base"
                  onClick={() => {
                    setStore("mode", "normal")
                  }}
                >
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          </Show>
        </DockTray>
      </Show>
      <PromptLinkPopover
        draft={linkDraft}
        onChange={setLinkDraft}
        onClose={closePromptLinkPopover}
        onOpen={() => {
          const href = linkDraft()?.href
          if (href) platform.openLink(normalizePromptHref(href) ?? href)
          closePromptLinkPopover()
        }}
        onSave={savePromptLink}
        normalizeHref={normalizePromptHref}
        labels={{
          open: language.t("prompt.link.open"),
          editText: language.t("prompt.link.editText"),
          editLink: language.t("prompt.link.editLink"),
          text: language.t("prompt.link.text"),
          url: language.t("prompt.link.url"),
          save: language.t("common.save"),
          remove: language.t("prompt.link.remove"),
          placeholder: "https://example.com",
        }}
      />
    </div>
  )
}
