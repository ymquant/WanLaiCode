import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Tabs } from "@opencode-ai/ui/tabs"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"

import { SortableTerminalTab } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { BrowserTabContent, createBrowserTabId, destroyBrowserTab, isBrowserTab } from "@/components/session/browser-tab"
import { PROJECT_FILES_TAB_ID, ProjectFilesTabContent } from "@/components/session/project-files-tab"
import { QuickChatInlinePanel } from "@/components/quick-chat-dock"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useTerminal } from "@/context/terminal"
import { terminalTabLabel, canShellOwnTitle } from "@/pages/session/terminal-label"
import { createSizing, focusTerminalById } from "@/pages/session/helpers"
import { getTerminalHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

export function TerminalPanel() {
  const delays = [120, 240]
  const layout = useLayout()
  const terminal = useTerminal()
  const sdk = useSDK()
  const language = useLanguage()
  const command = useCommand()
  const platform = usePlatform()
  const { view, sessionKey } = useSessionLayout()

  const opened = createMemo(() => view().terminal.opened())
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const close = () => view().terminal.close()
  const bottomSideChatTab = "bottom-side-chat"
  const [bottomActive, setBottomActive] = createSignal<string>()
  const [bottomTabs, setBottomTabs] = createSignal<string[]>([])
  const activeTab = createMemo(() => bottomActive() ?? terminal.active())
  const projectName = createMemo(() => {
    const parts = sdk.directory.split(/[\\/]/)
    return parts[parts.length - 1] ?? sdk.directory
  })
  let root: HTMLDivElement | undefined

  const addBottomTab = (tab: string) => {
    setBottomTabs((current) => (current.includes(tab) ? current : [...current, tab]))
    setBottomActive(tab)
  }

  const closeBottomTab = (tab: string, e?: MouseEvent) => {
    e?.stopPropagation()
    // 与右侧面板一致：关闭浏览器页签时销毁底层 Electron BrowserView，避免泄漏 WebContents/页面进程
    if (isBrowserTab(tab)) destroyBrowserTab(tab)
    // 关闭当前活动页签后按相邻页签 → 最后一个底部页签 → 可用终端计算 fallback
    let closingLast = false
    if (bottomActive() === tab) {
      const current = bottomTabs()
      const idx = Math.max(0, current.indexOf(tab))
      const remaining = current.filter((item) => item !== tab)
      const fallback = remaining.length > 0 ? remaining[Math.min(idx, remaining.length - 1)] : undefined
      setBottomActive(fallback)
      closingLast = remaining.length === 0
    } else {
      closingLast = bottomTabs().length === 1
    }
    setBottomTabs((current) => current.filter((item) => item !== tab))
    // 关闭最后一个底部页签后若终端也为 0 且面板仍打开 → 重置自动创建状态，
    // 避免 autoCreateAttempts 已达上限导致永久空白面板
    if (closingLast && terminal.all().length === 0 && opened()) {
      setStore("autoCreated", false)
      setStore("autoCreateAttempts", 0)
    }
  }

  const selectTab = (tab: string) => {
    if (terminal.all().some((pty) => pty.id === tab)) {
      setBottomActive(undefined)
      terminal.open(tab)
      return
    }
    setBottomActive(tab)
  }

  // 关闭最后一个终端时：若底部还有浏览器/项目文件/Side chat 页签，保留面板并切到其中一个；
  // 否则才收起面板——避免把仍在查看的其他页签一起藏掉
  const handleLastTerminalClosed = () => {
    const remaining = bottomTabs()
    if (remaining.length > 0) {
      setBottomActive(remaining[remaining.length - 1])
      return
    }
    close()
  }

  const bottomTabLabel = (tab: string) => {
    if (tab === PROJECT_FILES_TAB_ID) return language.t("session.browser.browseProjectFiles")
    if (tab === bottomSideChatTab) return language.t("sidebar.global.quickChat")
    if (isBrowserTab(tab)) return language.t("session.browser.openBrowser")
    return tab
  }

  const bottomTabIcon = (tab: string) => {
    if (tab === PROJECT_FILES_TAB_ID) return "folder" as const
    if (tab === bottomSideChatTab) return "bubble-5" as const
    if (isBrowserTab(tab)) return "webpage-icon" as const
    return "bubble-5" as const
  }

  const openTerminalTab = () => {
    setBottomActive(undefined)
    void terminal.new({ force: true })
    view().terminal.open()
  }

  const openBrowserTab = () => addBottomTab(createBrowserTabId())

  const openFilesTab = () => addBottomTab(PROJECT_FILES_TAB_ID)

  const quickChatAvailable = createMemo(() => platform.platform === "desktop" && !!platform.ensureQuickChatDir)
  const openQuickChatTab = () => {
    if (!quickChatAvailable()) return
    addBottomTab(bottomSideChatTab)
  }

  const [store, setStore] = createStore({
    autoCreated: false,
    autoCreateAttempts: 0,
    // 面板从 false→true 的最近一次时间戳；用于「打开后短窗口内不允许 auto-close」
    // 避免存储里残留的过期 PTY 在 mount 时被服务端清理（pty.exited）导致 count 1→0
    // 把面板误关
    openedAt: 0,
    activeDraggable: undefined as string | undefined,
    recovered: {} as Record<string, boolean>,
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })

  // 终端面板恢复窗口期：N ms 内若 PTY 数量瞬间归零，视为 stale 恢复/服务端清理过程，不收起面板。
  // 拉到 5s 是为了覆盖「auto-create 失败 → 新 PTY 又被服务端立刻清理」的场景，避免连环关闭弹出。
  const TERMINAL_RECOVERY_GUARD_MS = 5000
  // 自动创建超时：若 N ms 后仍无终端实例，视为创建失败/被服务端 stale 清理，允许再次尝试
  const TERMINAL_AUTO_CREATE_RETRY_MS = 2500
  // 自动创建最大尝试次数（含首次）。服务端持续异常时不要连续多次重建造成"疯狂闪现"
  const TERMINAL_AUTO_CREATE_MAX_ATTEMPTS = 1

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())

  onMount(() => {
    if (typeof window === "undefined") return

    const sync = () => setStore("view", window.visualViewport?.height ?? window.innerHeight)
    const port = window.visualViewport

    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  // 切换对话/项目时重置 autoCreated/重试计数，让新对话可以重新触发自动创建
  createEffect(
    on(
      sessionKey,
      () => {
        setStore("autoCreated", false)
        setStore("autoCreateAttempts", 0)
      },
      { defer: true },
    ),
  )

  // 切换对话/项目时清空底部非终端页签（浏览器/项目文件/Side chat），避免旧会话内容串到新会话底部面板；
  // 同时销毁已开的浏览器页签释放 Electron BrowserView，并让嵌入式项目文件组件卸载——
  // 下次打开时会以新的 params.id 重建持久化目标，不再写入旧会话存储
  createEffect(
    on(
      sessionKey,
      () => {
        for (const tab of bottomTabs()) {
          if (isBrowserTab(tab)) destroyBrowserTab(tab)
        }
        setBottomTabs([])
        setBottomActive(undefined)
      },
      { defer: true },
    ),
  )

  // 组件卸载时（如离开 Session 页面）销毁所有底部浏览器页签，避免 Electron WebContents 泄漏；
  // DesktopBrowserView 自身的 onCleanup 仅执行 hide 不主动销毁，sessionKey 变化时不会触发此路径
  onCleanup(() => {
    for (const tab of bottomTabs()) {
      if (isBrowserTab(tab)) destroyBrowserTab(tab)
    }
  })

  // 跟踪「面板进入打开状态」的最近时间戳；初次 mount 时 opened 已经是 true 也要写入
  // （否则恢复窗口期 guard 因为 openedAt=0 而失效，stale PTY 退出会立刻把面板关掉）
  createEffect(
    on(opened, (next) => {
      if (next) setStore("openedAt", Date.now())
    }),
  )

  // 一旦 PTY 数量回到 >0，仅重置 autoCreated（让本次创建视为完成）；
  // attempts 计数保留，避免新 PTY 立刻又被服务端清理时陷入「count 0↔1」无限重建
  createEffect(
    on(
      () => terminal.all().length,
      (count) => {
        if (count > 0 && store.autoCreated) {
          setStore("autoCreated", false)
        }
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (!opened()) {
      setStore("autoCreated", false)
      setStore("autoCreateAttempts", 0)
      return
    }

    if (!terminal.ready() || terminal.all().length !== 0 || store.autoCreated) return
    if (store.autoCreateAttempts >= TERMINAL_AUTO_CREATE_MAX_ATTEMPTS) return
    // 底部存在非终端页签（浏览器/项目文件/Side chat）时抑制自动创建：
    // 用户正在查看其他内容或刚刚显式关闭了最后一个终端，不应强行新建终端覆盖当前视图
    if (bottomTabs().length > 0) {
      // pty.exited / 服务端异步清理移除最后 PTY 时，bottomActive 仍为 undefined、
      // terminal.active() 也会变空，此时需显式 fallback 到一个底部页签避免面板空白
      if (!bottomActive() && terminal.all().length === 0) {
        const tabs = bottomTabs()
        if (tabs.length > 0) setBottomActive(tabs[tabs.length - 1])
      }
      return
    }

    setStore("autoCreated", true)
    setStore("autoCreateAttempts", store.autoCreateAttempts + 1)
    terminal.new()

    // 兜底重试：若 N ms 后仍无终端实例，认为本次尝试失败（如服务端 stale 清理或网络异常），
    // 允许下次依赖变更或本次清空 autoCreated 后再次触发；最多尝试 MAX_ATTEMPTS 次
    const retry = window.setTimeout(() => {
      if (terminal.all().length > 0) return
      if (!opened()) return
      setStore("autoCreated", false)
    }, TERMINAL_AUTO_CREATE_RETRY_MS)
    onCleanup(() => window.clearTimeout(retry))
  })

  // 通过全局快捷键/命令面板新建终端时同步清除底部页签选中态，
  // 避免 activeTab 优先 bottomActive 导致新建终端被底部页签遮挡
  createEffect(
    on(
      () => terminal.all().length,
      (count, prev) => {
        if (prev !== undefined && count > prev && bottomActive()) {
          setBottomActive(undefined)
        }
      },
    ),
  )

  createEffect(
    on(
      () => [sessionKey(), terminal.all().length, bottomTabs().length] as const,
      ([key, count, bottomCount], prev) => {
        // 切换对话/项目（sessionKey 变化）时不要自动关闭面板：另一对话的 opened 状态由用户自己控制
        if (prev && prev[0] !== key) return
        const prevCount = prev?.[1]
        if (prevCount === undefined || prevCount <= 0 || count !== 0) return
        // 底部仍有浏览器/项目文件/Side chat 等页签时不要收起面板，保留这些内容可见
        if (bottomCount > 0) {
          // 最后一个终端退出后 activeTab 可能变为 undefined（bottomActive 为空且无终端活跃），
          // 此时 fallback 到最后一个底部页签，避免面板打开但内容区空白
          if (!bottomActive() && terminal.all().length === 0) {
            const tabs = bottomTabs()
            if (tabs.length > 0) setBottomActive(tabs[tabs.length - 1])
          }
          return
        }
        if (!opened()) return
        // 面板刚打开的恢复窗口内（如 stale PTY 被服务端清理）不要把面板收起来；
        // 此时 onConnectError → recoverTerminal 正在 clone 新 PTY，count 会回到 1
        if (store.openedAt && Date.now() - store.openedAt < TERMINAL_RECOVERY_GUARD_MS) return
        close()
      },
    ),
  )

  const focus = (id: string) => {
    focusTerminalById(id)

    const frame = requestAnimationFrame(() => {
      if (!opened()) return
      if (terminal.active() !== id) return
      focusTerminalById(id)
    })

    const timers = delays.map((ms) =>
      window.setTimeout(() => {
        if (!opened()) return
        if (terminal.active() !== id) return
        focusTerminalById(id)
      }, ms),
    )

    return () => {
      cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
    }
  }

  createEffect(
    on(
      () => [opened(), terminal.active()] as const,
      ([next, id]) => {
        if (!next || !id) return
        const stop = focus(id)
        onCleanup(stop)
      },
    ),
  )

  createEffect(() => {
    if (opened()) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    if (!root?.contains(active)) return
    active.blur()
  })

  createEffect(() => {
    const key = sessionKey()
    if (!key) return
    if (!terminal.ready()) return
    language.locale()

    setTerminalHandoff(
      key,
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          projectName: projectName(),
          shellOwnsTitle: pty.shellOwnsTitle,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  const handoff = createMemo(() => {
    const key = sessionKey()
    if (!key) return []
    return getTerminalHandoff(key) ?? []
  })

  const all = terminal.all
  const ids = createMemo(() => all().map((pty) => pty.id))

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key]) return
    setStore("recovered", key, true)
    void clone(id)
  }

  const terminalRecoveryKey = (pty: { id: string; title: string; titleNumber: number }) => {
    return String(pty.titleNumber || pty.title || pty.id)
  }

  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    trim(id)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const terminals = terminal.all()
    const fromIndex = terminals.findIndex((t) => t.id === draggable.id.toString())
    const toIndex = terminals.findIndex((t) => t.id === droppable.id.toString())
    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      terminal.move(draggable.id.toString(), toIndex)
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeDraggable", undefined)

    const activeId = terminal.active()
    if (!activeId) return
    requestAnimationFrame(() => {
      if (terminal.active() !== activeId) return
      focusTerminalById(activeId)
    })
  }

  return (
    <div
      ref={root}
      id="terminal-panel"
      role="region"
      aria-label={language.t("terminal.title")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative w-full shrink-0 overflow-hidden bg-background-stronger"
      classList={{
        "border-t border-border-weak-base": opened(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !size.active(),
      }}
      style={{ height: opened() ? `${pane()}px` : "0px" }}
    >
      <div
        class="absolute inset-x-0 top-0 flex flex-col"
        classList={{
          "pointer-events-none": !opened(),
        }}
        style={{ height: `${pane()}px` }}
      >
        <div class="hidden md:block">
          <ResizeHandle
            direction="vertical"
            size={pane()}
            min={100}
            max={max()}
            collapseThreshold={50}
            onResizeStart={() => size.start()}
            onResize={(next) => {
              size.touch()
              layout.terminal.resize(next)
            }}
            onCollapse={close}
          />
        </div>
        <Show
          when={terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weaker-base bg-background-stronger overflow-hidden">
                <For each={handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">{language.t("terminal.loading")}</div>
            </div>
          }
        >
          <DragDropProvider
            onDragStart={handleTerminalDragStart}
            onDragEnd={handleTerminalDragEnd}
            onDragOver={handleTerminalDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <div class="flex flex-col h-full">
              <Tabs
                variant="alt"
                data-scope="terminal"
                value={activeTab()}
                onChange={selectTab}
                class="min-h-0 flex-1"
              >
                <Tabs.List class="h-12 border-b border-border-weaker-base flex items-center">
                  <SortableProvider ids={ids()}>
                    <For each={all()}>
                      {(pty) => <SortableTerminalTab terminal={pty} projectName={projectName()} onClose={handleLastTerminalClosed} active={activeTab() === pty.id} />}
                    </For>
                  </SortableProvider>
                  <For each={bottomTabs()}>
                    {(tab) => (
                      <div class="h-full flex items-center">
                        <Tabs.Trigger
                          value={tab}
                          hideCloseButton
                          closeButton={
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              class="review-tab-close p-0"
                              onClick={(e) => closeBottomTab(tab, e)}
                              aria-label={language.t("common.closeTab")}
                            />
                          }
                          onMiddleClick={() => closeBottomTab(tab)}
                          class="!shadow-none"
                          classes={{
                            button:
                              "border-0 outline-none focus:outline-none focus-visible:outline-none !shadow-none !ring-0",
                          }}
                        >
                          <Icon name={bottomTabIcon(tab)} size="small" class="size-4 shrink-0 text-icon-weak" />
                          <span class="min-w-0 truncate text-14-medium">{bottomTabLabel(tab)}</span>
                        </Tabs.Trigger>
                      </div>
                    )}
                  </For>
                  <div class="h-full flex items-center justify-center pl-2 pr-3">
                    <DropdownMenu placement="bottom-start" gutter={6}>
                      <TooltipKeybind
                        title={language.t("command.terminal.new")}
                        keybind={command.keybind("terminal.new")}
                        class="flex items-center"
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          aria-label={language.t("command.terminal.new")}
                        />
                      </TooltipKeybind>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class="codex-chat-menu min-w-64">
                          <DropdownMenu.Item onSelect={openTerminalTab}>
                            <Icon name="terminal" size="small" class="text-text-base" />
                            <DropdownMenu.ItemLabel class="flex-1">{language.t("terminal.title")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onSelect={openBrowserTab}>
                            <Icon name="webpage-icon" size="small" class="text-text-base" />
                            <DropdownMenu.ItemLabel class="flex-1">{language.t("session.browser.openBrowser")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onSelect={openFilesTab}>
                            <Icon name="folder" size="small" class="text-text-base" />
                            <DropdownMenu.ItemLabel class="flex-1">
                              {language.t("session.browser.browseProjectFiles")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onSelect={openQuickChatTab} disabled={!quickChatAvailable()}>
                            <Icon name="bubble-5" size="small" class="text-text-base" />
                            <DropdownMenu.ItemLabel class="flex-1">{language.t("sidebar.global.quickChat")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  </div>
                  <div class="ml-auto h-full flex items-center pr-2">
                    <IconButton
                      icon="close-small"
                      variant="ghost"
                      iconSize="large"
                      onClick={close}
                      aria-label={language.t("terminal.panel.close")}
                    />
                  </div>
                </Tabs.List>
              <div class="flex-1 min-h-0 relative">
                <Show when={!bottomActive() && terminal.active()} keyed>
                  {(id) => {
                    const ops = terminal.bind()
                    return (
                      <Show when={all().find((pty) => pty.id === id)}>
                        {(pty) => (
                          <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                            <Terminal
                              pty={pty()}
                              autoFocus={opened()}
                              onConnect={() => markTerminalConnected(terminalRecoveryKey(pty()), id, ops.trim)}
                              onCleanup={ops.update}
                              onConnectError={() => recoverTerminal(terminalRecoveryKey(pty()), id, ops.clone)}
                              onTitle={(title) => {
                                if (!canShellOwnTitle(pty())) return
                                terminal.update({ id, title })
                              }}
                            />
                          </div>
                        )}
                      </Show>
                    )
                  }}
                </Show>
                <Show when={bottomTabs().includes(PROJECT_FILES_TAB_ID)}>
                  <ProjectFilesTabContent tab={PROJECT_FILES_TAB_ID} active={bottomActive() === PROJECT_FILES_TAB_ID} embedded />
                </Show>
                <Show when={bottomTabs().includes(bottomSideChatTab)}>
                  <Tabs.Content
                    value={bottomSideChatTab}
                    forceMount
                    class="flex flex-col h-full overflow-hidden contain-strict p-2"
                    style={{ display: bottomActive() !== bottomSideChatTab ? "none" : undefined }}
                    aria-hidden={bottomActive() !== bottomSideChatTab}
                    inert={bottomActive() !== bottomSideChatTab}
                  >
                    <QuickChatInlinePanel />
                  </Tabs.Content>
                </Show>
                <For each={bottomTabs().filter((tab) => isBrowserTab(tab))}>
                  {(tab) => <BrowserTabContent tab={tab} active={bottomActive() === tab} />}
                </For>
              </div>
              </Tabs>
            </div>
            <DragOverlay>
              <Show when={store.activeDraggable} keyed>
                {(id) => (
                  <Show when={all().find((pty) => pty.id === id)}>
                    {(t) => (
                      <div class="relative p-1 h-10 flex items-center bg-background-stronger text-14-regular">
                        {terminalTabLabel({
                          title: t().title,
                          titleNumber: t().titleNumber,
                          projectName: projectName(),
                          shellOwnsTitle: t().shellOwnsTitle,
                          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
                        })}
                      </div>
                    )}
                  </Show>
                )}
              </Show>
            </DragOverlay>
          </DragDropProvider>
        </Show>
      </div>
    </div>
  )
}
