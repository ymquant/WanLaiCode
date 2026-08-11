import { createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useAutomationSessions } from "@/context/automation-sessions"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { AutomationTemplatesDialog } from "./templates-dialog"
import { AutomationEditorDialog } from "./editor-dialog"
import { CdxConfirm } from "./codex-ui"
import { CdxIcon, type CdxIconName } from "./cdx-icons"
import { nextRunLabel, projectName } from "./format"
import { runSessionPath } from "./run-target"
import { coerceSchedule, scheduleSummary } from "./schedule"
import type { AutomationTemplate } from "./templates"
import "./codex.css"

const SUGGESTIONS = [
  {
    titleKey: "automation.template.dailyBrief",
    descriptionKey: "automation.suggestion.dailyBrief.description",
    icon: "bell",
    tone: "blue",
  },
  {
    titleKey: "automation.template.weeklyReview",
    descriptionKey: "automation.suggestion.weeklyReview.description",
    icon: "notebook",
    tone: "purple",
  },
  {
    titleKey: "automation.template.projectMonitor",
    descriptionKey: "automation.suggestion.projectMonitor.description",
    icon: "docSearch",
    tone: "green",
  },
] as const satisfies ReadonlyArray<{
  titleKey: string
  descriptionKey: string
  icon: CdxIconName
  tone: "blue" | "purple" | "green"
}>

type TemplateID = "daily_brief" | "weekly_review" | "project_monitor"

const TEMPLATE_PRESETS: Record<
  TemplateID,
  {
    titleKey: string
    template: TemplateID
    scheduleKind: "daily" | "weekly"
    scheduleConfig: { time: string } | { weekday: number; time: string }
    prompt: string
  }
> = {
  daily_brief: {
    titleKey: "automation.template.dailyBrief",
    template: "daily_brief",
    scheduleKind: "daily",
    scheduleConfig: { time: "09:00" },
    prompt: "汇总今天的工作进展与待办,生成一份简报。",
  },
  weekly_review: {
    titleKey: "automation.template.weeklyReview",
    template: "weekly_review",
    scheduleKind: "weekly",
    scheduleConfig: { weekday: 1, time: "09:00" },
    prompt: "回顾过去一周的进展,总结成果与下周计划。",
  },
  project_monitor: {
    titleKey: "automation.template.projectMonitor",
    template: "project_monitor",
    scheduleKind: "daily",
    scheduleConfig: { time: "08:00" },
    prompt: "检查项目当前状态并报告异常。",
  },
}

const TEMPLATE_BY_KEY: Record<string, TemplateID> = {
  "automation.template.dailyBrief": "daily_brief",
  "automation.template.weeklyReview": "weekly_review",
  "automation.template.projectMonitor": "project_monitor",
}

// 列表行/编辑所需的结构化子集(SDK 列表项是其超集)
export type AutomationInfo = {
  id: string
  title: string
  enabled: boolean
  prompt: string
  scheduleConfig: unknown
  directory: string | null
  projectID: string | null
  nextRunAt: number | string | null
}

export default function AutomationPage() {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const automationSessions = useAutomationSessions()
  const dialog = useDialog()
  const navigate = useNavigate()
  const layout = useLayout()

  const [automations, { refetch }] = createResource(async () => {
    const res = await globalSDK.client.automation.list()
    if (res.error) {
      showToast({ title: language.t("automation.toast.loadFailed") })
      return []
    }
    return res.data ?? []
  })

  // 自动化的增删改都会改变根级 provider 持有的目录集合(侧栏「自动化」区据此发现
  // 不属于任何项目的隐藏目录),本页资源与 provider 必须一起刷新,
  // 否则侧栏要等 provider 那条 60s 兜底轮询才跟得上。
  async function refresh() {
    await refetch()
    automationSessions?.refetch()
  }

  function openEditor(template?: AutomationTemplate) {
    dialog.show(() => (
      <AutomationEditorDialog template={template} onCreated={() => refresh()} onUseTemplate={openTemplates} />
    ))
  }

  // 模板库:主页"查看模板"与编辑器"使用模板"共用;选中模板后打开编辑器预填
  function openTemplates() {
    dialog.show(() => <AutomationTemplatesDialog onPick={(t) => openEditor(t)} />)
  }

  function openEditorFromPresetKey(templateKey: string) {
    const id = TEMPLATE_BY_KEY[templateKey]
    if (!id) return
    const preset = TEMPLATE_PRESETS[id]
    openEditor({
      id,
      emoji: "",
      title: language.t(preset.titleKey),
      scheduleKind: preset.scheduleKind,
      scheduleConfig: preset.scheduleConfig,
      prompt: preset.prompt,
    })
  }

  async function toggle(automationID: string, enabled: boolean) {
    const res = await globalSDK.client.automation.toggle({ automationID, enabled })
    if (res.error) {
      showToast({ title: language.t("automation.toast.updateFailed") })
      return
    }
    await refresh()
  }

  // 一键把所有自动化的未读运行标为已读
  async function markAllRead() {
    try {
      await globalSDK.client.automation.readAll({})
    } finally {
      automationSessions?.refetch()
      void refresh()
    }
  }

  async function run(automationID: string) {
    const res = await globalSDK.client.automation.run({ automationID })
    if (res.error) {
      showToast({ title: language.t("automation.toast.runFailed") })
      return
    }
    automationSessions?.refetch()
    // 运行会新建(或复用)一个会话:直接带用户过去看结果,否则 global 自动化跑完毫无可见反馈
    const path = runSessionPath(res.data)
    if (!path) {
      showToast({ title: language.t("automation.toast.runStarted") })
      return
    }
    navigate(path)
  }

  async function remove(automationID: string) {
    const res = await globalSDK.client.automation.remove({ automationID })
    if (res.error) {
      showToast({ title: language.t("automation.toast.deleteFailed") })
      return
    }
    showToast({ title: language.t("automation.toast.deleted") })
    await refresh()
  }

  function openEditorForEdit(a: AutomationInfo) {
    dialog.show(() => <AutomationEditorDialog editing={a} onCreated={() => refresh()} />)
  }

  const projectLabel = (a: { directory: string | null; projectID: string | null }) =>
    projectName(a.directory) || a.projectID || ""

  function confirmRemove(a: AutomationInfo) {
    dialog.show(() => (
      <CdxConfirm
        title={language.t("automation.delete.confirmTitle")}
        name={a.title}
        body={language.t("automation.delete.confirmBody")}
        confirmLabel={language.t("automation.action.delete")}
        cancelLabel={language.t("automation.editor.cancel")}
        onConfirm={() => remove(a.id)}
      />
    ))
  }

  // 创建方式(分体按钮):默认"通过聊天创建",对照 Codex useState("codex");
  // 选某一项后该方式成为左侧主按钮默认,handler 自身既切换 mode 又执行动作(对照 Codex ot/mt)
  const [createMode, setCreateMode] = createSignal<"chat" | "manual">("chat")
  const createModeLabel = () =>
    language.t(createMode() === "manual" ? "automation.createManually" : "automation.createViaChat")
  function createManually() {
    setCreateMode("manual")
    openEditor()
  }
  // 通过聊天创建:对照 Codex(navigate-to-/ + prefillPrompt),把引导元提示词预填进 composer。
  // 优先落在第一个真实项目(AI 建出的自动化即归属该项目目录),无项目时兜底散对话。
  // 复刻 deep-link 新会话流程(layout 的 handleDeepLinks):open 项目 + 设会话交接 + 带
  // ?prompt= 导航(session.tsx 消费 query 预填 composer,handoff 作兜底)。
  function createViaChat() {
    setCreateMode("chat")
    const text = language.t("automation.createViaChat.prompt")
    const dir = layout.projects.list()[0]?.worktree
    const meta = encodeURIComponent(text)
    if (!dir) {
      navigate(`/?prompt=${meta}`)
      return
    }
    layout.projects.open(dir)
    const slug = base64Encode(dir)
    setSessionHandoff(slug, { prompt: text })
    navigate(`/${slug}/session?prompt=${meta}`)
  }
  const runCreateMode = () => (createMode() === "manual" ? createManually() : createViaChat())

  // 单行(对照 Codex selectable-list-row):状态圈 + 标题 + 项目 +(下次运行/操作切换)
  const renderRow = (a: AutomationInfo) => (
    <li class="cdx-row" onClick={() => navigate(`/automations/${a.id}`)}>
      <span class="cdx-row__icon">
        <Show when={a.enabled} fallback={<CdxIcon name="pause" />}>
          <CdxIcon name="circle" />
        </Show>
      </span>
      <div class="cdx-row__content">
        <div class="cdx-row__line1">
          <div class="cdx-row__titlewrap">
            <span class="cdx-row__title">{a.title}</span>
            {/* 未读指示器:侧栏那个点只说明「有未读」,进来后必须能看出是**哪条**自动化,
                否则用户只能逐条点进详情页翻。unreadIDs 由后端按 read_at 判定。 */}
            <Show when={automationSessions?.unreadIDs().has(a.id)}>
              <span
                class="size-1.5 rounded-full shrink-0"
                style={{ "background-color": "var(--icon-interactive-base, #0a7cff)" }}
                title={language.t("automation.inbox.unreadTooltip")}
              />
            </Show>
            <Show when={projectLabel(a)}>
              <span class="cdx-row__project">{projectLabel(a)}</span>
            </Show>
          </div>
          <div class="cdx-row__right">
            <span class="cdx-row__nextrun">
              {a.enabled ? nextRunLabel(a.enabled, a.nextRunAt, language.t) : language.t("automation.status.paused")}
            </span>
            <div class="cdx-row__actions" onClick={(e) => e.stopPropagation()}>
              {/* 主按钮跟随状态:已暂停显示 ▷=恢复,活动中显示 ⏸=暂停(与左侧状态圈语义一致)。
                  「立即运行一次」是另一回事,收进 ⋯ 菜单,避免和"启动"混淆 */}
              <button
                type="button"
                class="cdx-iconbtn cdx-iconbtn--sm"
                aria-label={language.t(a.enabled ? "automation.action.pause" : "automation.action.resume")}
                onClick={() => toggle(a.id, !a.enabled)}
              >
                <Show when={a.enabled} fallback={<CdxIcon name="run" />}>
                  <CdxIcon name="pause" />
                </Show>
              </button>
              <button
                type="button"
                class="cdx-iconbtn cdx-iconbtn--sm"
                aria-label={language.t("automation.action.edit")}
                onClick={() => openEditorForEdit(a)}
              >
                <Icon name="pencil-line" size="small" />
              </button>
              <DropdownMenu>
                <DropdownMenu.Trigger as="button" type="button" class="cdx-iconbtn cdx-iconbtn--sm" aria-label="more">
                  <CdxIcon name="ellipsis" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="cdx cdx-menu">
                    <DropdownMenu.Item as="button" class="cdx-menu__item" onSelect={() => run(a.id)}>
                      <Icon name="run" size="small" />
                      {language.t("automation.action.runNow")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      as="button"
                      class="cdx-menu__item cdx-menu__item--danger"
                      onSelect={() => confirmRemove(a)}
                    >
                      <CdxIcon name="trash" />
                      {language.t("automation.action.delete")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
    </li>
  )

  const activeList = () => (automations.latest ?? []).filter((a) => a.enabled)
  const pausedList = () => (automations.latest ?? []).filter((a) => !a.enabled)

  return (
    <div class="cdx cdx-page">
      <div class="cdx-page-inner">
        <header class="flex items-start justify-between gap-4">
          <div>
            <h1 class="cdx-h1">{language.t("automation.title")}</h1>
            <Show when={(automations.latest?.length ?? 0) === 0}>
              <p class="cdx-sub">{language.t("automation.subtitle")}</p>
            </Show>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            {/* 一键已读:只在真有未读时出现。侧栏那个「全部已读」藏在只对 global 自动化
                渲染的区块里,大多数用户看不到;这里是找未读时最自然的落点。 */}
            <Show when={(automationSessions?.unreadTotal() ?? 0) > 0}>
              <button
                type="button"
                class="cdx-btn cdx-btn--ghost inline-flex items-center gap-1.5"
                onClick={() => void markAllRead()}
              >
                <span
                  class="size-1.5 rounded-full shrink-0"
                  style={{ "background-color": "var(--icon-interactive-base, #0a7cff)" }}
                />
                {language.t("automation.inbox.markAllRead")}
              </button>
            </Show>
            <button type="button" class="cdx-btn cdx-btn--ghost" onClick={openTemplates}>
              {language.t("automation.viewTemplates")}
            </button>
            {/* 分体创建按钮:左=按当前方式直接创建,右 chevron=下拉切换方式(对照 Codex compound-button) */}
            <div class="cdx-split" data-action="automation-create">
              <button type="button" class="cdx-split__main" onClick={runCreateMode}>
                {createModeLabel()}
              </button>
              <DropdownMenu>
                <DropdownMenu.Trigger
                  as="button"
                  type="button"
                  class="cdx-split__chev"
                  aria-label={language.t("automation.newMenu")}
                >
                  <CdxIcon name="chevronDown" class="shrink-0" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="codex-chat-menu [&_[data-slot=dropdown-menu-item]]:pl-1">
                    <DropdownMenu.Item data-action="automation-create-chat" onSelect={createViaChat}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="speech-bubble" size="small" class="text-icon-weak" />
                      </div>
                      <DropdownMenu.ItemLabel>{language.t("automation.createViaChat")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item data-action="automation-create-manual" onSelect={createManually}>
                      <div class="flex size-5 shrink-0 items-center justify-center">
                        <Icon name="pencil-line" size="small" class="text-icon-weak" />
                      </div>
                      <DropdownMenu.ItemLabel>{language.t("automation.createManually")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <Show
          when={(automations.latest?.length ?? 0) > 0}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-6 py-24">
              <CdxIcon name="clock" size={56} class="cdx-empty__clock" />
              <div class="text-[15px] font-medium" style={{ color: "var(--cdx-text)" }}>
                {language.t("automation.empty.title")}
              </div>
              <div class="flex flex-wrap items-center justify-center gap-2">
                <For each={SUGGESTIONS}>
                  {(suggestion) => (
                    <button
                      type="button"
                      class="cdx-btn cdx-btn--outline"
                      onClick={() => openEditorFromPresetKey(suggestion.titleKey)}
                    >
                      <CdxIcon name={suggestion.icon} size={18} class="shrink-0" />
                      {language.t(suggestion.titleKey)}
                    </button>
                  )}
                </For>
              </div>
            </div>
          }
        >
          <div class="mt-9 flex flex-col gap-8">
            <Show when={activeList().length > 0}>
              <section>
                <div class="cdx-list-head">
                  <span class="cdx-list-head__label">{language.t("automation.list.current")}</span>
                  <span class="cdx-list-head__rule" />
                </div>
                <ul class="cdx-list">
                  <For each={activeList()}>{(a) => renderRow(a)}</For>
                </ul>
              </section>
            </Show>
            <Show when={pausedList().length > 0}>
              <section>
                <div class="cdx-list-head">
                  <span class="cdx-list-head__label">{language.t("automation.list.paused")}</span>
                  <span class="cdx-list-head__rule" />
                </div>
                <ul class="cdx-list">
                  <For each={pausedList()}>{(a) => renderRow(a)}</For>
                </ul>
              </section>
            </Show>
            <section class="cdx-suggestions">
              <div class="cdx-list-head">
                <h2 class="cdx-list-head__label">{language.t("automation.suggestions.title")}</h2>
                <span class="cdx-list-head__rule" />
              </div>
              <ul class="cdx-suggestion-list">
                <For each={SUGGESTIONS}>
                  {(suggestion) => {
                    const preset = TEMPLATE_PRESETS[TEMPLATE_BY_KEY[suggestion.titleKey]]
                    return (
                      <li>
                        <button
                          type="button"
                          class="cdx-suggestion"
                          onClick={() => openEditorFromPresetKey(suggestion.titleKey)}
                        >
                          <span class="cdx-suggestion__icon" data-tone={suggestion.tone}>
                            <CdxIcon name={suggestion.icon} size={18} />
                          </span>
                          <span class="cdx-suggestion__content">
                            <span class="cdx-suggestion__line">
                              <span class="cdx-suggestion__title">{language.t(suggestion.titleKey)}</span>
                              <span class="cdx-suggestion__schedule">
                                {scheduleSummary(
                                  coerceSchedule(preset.scheduleConfig, preset.scheduleKind),
                                  language.t,
                                )}
                              </span>
                            </span>
                            <span class="cdx-suggestion__description">{language.t(suggestion.descriptionKey)}</span>
                          </span>
                        </button>
                      </li>
                    )
                  }}
                </For>
              </ul>
            </section>
          </div>
        </Show>
      </div>
    </div>
  )
}
