import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocation } from "@solidjs/router"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { SDKProvider, useSDK } from "@/context/sdk"
import { sessionTitle } from "@/utils/session-title"
import {
  QUICK_CHAT_OPEN_EVENT,
  attachQuickChatToTask,
  quickChatModelContext,
  quickChatModelSelection,
  quickChatTranscript,
  resolveQuickChatModelSelection,
} from "@/utils/quick-chat"

type DockSize = { width: number; height: number }
type ResizeAxis = "width" | "height" | "both"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const QUICK_CHAT_EDGE_GAP = 8
const QUICK_CHAT_WINDOWS_TOP_GAP = 84

const QuickChatFrame = (props: {
  children: JSX.Element
  size: Accessor<DockSize>
  setSize: Setter<DockSize>
  topInset: number
  rightInset: number
  inline?: boolean
}) => {
  let cancelResize: (() => void) | undefined

  const startResize = (axis: ResizeAxis, event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const frame = event.currentTarget.parentElement
    if (!frame) return
    event.preventDefault()
    event.stopPropagation()
    cancelResize?.()

    const target = event.currentTarget
    const rect = frame.getBoundingClientRect()
    const pointer = { x: event.clientX, y: event.clientY, id: event.pointerId }
    const move = (next: PointerEvent) => {
      const maxWidth = Math.max(280, window.innerWidth - props.rightInset - QUICK_CHAT_EDGE_GAP)
      const maxHeight = Math.max(280, window.innerHeight - props.topInset - QUICK_CHAT_EDGE_GAP)
      props.setSize({
        width:
          axis === "height" ? rect.width : clamp(rect.width + pointer.x - next.clientX, Math.min(380, maxWidth), maxWidth),
        height:
          axis === "width"
            ? rect.height
            : clamp(rect.height + pointer.y - next.clientY, Math.min(420, maxHeight), maxHeight),
      })
    }
    const stop = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", stop)
      target.removeEventListener("pointercancel", stop)
      if (target.hasPointerCapture(pointer.id)) target.releasePointerCapture(pointer.id)
      cancelResize = undefined
    }

    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", stop)
    target.addEventListener("pointercancel", stop)
    target.setPointerCapture(pointer.id)
    cancelResize = stop
  }

  onCleanup(() => cancelResize?.())

  return (
    <section
      data-component="quick-chat-dock"
      class={props.inline ? "relative flex h-full min-h-0 flex-col overflow-hidden rounded-[8px] border border-border-weak-base bg-background-base" : "fixed z-[220] flex flex-col overflow-hidden rounded-[8px] border border-border-weak-base bg-background-base shadow-2xl"}
      style={
        props.inline
          ? undefined
          : {
              top: `${props.topInset}px`,
              right: `${props.rightInset}px`,
              width: `${props.size().width}px`,
              height: `min(${props.size().height}px, calc(100vh - ${props.topInset + QUICK_CHAT_EDGE_GAP}px))`,
              "max-width": `calc(100vw - ${props.rightInset + QUICK_CHAT_EDGE_GAP}px)`,
              "max-height": `calc(100vh - ${props.topInset + QUICK_CHAT_EDGE_GAP}px)`,
            }
      }
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Show when={!props.inline}>
        <div
          data-resize-handle="top-left"
          class="absolute left-0 top-0 z-30 size-3 cursor-nwse-resize touch-none"
          aria-hidden="true"
          onPointerDown={(event) => startResize("both", event)}
        />
        <div
          data-resize-handle="top"
          class="absolute left-3 right-3 top-0 z-20 h-1.5 cursor-ns-resize touch-none"
          aria-hidden="true"
          onPointerDown={(event) => startResize("height", event)}
        />
        <div
          data-resize-handle="left"
          class="absolute bottom-3 left-0 top-3 z-20 w-1.5 cursor-ew-resize touch-none"
          aria-hidden="true"
          onPointerDown={(event) => startResize("width", event)}
        />
      </Show>
      {props.children}
    </section>
  )
}

export function QuickChatDock() {
  const platform = usePlatform()
  const [opened, setOpened] = createSignal(false)
  const [selectedID, setSelectedID] = createSignal<string>()
  const [size, setSize] = createSignal({ width: 560, height: 720 })
  const topInset = createMemo(() =>
    platform.platform === "desktop" && platform.os === "windows" ? QUICK_CHAT_WINDOWS_TOP_GAP : QUICK_CHAT_EDGE_GAP,
  )

  const open = (event: Event) => {
    if (platform.platform !== "desktop") return
    if (!(event instanceof CustomEvent)) return
    const id =
      event.detail && typeof event.detail === "object" && "id" in event.detail && typeof event.detail.id === "string"
        ? event.detail.id
        : undefined
    if (!id && opened()) {
      setOpened(false)
      return
    }
    setSelectedID(id)
    setOpened(true)
  }
  window.addEventListener(QUICK_CHAT_OPEN_EVENT, open)
  onCleanup(() => window.removeEventListener(QUICK_CHAT_OPEN_EVENT, open))

  const [directory] = createResource(
    () => opened() && !!platform.ensureQuickChatDir,
    async () => {
      return platform
        .ensureQuickChatDir?.()
        .catch((error: unknown) => {
          setOpened(false)
          showToast({
            variant: "error",
            title: error instanceof Error ? error.message : String(error),
          })
          return undefined
        })
    },
  )

  return (
    <Show when={opened()}>
      <Show
        when={directory()}
        keyed
        fallback={
          <QuickChatFrame size={size} setSize={setSize} topInset={topInset()} rightInset={QUICK_CHAT_EDGE_GAP}>
            <div class="flex flex-1 items-center justify-center text-text-weak">
              <Spinner />
            </div>
          </QuickChatFrame>
        }
      >
        {(dir) => (
          <SDKProvider directory={() => dir}>
            <QuickChatPanel
              selectedID={selectedID}
              setSelectedID={setSelectedID}
              onMinimize={() => setOpened(false)}
              size={size}
              setSize={setSize}
              topInset={topInset}
              rightInset={() => QUICK_CHAT_EDGE_GAP}
            />
          </SDKProvider>
        )}
      </Show>
    </Show>
  )
}

const visibleText = (parts: readonly Part[] | undefined) =>
  (parts ?? [])
    .flatMap((part) => {
      if (part.type !== "text") return []
      if (part.synthetic || part.ignored || !part.text.trim()) return []
      return [part.text.trim()]
    })
    .join("\n")

const displayTitle = (session: Session | undefined, fallback: string) => {
  const title = sessionTitle(session?.title ?? "")
  if (!title || title === "New session") return fallback
  return title
}

type QuickChatMessage = {
  info: Message
  parts: Part[]
}

function QuickChatPanel(props: {
  selectedID: () => string | undefined
  setSelectedID: (id: string | undefined) => void
  onMinimize: () => void
  size: Accessor<DockSize>
  setSize: Setter<DockSize>
  topInset: Accessor<number>
  rightInset: Accessor<number>
  inline?: boolean
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const models = useModels()
  const platform = usePlatform()
  const location = useLocation()
  const [draft, setDraft] = createSignal("")
  const [pendingText, setPendingText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [loadingMessages, setLoadingMessages] = createSignal(false)
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [messages, setMessages] = createSignal<QuickChatMessage[]>([])
  let messageScroll: HTMLDivElement | undefined
  let composer: HTMLTextAreaElement | undefined
  let disabledTools: Record<string, boolean> | undefined
  let loadVersion = 0

  const upsertSession = (session: Session) => {
    setSessions((sessions) =>
      [...sessions.filter((item) => item.id !== session.id), session].toSorted((a, b) => a.id.localeCompare(b.id)),
    )
  }

  const [sessionsReady] = createResource(() =>
    // Project-scoped loading would leak project/automation sessions into this isolated chat directory.
    sdk.client.session
      .list({ roots: true })
      .then((response) => {
        setSessions(
          (response.data ?? [])
            .filter((session) => !session.parentID && !session.time.archived)
            .toSorted((a, b) => a.id.localeCompare(b.id)),
        )
        return true
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("quickChat.error.load"),
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      }),
  )

  const recentSessions = createMemo(() =>
    sessions()
      .filter((session) => !session.parentID && !session.time.archived)
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  const current = createMemo(() => recentSessions().find((session) => session.id === props.selectedID()))
  const rows = createMemo(() => {
    const loaded = messages().flatMap((message) => {
      if (message.info.role !== "user" && message.info.role !== "assistant") return []
      const text = visibleText(message.parts)
      if (!text) return []
      return [{ id: message.info.id, role: message.info.role, text }]
    })
    if (!pendingText()) return loaded
    return [...loaded, { id: "pending", role: "user" as const, text: pendingText() }]
  })
  const taskAvailable = createMemo(() => /\/session(?:\/|$)/.test(location.pathname))
  const transcript = createMemo(() =>
    quickChatTranscript({
      messages: messages().map((message) => message.info),
      partsByMessage: Object.fromEntries(messages().map((message) => [message.info.id, message.parts])),
    }),
  )

  const modelSelection = () =>
    resolveQuickChatModelSelection({
      snapshot: quickChatModelSelection(),
      recent: models.recent.list().map((model) => ({
        providerID: model.providerID,
        modelID: model.modelID,
        variant: models.variant.get(model),
      })),
      valid: (model) => !!models.find(model),
    })

  const tools = async () => {
    if (disabledTools) return disabledTools
    const response = await sdk.client.tool.ids()
    if (!response.data) throw new Error(language.t("quickChat.error.send"))
    disabledTools = Object.fromEntries(response.data.map((id) => [id, false]))
    return disabledTools
  }

  const loadConversation = (id: string) => {
    const version = ++loadVersion
    setLoadingMessages(true)
    return Promise.all([
      sdk.client.session.get({ sessionID: id }),
      // 快速聊天只消费文本转录，超大文件 patch 必须留在审核入口按需读取。
      sdk.client.session.messages({ sessionID: id, limit: 200, summaryDiffs: "compact" }),
    ])
      .then(([session, messages]) => {
        if (version !== loadVersion) return
        if (session.data) upsertSession(session.data)
        setMessages((messages.data ?? []).filter((message) => !!message?.info?.id))
      })
      .catch((error: unknown) => {
        if (version !== loadVersion) return
        showToast({
          variant: "error",
          title: language.t("quickChat.error.load"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        if (version === loadVersion) setLoadingMessages(false)
      })
  }

  createEffect(() => {
    const id = props.selectedID()
    if (id) {
      void loadConversation(id)
      return
    }
    loadVersion += 1
    setMessages([])
    setLoadingMessages(false)
  })

  createEffect(() => {
    void rows()
    void loadingMessages()
    queueMicrotask(() => {
      if (!messageScroll) return
      messageScroll.scrollTop = messageScroll.scrollHeight
    })
  })

  const resizeComposer = () => {
    if (!composer) return
    composer.style.height = "0px"
    composer.style.height = `${Math.min(144, Math.max(24, composer.scrollHeight))}px`
  }

  const startNew = () => {
    props.setSelectedID(undefined)
    setDraft("")
    queueMicrotask(() => composer?.focus())
  }

  const send = async () => {
    const text = draft().trim()
    if (!text || sending()) return
    setSending(true)
    setPendingText(text)
    setDraft("")
    queueMicrotask(resizeComposer)
    try {
      const selection = modelSelection()
      if (!selection) throw new Error(language.t("prompt.toast.modelAgentRequired.description"))
      const context = quickChatModelContext(selection)
      const sessionID =
        props.selectedID() ??
        (await sdk.client.session.create(context.create).then((response) => {
          const session = response.data
          if (!session) throw new Error(language.t("quickChat.error.create"))
          upsertSession(session)
          props.setSelectedID(session.id)
          return session.id
        }))
      if (!sessionID) throw new Error(language.t("quickChat.error.create"))
      await sdk.client.session.prompt({
        sessionID,
        ...context.prompt,
        language: language.locale(),
        system:
          "You are a conversational assistant in a quick chat panel. Answer directly. Do not use tools, modify files, or perform actions.",
        tools: await tools(),
        parts: [{ type: "text", text }],
      })
      await loadConversation(sessionID)
      setPendingText("")
      queueMicrotask(() => {
        resizeComposer()
        composer?.focus()
      })
    } catch (error) {
      setPendingText("")
      setDraft(text)
      queueMicrotask(resizeComposer)
      showToast({
        variant: "error",
        title: language.t("quickChat.error.send"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSending(false)
    }
  }

  const addToTask = () => {
    const id = props.selectedID()
    const body = transcript()
    if (!id || !body || !taskAvailable()) return
    const result = attachQuickChatToTask({
      id,
      title: displayTitle(current(), language.t("quickChat.new")),
      transcript: body,
    })
    // unhandled：输入框此刻没接事件（子会话、权限/提问阻塞、prompt 未 ready），
    // 引用并没有插进去，必须报错而不是提示成功
    if (result === "unhandled") {
      showToast({ variant: "error", title: language.t("quickChat.attachFailed") })
      return
    }
    showToast({ title: language.t(result === "added" ? "quickChat.added" : "quickChat.alreadyAdded") })
  }

  const headerTitle = createMemo(() => displayTitle(current(), language.t("quickChat.new")))

  return (
    <QuickChatFrame
      size={props.size}
      setSize={props.setSize}
      topInset={props.topInset()}
      rightInset={props.rightInset()}
      inline={props.inline}
    >
      <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border-weaker-base px-4">
        <div class="min-w-0 flex-1 truncate text-15-medium text-text-strong">{headerTitle()}</div>
        <Show when={props.selectedID()}>
          <Tooltip value={language.t("quickChat.new")} placement="bottom">
            <IconButton
              icon="plus"
              size="normal"
              variant="ghost"
              class="size-8"
              aria-label={language.t("quickChat.new")}
              onClick={startNew}
            />
          </Tooltip>
          <Button
            icon="prompt"
            variant="secondary"
            class="h-8 px-2.5"
            disabled={!taskAvailable() || !transcript()}
            onClick={addToTask}
          >
            {language.t("quickChat.addToTask")}
          </Button>
        </Show>
        <Show when={!props.inline}>
          <Tooltip value={language.t("quickChat.minimize")} placement="bottom">
            <button
              type="button"
              class="inline-flex size-8 items-center justify-center rounded-md text-icon-base hover:bg-button-ghost-hover hover:text-icon-strong"
              aria-label={language.t("quickChat.minimize")}
              onClick={props.onMinimize}
            >
              <span class="h-px w-4 bg-current" aria-hidden="true" />
            </button>
          </Tooltip>
        </Show>
      </header>

      <div ref={messageScroll} class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Show
          when={props.selectedID()}
          fallback={
            <div class="flex min-h-full flex-col justify-end pb-3">
              <Show
                when={!sessionsReady.loading}
                fallback={
                  <div class="flex flex-1 items-center justify-center text-text-weak">
                    <Spinner />
                  </div>
                }
              >
                <Show
                  when={recentSessions().length > 0}
                  fallback={
                    <div class="flex flex-1 items-center justify-center text-14-regular text-text-weak">
                      {language.t("quickChat.empty")}
                    </div>
                  }
                >
                  <div class="mb-2 text-13-regular text-text-weak">{language.t("quickChat.recent")}</div>
                  <div class="flex flex-col gap-0.5">
                    <For each={recentSessions().slice(0, 6)}>
                      {(session) => (
                        <button
                          type="button"
                          class="flex h-9 items-center gap-3 rounded-md px-2 text-left hover:bg-button-ghost-hover"
                          onClick={() => props.setSelectedID(session.id)}
                        >
                          <span class="min-w-0 flex-1 truncate text-14-regular text-text-base">
                            {displayTitle(session, language.t("quickChat.new"))}
                          </span>
                          <span class="shrink-0 text-12-regular text-text-weak">
                            {new Intl.DateTimeFormat(language.locale(), { month: "short", day: "numeric" }).format(
                              session.time.updated,
                            )}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          }
        >
          <div class="flex min-h-full flex-col justify-end gap-4">
            <For each={rows()}>
              {(row) => (
                <div
                  classList={{
                    "max-w-[88%] whitespace-pre-wrap break-words text-14-regular leading-6": true,
                    "ml-auto rounded-[6px] border border-border-weaker-base bg-surface-base px-3 py-2 text-text-strong":
                      row.role === "user",
                    "mr-auto text-text-base": row.role === "assistant",
                  }}
                >
                  <Show when={row.role === "assistant"} fallback={row.text}>
                    <Markdown text={row.text} openExternalLink={(url) => platform.openLink(url)} />
                  </Show>
                </div>
              )}
            </For>
            <Show when={sending() || loadingMessages()}>
              <div class="flex items-center gap-2 text-13-regular text-text-weak">
                <Spinner />
                <span>{language.t("quickChat.thinking")}</span>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <form
        class="m-3 mt-0 flex shrink-0 items-end gap-2 rounded-[8px] border border-border-weak-base bg-background-stronger px-3 py-2 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={composer}
          value={draft()}
          disabled={sending()}
          rows={1}
          class="min-h-6 max-h-36 flex-1 resize-none bg-transparent py-1 text-14-regular text-text-strong outline-none placeholder:text-text-weaker"
          placeholder={language.t("quickChat.placeholder")}
          onInput={(event) => {
            setDraft(event.currentTarget.value)
            resizeComposer()
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
            event.preventDefault()
            void send()
          }}
        />
        <IconButton
          type="submit"
          icon="arrow-up"
          variant="primary"
          size="large"
          class="size-9 shrink-0 rounded-full"
          disabled={!draft().trim() || sending()}
          aria-label={language.t("quickChat.send")}
        />
      </form>
    </QuickChatFrame>
  )
}

export function QuickChatInlinePanel() {
  const platform = usePlatform()
  const language = useLanguage()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [size, setSize] = createSignal({ width: 560, height: 720 })
  const topInset = createMemo(() => 0)
  const rightInset = createMemo(() => 0)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const supported = createMemo(() => platform.platform === "desktop" && !!platform.ensureQuickChatDir)

  const [directory] = createResource(
    supported,
    async (enabled) => {
      if (!enabled) return undefined
      setLoadFailed(false)
      return platform.ensureQuickChatDir?.().catch((error: unknown) => {
        setLoadFailed(true)
        showToast({
          variant: "error",
          title: language.t("quickChat.error.load"),
          description: error instanceof Error ? error.message : String(error),
        })
        return undefined
      })
    },
  )

  return (
    <Show
      when={supported()}
      fallback={
        <div class="flex h-full items-center justify-center text-text-weak">
          {language.t("quickChat.error.load")}
        </div>
      }
    >
      <Show
        when={!loadFailed()}
        fallback={
          <div class="flex h-full items-center justify-center text-text-weak">
            {language.t("quickChat.error.load")}
          </div>
        }
      >
        <Show
          when={directory()}
          keyed
          fallback={
            <div class="flex h-full items-center justify-center text-text-weak">
              <Spinner />
            </div>
          }
        >
          {(dir) => (
            <SDKProvider directory={() => dir}>
              <QuickChatPanel
                selectedID={selectedID}
                setSelectedID={setSelectedID}
                onMinimize={() => setSelectedID(undefined)}
                size={size}
                setSize={setSize}
                topInset={topInset}
                rightInset={rightInset}
                inline
              />
            </SDKProvider>
          )}
        </Show>
      </Show>
    </Show>
  )
}
