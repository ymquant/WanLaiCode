import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/context/command"
import { sessionRouteActive } from "@/context/session-active"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { type ImageAttachmentPart, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { findMessageIndexByID } from "@/context/message-order"
import { useTerminal } from "@/context/terminal"
import { destroyBrowserTab, isBrowserTab } from "@/components/session/browser-tab"
import { showToast } from "@opencode-ai/ui/toast"
import { createSessionTabs } from "@/pages/session/helpers"
import { restoreEditorFromUserParts } from "@/utils/prompt"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import { isImageGenerationModel } from "@/components/prompt-input/image-generation"
import { skillCommandPrompt } from "@/components/prompt-input/skill-command"
import { promptEditorText, promptFromEditorText } from "@/components/prompt-input/prompt-editor"
import { promptEditDelta, recordIssueAction } from "@/utils/issue-report-snapshot"
import { sessionTimelinePreview } from "@/components/session-timeline-preview"
import { sessionTitle } from "@/utils/session-title"
import { formatTranscript } from "@/utils/transcript"
import { goalSlashAliasesForLocale, goalSlashForLocale } from "./goal-slash"
import { exportSessionTranscript } from "./session-export"
import { sessionActiveTurnID } from "./followup-queue"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  /** 已按逻辑 turn 聚合并按 revert 水位裁剪的一级用户锚点。 */
  timelineUserMessages: () => UserMessage[]
  jumpToMessage?: (message: UserMessage) => void
  working?: (sessionID: string) => boolean
  focusInput: () => void
  review?: () => boolean
  toggleReviewPanel?: () => void
  enterGoalMode?: () => void
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

const formatTimelineTime = (value: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(value))

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()
  const platform = usePlatform()
  const prompt = usePrompt()
  const sdk = useSDK()
  const settings = useSettings()
  const sync = useSync()
  const terminal = useTerminal()
  const layout = useLayout()
  const navigate = useNavigate()
  const { params, tabs, view } = useSessionLayout()

  const info = () => {
    const id = params.id
    if (!id) return
    return sync.session.get(id)
  }
  const hasReview = () => !!params.id
  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: actions.review,
    hasReview,
  })
  const activeFileTab = tabState.activeFileTab
  const closableTab = tabState.closableTab
  const shown = () =>
    platform.platform !== "desktop" ||
    (import.meta.env.VITE_WANLAICODE_CHANNEL ?? import.meta.env.VITE_OPENCODE_CHANNEL) !== "beta" ||
    settings.general.showFileTree()

  const idle = { type: "idle" as const }
  const status = () => sync.data.session_status[params.id ?? ""] ?? idle
  const messages = () => {
    const id = params.id
    if (!id) return []
    return sync.data.message[id] ?? []
  }
  const userMessages = () => messages().filter((m) => m.role === "user") as UserMessage[]
  const visibleUserMessages = () => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    // revert 可能落在非用户消息或尚未加载的历史页中，因此必须先在完整时间线上定位。
    const index = findMessageIndexByID(messages(), revert)
    // 最新分页窗口缺少锚点时，已加载消息都是被撤销的后缀，不能开放 undo/compact 等操作。
    if (index < 0) return []
    return messages()
      .slice(0, index)
      .filter((message) => message.role === "user") as UserMessage[]
  }

  const loadRevertBoundary = async (sessionID: string, messageID: string) => {
    let index = findMessageIndexByID(messages(), messageID)
    // redo 必须知道真实边界；按页补齐更早历史，不能用当前最新窗口的首条消息猜测。
    while (index < 0 && sync.session.history.more(sessionID)) {
      if (sync.session.history.loading(sessionID)) return -1
      const before = messages().length
      await sync.session.history.loadMore(sessionID)
      if (params.id !== sessionID) return -1
      index = findMessageIndexByID(messages(), messageID)
      if (messages().length <= before) return -1
    }
    return index
  }

  const transcriptMessages = () =>
    messages()
      .filter(
        (message): message is UserMessage | AssistantMessage => message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({ info: message, parts: sync.data.part[message.id] ?? [] }))

  const currentTranscript = () => {
    const session = info()
    if (!session) return
    return formatTranscript(
      {
        id: session.id,
        title: sessionTitle(session.title) || language.t("command.session.new"),
        time: {
          created: session.time.created,
          updated: session.time.updated,
        },
      },
      transcriptMessages(),
      {
        thinking: true,
        toolDetails: true,
        assistantMetadata: true,
        providers: sync.data.provider.all,
      },
    )
  }

  const downloadText = (filename: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.style.display = "none"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const currentImages = () => prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image")

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const modelCommand = withCategory(language.t("command.category.model"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const addonCommand = withCategory(language.t("command.category.addon"))
  const skillCommand = withCategory(language.t("command.category.skill"))
  const agentCommand = withCategory(language.t("command.category.agent"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const isAutoAcceptActive = () => {
    const sessionID = params.id
    if (sessionID) return permission.isAutoAccepting(sessionID, sdk.directory)
    return permission.isAutoAcceptingDirectory(sdk.directory)
  }
  const write = async (value: string) => {
    const body = typeof document === "undefined" ? undefined : document.body
    if (body) {
      const textarea = document.createElement("textarea")
      textarea.value = value
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      textarea.style.pointerEvents = "none"
      body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand("copy")
      body.removeChild(textarea)
      if (copied) return true
    }

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return false
    return clipboard.writeText(value).then(
      () => true,
      () => false,
    )
  }

  const openFile = () => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile onOpenFile={showAllFiles} />)
    })
  }

  const closeTab = () => {
    const tab = closableTab()
    if (!tab) return
    if (isBrowserTab(tab)) {
      destroyBrowserTab(tab)
      tabs().close(tab)
      return
    }
    tabs().close(tab)
  }

  const addSelection = () => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = file.selectedLines(path) as SelectedLineRange | null | undefined
    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  const openTerminal = () => {
    if (terminal.all().length > 0) terminal.new({ force: true })
    view().terminal.open()
  }

  const chooseModel = () => {
    void import("@/components/dialog-select-model").then((x) => {
      dialog.show(() => <x.DialogSelectModel model={local.model} afterMessageID={visibleUserMessages().at(-1)?.id} />)
    })
  }

  const chooseMcp = () => {
    void import("@/components/dialog-select-mcp").then((x) => {
      dialog.show(() => <x.DialogSelectMcp />)
    })
  }

  const showAddons = () => {
    void import("@/components/dialog-select-addon").then((x) => {
      dialog.show(() => <x.DialogSelectAddon />)
    })
  }

  const renameSession = () => {
    const session = info()
    if (!session) return
    void import("@/pages/layout/codex-sidebar/rename-thread-dialog").then((x) => {
      dialog.show(() => (
        <x.RenameThreadDialog
          sessionID={session.id}
          directory={session.directory}
          initial={sessionTitle(session.title) || ""}
        />
      ))
    })
  }

  const chooseSkill = () => {
    void import("@/components/dialog-select-skill").then((x) => {
      dialog.show(() => (
        <x.DialogSelectSkill
          onSelect={(skill) => {
            const next = skillCommandPrompt(skill.name, currentImages(), skill.location)
            prompt.set(next.prompt, next.cursor)
            requestAnimationFrame(focusInput)
          }}
        />
      ))
    })
  }

  const openSkillLibrary = () => navigate("/plugins")

  const editPrompt = () => {
    const current = prompt.current()
    void import("@/components/dialog-prompt-editor").then((x) => {
      dialog.show(() => (
        <x.DialogPromptEditor
          value={promptEditorText(current)}
          onSave={(value) => {
            const next = promptFromEditorText(value, current)
            recordIssueAction("prompt.editor.save", {
              text_length: value.length,
              delta: promptEditDelta(current, next.prompt),
            })
            prompt.set(next.prompt, next.cursor)
            requestAnimationFrame(focusInput)
          }}
        />
      ))
    })
  }

  const showTimeline = () => {
    void import("@/components/dialog-session-timeline").then((x) => {
      // 命令面板只列逻辑 turn 锚点；物理 steer user 仍保留给 undo/redo 等边界操作。
      dialog.show(() => (
        <x.DialogSessionTimeline
          items={() =>
            actions
              .timelineUserMessages()
              .slice()
              .reverse()
              .map((message) => ({
                id: message.id,
                text:
                  sessionTimelinePreview({
                    parts: sync.data.part[message.id] ?? [],
                    directory: sdk.directory,
                    attachmentName: language.t("common.attachment"),
                    addToChatLabel: language.t("session.addToChat.selectionCount.one", { count: 1 }),
                  }) || language.t("dialog.sessionTimeline.untitled"),
                time: formatTimelineTime(message.time.created, language.intl()),
              }))
          }
          onSelect={(item) => {
            const message = actions.timelineUserMessages().find((candidate) => candidate.id === item.id)
            if (!message) return
            actions.jumpToMessage?.(message) ?? setActiveMessage(message)
          }}
        />
      ))
    })
  }

  const toggleTimestamps = () => {
    const enabled = !settings.general.showTimestamps()
    settings.general.setShowTimestamps(enabled)
    showToast({
      title: enabled ? language.t("command.view.timestamps.enabled") : language.t("command.view.timestamps.disabled"),
    })
  }

  const toggleThinking = () => {
    const enabled = !settings.general.showReasoningSummaries()
    settings.general.setShowReasoningSummaries(enabled)
    showToast({
      title: enabled ? language.t("command.view.thinking.enabled") : language.t("command.view.thinking.disabled"),
    })
  }

  const toggleDetails = () => {
    const enabled = !(settings.general.shellToolPartsExpanded() && settings.general.editToolPartsExpanded())
    settings.general.setShellToolPartsExpanded(enabled)
    settings.general.setEditToolPartsExpanded(enabled)
    showToast({
      title: enabled ? language.t("command.view.details.enabled") : language.t("command.view.details.disabled"),
    })
  }

  const toggleAutoAccept = () => {
    const sessionID = params.id
    if (sessionID) permission.toggleAutoAccept(sessionID, sdk.directory)
    else permission.toggleAutoAcceptDirectory(sdk.directory)

    const active = sessionID
      ? permission.isAutoAccepting(sessionID, sdk.directory)
      : permission.isAutoAcceptingDirectory(sdk.directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const undo = async () => {
    const sessionID = params.id
    if (!sessionID) return

    // 缺失 revert 锚点时 visibleUserMessages 为空，先停止操作，避免把分页尾部误当作下一撤销边界。
    const users = visibleUserMessages()
    const message = users.at(-1)
    if (!message) return

    // undo 只在真实运行中才中断；raw session_status 残留时直接 abort 会把已完成错误回合误标成“你停止了”。
    if (actions.working?.(sessionID) ?? status().type !== "idle") {
      // 撤销操作与停止按钮共用当前 turnID，旧页面的迟到请求不能中断后来启动的回合。
      await sdk.client.session.abort({ sessionID, turnID: sessionActiveTurnID(status()) }).catch(() => {})
    }

    await sdk.client.session.revert({ sessionID, messageID: message.id })
    const parts = sync.data.part[message.id]
    if (parts) {
      const restored = restoreEditorFromUserParts(parts, {
        directory: sdk.directory,
        attachmentName: language.t("common.attachment"),
      })
      prompt.set(restored.prompt)
      prompt.addToChat.replace(restored.addToChatSnippets)
    }

    setActiveMessage(users.at(-2))
  }

  const redo = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const revertMessageID = info()?.revert?.messageID
    if (!revertMessageID) return

    // redo 将 revert 边界按完整时间线位置向后推进；锚点不在最新分页时先补齐历史。
    const revertIndex = await loadRevertBoundary(sessionID, revertMessageID)
    if (revertIndex < 0) return
    const all = messages()
    const next = all.slice(revertIndex + 1).find((message): message is UserMessage => message.role === "user")
    if (!next) {
      await sdk.client.session.unrevert({ sessionID })
      prompt.reset()
      setActiveMessage(userMessages().at(-1))
      return
    }

    await sdk.client.session.revert({ sessionID, messageID: next.id })
    // 新边界前最后一条用户消息就是刚恢复到的活动回合，也兼容 partID 锚在 assistant 的情况。
    const nextIndex = findMessageIndexByID(all, next.id)
    setActiveMessage(all.slice(0, nextIndex).findLast((message): message is UserMessage => message.role === "user"))
  }

  const compact = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const current = local.model.current()
    const fallback = local.model
      .list()
      .filter((item) => item.provider.id === "wanlaicode")
      .filter((item) => local.model.visible({ providerID: item.provider.id, modelID: item.id }))
      .find((item) => !isImageGenerationModel({ id: item.id, name: item.name, capabilities: item.capabilities }))
    const model =
      current &&
      current.provider.id !== "opencode" &&
      !isImageGenerationModel({ id: current.id, name: current.name, capabilities: current.capabilities })
        ? current
        : fallback
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: current
          ? language.t("prompt.imageGeneration.toast.compactUnsupported.description")
          : language.t("toast.model.none.description"),
      })
      return
    }

    await sdk.client.session
      .summarize({
        sessionID,
        modelID: model.id,
        providerID: model.provider.id,
      })
      .catch((err) => {
        showToast({
          title: language.t("command.session.compact"),
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        })
      })
  }

  const fork = () => {
    void import("@/components/dialog-fork").then((x) => {
      dialog.show(() => <x.DialogFork />)
    })
  }

  const copyTranscript = async () => {
    const transcript = currentTranscript()
    if (!transcript) return
    if (!(await write(transcript))) {
      showToast({
        title: language.t("command.session.copy.failed"),
        variant: "error",
      })
      return
    }
    showToast({
      title: language.t("command.session.copy.succeeded"),
      variant: "success",
    })
  }

  const exportTranscript = async () => {
    const transcript = currentTranscript()
    const session = info()
    if (!transcript || !session) return
    try {
      const exported = await exportSessionTranscript({
        filename: `session-${session.id.slice(0, 8)}.md`,
        content: transcript,
        save: platform.saveTextFileDialog ? (input) => platform.saveTextFileDialog!(input) : undefined,
        download: downloadText,
      })
      if (!exported) return
      showToast({
        title: language.t("command.session.export.succeeded"),
        variant: "success",
      })
    } catch (error) {
      showToast({
        title: language.t("command.session.export"),
        description: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+n",
      slash: "new",
      slashAliases: ["clear", "新建", "新会话", "新对话", "新會話", "新對話", "清空"],
      onSelect: () => {
        prompt.reset({ dir: params.dir })
        navigate(`/${params.dir}/session`)
      },
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      slashAliases: ["撤销", "復原"],
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      slashAliases: ["重做"],
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      slashAliases: ["summarize", "总结", "總結", "精简", "精簡", "压缩", "壓縮"],
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      slashAliases: ["分叉", "分支"],
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: fork,
    }),
    sessionCommand({
      id: "session.goal",
      title: language.t("command.session.goal"),
      description: language.t("command.session.goal.description"),
      slash: goalSlashForLocale(language.locale()),
      slashAliases: goalSlashAliasesForLocale(language.locale()),
      onSelect: () => actions.enterGoalMode?.(),
    }),
    sessionCommand({
      id: "session.rename",
      title: language.t("command.session.rename"),
      description: language.t("command.session.rename.description"),
      slash: "rename",
      slashAliases: ["重命名", "重新命名"],
      disabled: !params.id,
      onSelect: renameSession,
    }),
    sessionCommand({
      id: "session.copyTranscript",
      title: language.t("command.session.copy"),
      description: language.t("command.session.copy.description"),
      slash: "copy",
      slashAliases: ["复制", "複製"],
      disabled: !params.id,
      onSelect: copyTranscript,
    }),
    sessionCommand({
      id: "session.exportTranscript",
      title: language.t("command.session.export"),
      description: language.t("command.session.export.description"),
      slash: "export",
      slashAliases: ["导出", "導出", "匯出"],
      disabled: !params.id,
      onSelect: exportTranscript,
    }),
    sessionCommand({
      id: "session.timeline",
      title: language.t("command.session.timeline"),
      description: language.t("command.session.timeline.description"),
      slash: "timeline",
      slashAliases: ["时间线", "時間線"],
      disabled: !params.id || actions.timelineUserMessages().length === 0,
      onSelect: showTimeline,
    }),
  ]

  const fileCmds = () => [
    fileCommand({
      id: "file.open",
      title: language.t("command.file.open"),
      description: language.t("palette.search.placeholder"),
      keybind: "mod+k,mod+p",
      slash: "open",
      slashAliases: ["打开", "开启", "開啟"],
      onSelect: openFile,
    }),
    fileCommand({
      id: "tab.close",
      title: language.t("command.tab.close"),
      keybind: "mod+w",
      disabled: !closableTab(),
      onSelect: closeTab,
    }),
  ]

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
    contextCommand({
      id: "prompt.editor",
      title: language.t("command.prompt.editor"),
      description: language.t("command.prompt.editor.description"),
      slash: "editor",
      slashAliases: ["编辑器", "編輯器", "提示词编辑器", "提示詞編輯器"],
      onSelect: editPrompt,
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      slashAliases: ["终端", "终端机", "終端機"],
      onSelect: () => view().terminal.toggle(),
    }),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => actions.toggleReviewPanel?.() ?? view().reviewPanel.toggle(),
    }),
    ...(shown()
      ? [
          viewCommand({
            id: "fileTree.toggle",
            title: language.t("command.fileTree.toggle"),
            keybind: "mod+\\",
            onSelect: () => layout.fileTree.toggle(),
          }),
        ]
      : []),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
    viewCommand({
      id: "view.timestamps",
      title: language.t("command.view.timestamps"),
      description: language.t("command.view.timestamps.description"),
      slash: "timestamps",
      slashAliases: ["toggle-timestamps", "时间戳", "時間戳"],
      onSelect: toggleTimestamps,
    }),
    viewCommand({
      id: "view.thinking",
      title: language.t("command.view.thinking"),
      description: language.t("command.view.thinking.description"),
      slash: "thinking",
      slashAliases: ["toggle-thinking", "思考", "推理", "思考显示", "思考顯示"],
      onSelect: toggleThinking,
    }),
    viewCommand({
      id: "view.details",
      title: language.t("command.view.details"),
      description: language.t("command.view.details.description"),
      slash: "details",
      slashAliases: ["详情", "詳情", "工具详情", "工具詳情"],
      onSelect: toggleDetails,
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: openTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const modelCmds = () => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      slashAliases: ["models", "模型"],
      onSelect: chooseModel,
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      slash: "variants",
      slashAliases: ["思考强度", "思考強度", "强度", "強度"],
      onSelect: () => local.model.variant.cycle(),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      slashAliases: ["mcps"],
      onSelect: chooseMcp,
    }),
  ]

  const addonCmds = () => [
    addonCommand({
      id: "addon.list",
      title: language.t("command.addon.list"),
      description: language.t("command.addon.list.description"),
      slash: "addon",
      slashAliases: ["addons", "插件", "外挂", "外掛"],
      onSelect: showAddons,
    }),
  ]

  const skillCmds = () => [
    skillCommand({
      id: "skill.choose",
      title: language.t("command.skill.choose"),
      description: language.t("command.skill.choose.description"),
      slash: "skill",
      slashAliases: ["skills", "技能", "skill-list", "load-skill"],
      onSelect: chooseSkill,
    }),
    skillCommand({
      id: "skill.library",
      title: language.t("command.skill.library"),
      description: language.t("command.skill.library.description"),
      slash: "skill-library",
      slashAliases: [
        "skill-marketplace",
        "skills-library",
        "open-source-skills",
        "技能库",
        "技能庫",
        "技能市场",
        "技能市場",
      ],
      onSelect: openSkillLibrary,
    }),
  ]

  const agentCmds = () => [
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      slashAliases: ["agents", "智能体", "智能體", "代理", "代理程式"],
      onSelect: () => local.agent.move(1),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      slash: "agent-reverse",
      slashAliases: ["agent-prev", "previous-agent", "上一智能体", "上一智能體", "上一代理", "上一代理程式"],
      onSelect: () => local.agent.move(-1),
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: isAutoAcceptActive()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  // 设置 overlay 激活时返回空命令列表，统一门控全部 session 命令与快捷键。
  command.register("session", () => {
    if (!sessionRouteActive()) return []
    return [
      ...sessionCmds(),
      ...fileCmds(),
      ...contextCmds(),
      ...viewCmds(),
      ...terminalCmds(),
      ...messageCmds(),
      ...modelCmds(),
      ...mcpCmds(),
      ...addonCmds(),
      ...skillCmds(),
      ...agentCmds(),
      ...permissionsCmds(),
    ]
  })
}
