import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { SessionGoalDock } from "@/pages/session/composer/session-goal-dock"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onNewSessionWorktreeCreate: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  onAbort?: () => void
  activeTurnID?: (sessionID: string) => string | undefined
  onAbortComplete?: (sessionID: string) => void
  working: () => boolean
  onBeforeSubmitExistingSession?: (sessionID: string) => Promise<boolean> | boolean
  followup?: {
    queue: () => boolean
    // steer 与 queue 使用独立判定；item 还能声明自身是否支持引导，slash command 只允许排队。
    steer: () => boolean
    items: { id: string; text: string; canSteer?: boolean; steerDisabledReason?: string }[]
    mode: "queued" | "ready" | "paused" | "failed"
    sending?: string
    suppressSuggestion?: () => boolean
    queueingEnabled: boolean
    edit?: {
      id: string
      prompt: FollowupDraft["prompt"]
      context: FollowupDraft["context"]
      addToChatSnippets?: string[]
    }
    dragging?: string
    onQueue: (draft: FollowupDraft) => void
    onSteer: (draft: FollowupDraft) => void
    onAbort: () => void
    onDragStart: (id: string) => void
    onDragEnd: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onDelete: (id: string) => void
    onQueueingChange: (enabled: boolean) => void
    onReorder: (ids: string[]) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement | undefined) => void
  onGoalEdit: () => void
  onGoalToggleStatus: () => void
  onGoalClear: () => void
  onGoalSubmit: (objective: string, sessionID: string) => void
  onGoalModeToggle: () => void
  onExitGoalMode: () => void
}) {
  const navigate = useNavigate()
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionKey()
  const sync = useSync()

  const handoffPrompt = createMemo(() => getSessionHandoff(route.sessionKey())?.prompt)
  const info = createMemo(() => (route.params.id ? sync.session.get(route.params.id) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  const showComposer = createMemo(() => !props.state.blocked() || child())

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let frame: number | undefined

  const clear = () => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready

    clear()
    if (ready && !route.params.id) {
      // 新建会话没有消息列表要先渲染，输入框立即就位，避免固定 140ms 的可感知延迟
      setStore("ready", true)
      return
    }
    setStore("ready", false)
    if (!ready) return

    // 等两帧（跨过消息列表首帧渲染）即就位，取代原来写死的 140ms：
    // 重会话渲染会自然把 rAF 顺延到首帧 paint 之后，轻会话则不用陪等
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined
        setStore("ready", true)
      })
    })
  })

  onCleanup(clear)

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${route.params.dir}/session/${id}`)
  }

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(store.body, update)
    update()
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "shrink-0 w-full pb-5 flex flex-col justify-center items-center bg-background-base/85 backdrop-blur pointer-events-none": true,
      }}
    >
      <div
        // 布局规则统一在 index.css `[data-slot="session-composer-column"]` 里定义，
        // 与 `session-turn-list` 共用同一条 selector，保证消息列和对话框左右边界永远重合。
        // 用 container query 做窄屏退化，避免 margin 偏移在 panel < 1064px 时把元素挤出右边。
        // max-width 由 CSS 统一钉死为 800px（不分断点），无需在这里再用 Tailwind 类做条件约束。
        data-slot="session-composer-column"
        class="pointer-events-auto w-full"
      >
        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock request={request} onSubmit={props.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={showComposer()}>
          <Show
            when={prompt.ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                {/* 占位框复用真输入框的外壳与排版（同一套 dock-surface CSS），
                    真 PromptInput 下一帧挂载时视觉零跳变，不显示加载文案 */}
                <div data-dock-surface="shell" data-variant="codex" class="w-full mb-2 pointer-events-none">
                  {/* padding-bottom 与真身 PromptInput 的工具栏预留（inset=64px）对齐，多行草稿不跳高 */}
                  <div
                    data-component="prompt-input"
                    class="w-full pl-4 pr-4 pt-3 text-14-regular text-text-weak whitespace-pre-wrap"
                    style={{ "padding-bottom": "64px" }}
                  >
                    {handoffPrompt() ?? (prompt.ready() ? previewPrompt() : "")}
                  </div>
                </div>
              </>
            }
          >
            {/* P2: SessionTodoDock 已迁移到 SessionInfoPanel；保留容器结构便于回滚，待稳定后移除 */}
            <Show when={false}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={route.params.id}
                    todos={props.state.todos()}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              {/* 对齐 Codex：steer 已进入对话时间线，不在输入框上方重复显示状态或空 Dock；这里只展示普通排队消息。 */}
              <Show when={(props.followup?.items.length ?? 0) > 0}>
                <div class="mx-auto w-full max-w-[760px] px-5">
                  <SessionFollowupDock
                    items={props.followup!.items}
                    mode={props.followup!.mode}
                    sending={props.followup!.sending}
                    queueingEnabled={props.followup!.queueingEnabled}
                    activeDraggable={props.followup!.dragging}
                    onDragStart={props.followup!.onDragStart}
                    onDragEnd={props.followup!.onDragEnd}
                    onSend={props.followup!.onSend}
                    onEdit={props.followup!.onEdit}
                    onDelete={props.followup!.onDelete}
                    onQueueingChange={props.followup!.onQueueingChange}
                    onReorder={props.followup!.onReorder}
                  />
                </div>
              </Show>
              <Show
                when={child()}
                fallback={
                  <Show when={!props.state.blocked()}>
                    {/* 复刻 Codex：目标条比输入框窄、内缩留白，贴在输入框上方 */}
                    <Show when={props.state.isGoalModeActive() && props.state.goal()} keyed>
                      {(goal) => (
                        <SessionGoalDock
                          goal={goal}
                          onEdit={props.onGoalEdit}
                          onToggleStatus={props.onGoalToggleStatus}
                          onClear={props.onGoalClear}
                        />
                      )}
                    </Show>
                    <PromptInput
                      ref={props.inputRef}
                      newSessionWorktree={props.newSessionWorktree}
                      onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                      onNewSessionWorktreeCreate={props.onNewSessionWorktreeCreate}
                      edit={props.followup?.edit}
                      onEditLoaded={props.followup?.onEditLoaded}
                      shouldQueue={props.followup?.queue}
                      shouldSteer={props.followup?.steer}
                      workingOverride={props.working}
                      activeTurnID={props.activeTurnID}
                      onAbortComplete={props.onAbortComplete}
                      suppressSuggestion={props.followup?.suppressSuggestion}
                      onBeforeSubmitExistingSession={props.onBeforeSubmitExistingSession}
                      onQueue={props.followup?.onQueue}
                      onSteer={props.followup?.onSteer}
                      onAbort={() => {
                        // 暂停排队项必须早于 session idle，避免停止当前回合时下一条消息在状态缝隙里自动发送。
                        props.followup?.onAbort()
                        props.onAbort?.()
                      }}
                      onSubmit={props.onSubmit}
                      isGoalModeActive={props.state.isGoalModeActive}
                      onGoalSubmit={props.onGoalSubmit}
                      onExitGoalMode={props.onExitGoalMode}
                      onGoalModeToggle={props.onGoalModeToggle}
                    />
                  </Show>
                }
              >
                <div
                  ref={props.inputRef}
                  class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                >
                  <span>{language.t("session.child.promptDisabled")} </span>
                  <Show when={parentID()}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={openParent}
                    >
                      {language.t("session.child.backToParent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
