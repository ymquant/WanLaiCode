import { createEffect, createMemo, createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { CdxIcon } from "./cdx-icons"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useAutomationSessions } from "@/context/automation-sessions"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { CdxSchedulePill } from "./schedule-popover"
import { coerceSchedule } from "./schedule"
import { CdxSelect, CdxStatusBadge, execEnvOptions, notificationOptions, reasoningOptions } from "./controls"
import { CdxConfirm } from "./codex-ui"
import { lastRunLabel, nextRunLabel, projectName } from "./format"
import "./codex.css"

function FieldRow(props: { label: string; children: JSX.Element }) {
  return (
    <div class="cdx-frow">
      <span class="cdx-frow__label">{props.label}</span>
      <div class="cdx-frow__value">{props.children}</div>
    </div>
  )
}

export default function AutomationDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const automationSessions = useAutomationSessions()
  const language = useLanguage()
  const dialog = useDialog()
  const models = useModels()
  const t = language.t

  const [automation, { refetch }] = createResource(
    () => params.id,
    async (id) => {
      // 自动化可能已被删除:SDK 在 404 时会抛异常,这里兜住返回 null,展示空态而非崩溃
      try {
        const res = await sdk.client.automation.get({ automationID: id })
        return res.error ? null : res.data
      } catch {
        return null
      }
    },
  )
  const [runs, { refetch: refetchRuns }] = createResource(
    () => params.id,
    async (id) => {
      try {
        const res = await sdk.client.automation.runs({ automationID: id })
        return res.error ? [] : (res.data ?? [])
      } catch {
        return []
      }
    },
  )

  const back = () => navigate("/automations")

  // 该自动化当前是否有运行中的运行 —— 既驱动周期刷新,也决定「立即运行」按钮是否可点
  const hasActiveRun = createMemo(() => runs()?.some((r) => r.status === "running") ?? false)


  // 有运行中的任务时周期刷新,实时反映 成功/失败 及 lastRun/nextRun 的推进
  createEffect(() => {
    if (!hasActiveRun()) return
    const timer = setInterval(() => {
      void refetchRuns()
      void refetch()
    }, 3000)
    onCleanup(() => clearInterval(timer))
  })

  // 点进某次运行对应的会话(需 sessionID + directory)。
  // 打开即标已读 —— 这是收件箱的自然行为,也是用户「怎么把红点消掉」的主路径:
  // 看过了就不该还算未读,不必再去找「标为已读」菜单。
  // readAt 用 unknown:SDK 把数值编码成 number | "NaN" | "Infinity" 联合类型,这里只需判是不是 null
  function openRunSession(r: { id?: string; sessionID: string | null; directory?: string | null; readAt?: unknown }) {
    if (!r.sessionID || !r.directory) return
    if (r.id && r.readAt === null) void setRunRead(r.id, true)
    navigate(`/${base64Encode(r.directory)}/session/${r.sessionID}`)
  }

  // 改配置(尤其是运行目录)会改变根级 provider 的目录集合,侧栏「自动化」区靠它发现
  // 不属于任何项目的隐藏目录,所以本页资源与 provider 要一起刷新
  async function refresh() {
    await refetch()
    automationSessions?.refetch()
  }

  async function patch(p: Record<string, unknown>) {
    const a = automation()
    if (!a) return
    const res = await sdk.client.automation.update({ automationID: a.id, ...p })
    if (res.error) {
      showToast({ title: t("automation.toast.updateFailed") })
      return
    }
    await refresh()
  }

  // 「立即运行」的禁用条件必须是**真实运行状态**,不能只看 HTTP 在不在飞:
  // 后端 triggerManualRun 建完会话就返回(回合在后台跑),请求本身只有几百毫秒,
  // 只按 in-flight 禁用等于几乎没禁用。这里 in-flight 标记只负责堵住
  // 「请求已发出、运行记录还没查回来」的空档,真正的门是 hasActiveRun()。
  // 归档只是展示态:接口返回全部运行,这里决定显示哪些。
  // 没有这个开关的话归档就是单向操作 —— 归档后的运行再也看不到,也无从取消归档。
  const [showArchived, setShowArchived] = createSignal(false)
  const activeRuns = createMemo(() => (runs() ?? []).filter((r) => r.archivedAt === null))
  const archivedRuns = createMemo(() => (runs() ?? []).filter((r) => r.archivedAt !== null))
  const visibleRuns = createMemo(() => (showArchived() ? archivedRuns() : activeRuns()))

  const [submitting, setSubmitting] = createSignal(false)
  const runBusy = () => submitting() || hasActiveRun()

  async function runNow() {
    const a = automation()
    if (!a || runBusy()) return
    setSubmitting(true)
    try {
      const res = await sdk.client.automation.run({ automationID: a.id })
      showToast({ title: t(res.error ? "automation.toast.runFailed" : "automation.toast.runStarted") })
      if (!res.error) automationSessions?.refetch()
      // 必须 await:不 await(或用 setTimeout)会留下一段 submitting 已复位、
      // 而 runs() 里还没有 running 记录的空档,按钮在那一瞬间又可点了。
      await refetchRuns()
    } finally {
      setSubmitting(false)
    }
  }

  // ---------- 收件箱操作 ----------
  // 每个操作后都要 refetchRuns（刷新本页）+ automationSessions.refetch（刷新侧栏未读点），
  // 否则用户在详情页标了已读，侧栏红点还挂着。
  async function afterInboxChange() {
    await refetchRuns()
    automationSessions?.refetch()
  }

  async function setRunRead(runID: string, read: boolean) {
    await sdk.client.automation.setRunRead({ runID, read })
    await afterInboxChange()
  }

  async function archiveRun(runID: string) {
    await sdk.client.automation.archiveRun({ runID })
    await afterInboxChange()
  }

  async function unarchiveRun(runID: string) {
    await sdk.client.automation.unarchiveRun({ runID })
    await afterInboxChange()
  }

  async function markAllRead() {
    const a = automation()
    if (!a) return
    await sdk.client.automation.readAll({ automationID: a.id })
    await afterInboxChange()
  }

  // 全部归档会一次性清空历史视图,且 UI 上没有「显示已归档」入口可撤销 —— 要二次确认
  function confirmArchiveAll() {
    const a = automation()
    if (!a) return
    dialog.show(() => (
      <CdxConfirm
        title={t("automation.inbox.archiveAllConfirmTitle")}
        name={a.title}
        body={t("automation.inbox.archiveAllConfirmBody")}
        confirmLabel={t("automation.inbox.archiveAll")}
        cancelLabel={t("automation.editor.cancel")}
        onConfirm={async () => {
          const res = await sdk.client.automation.archiveAllRuns({ automationID: a.id })
          const count = typeof res.data?.count === "number" ? res.data.count : 0
          showToast({ title: t("automation.inbox.archivedCount").replace("{count}", String(count)) })
          await afterInboxChange()
        }}
      />
    ))
  }

  async function togglePause() {
    const a = automation()
    if (!a) return
    await sdk.client.automation.toggle({ automationID: a.id, enabled: !a.enabled })
    await refresh()
  }

  function confirmDelete() {
    const a = automation()
    if (!a) return
    dialog.show(() => (
      <CdxConfirm
        title={t("automation.delete.confirmTitle")}
        name={a.title}
        body={t("automation.delete.confirmBody")}
        confirmLabel={t("automation.action.delete")}
        cancelLabel={t("automation.editor.cancel")}
        onConfirm={async () => {
          await sdk.client.automation.remove({ automationID: a.id })
          automationSessions?.refetch()
          back()
        }}
      />
    ))
  }

  const modelOptions = createMemo(() => models.list().map((m) => ({ id: `${m.provider.id}/${m.id}`, label: m.name })))

  const projectLabel = (dir: string | null, pid: string | null) => projectName(dir) || pid || ""

  return (
    <div class="cdx cdx-page" style={{ padding: "0" }}>
      <Show
        when={automation()}
        fallback={
          <div class="cdx-detail__main">
            <div class="cdx-detail__main-inner">
              <div class="cdx-frow__plain" style={{ color: "var(--cdx-text-3)" }}>
                {automation.loading ? "…" : t("automation.detail.back")}
              </div>
              <Show when={!automation.loading}>
                <button
                  type="button"
                  class="cdx-btn cdx-btn--secondary"
                  style={{ "align-self": "flex-start" }}
                  onClick={back}
                >
                  {t("automation.detail.back")}
                </button>
              </Show>
            </div>
          </div>
        }
      >
        {(a) => (
          <div class="flex h-full min-h-0 flex-col">
            {/* 顶栏:面包屑 + 操作 */}
            <div class="cdx-detail__top">
              <div class="cdx-crumb">
                <button type="button" class="cdx-crumb__link" onClick={back}>
                  {t("automation.title")}
                </button>
                <CdxIcon name="chevronRight" class="shrink-0" />
                <span class="cdx-crumb__cur">{a().title}</span>
              </div>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="cdx-iconbtn"
                  aria-label={t(a().enabled ? "automation.action.pause" : "automation.action.resume")}
                  onClick={togglePause}
                >
                  <Show when={a().enabled} fallback={<CdxIcon name="run" />}>
                    <CdxIcon name="pause" />
                  </Show>
                </button>
                <button
                  type="button"
                  class="cdx-iconbtn"
                  aria-label={t("automation.action.delete")}
                  onClick={confirmDelete}
                >
                  <CdxIcon name="trash" />
                </button>
                <button type="button" class="cdx-btn cdx-btn--primary" disabled={runBusy()} onClick={runNow}>
                  <CdxIcon name="run" />
                  {t("automation.action.run")}
                </button>
              </div>
            </div>

            {/* 主体:左 prompt + 右字段栏 */}
            <div class="cdx-detail">
              <div class="cdx-detail__main">
                <div class="cdx-detail__main-inner">
                  <input
                    class="cdx-detail__title-input"
                    value={a().title}
                    onChange={(e) => patch({ title: e.currentTarget.value })}
                  />
                  <textarea
                    class="cdx-detail__prompt"
                    value={a().prompt}
                    placeholder={t("automation.editor.promptPlaceholder")}
                    onChange={(e) => patch({ prompt: e.currentTarget.value })}
                  />
                  <p class="cdx-field__help">{t("automation.editor.promptHelp")}</p>
                </div>
              </div>

              <aside class="cdx-detail__rail">
                <div class="cdx-sec">{t("automation.detail.status")}</div>
                <FieldRow label={t("automation.detail.status")}>
                  <CdxStatusBadge enabled={a().enabled} />
                </FieldRow>
                <FieldRow label={t("automation.detail.nextRun")}>
                  {/* 启用中却算不出下次运行 = 排期无效(如 custom 模式 RRULE 为空或写错),
                      必须明确告警：中性的「未排期」会让用户以为只是还没到点，实际永远不会运行 */}
                  <span
                    class="cdx-badge"
                    classList={{ "cdx-badge--warn": a().enabled && a().nextRunAt == null }}
                    title={a().enabled && a().nextRunAt == null ? t("automation.nextRun.invalidHint") : undefined}
                  >
                    {a().enabled && a().nextRunAt == null
                      ? t("automation.nextRun.invalid")
                      : nextRunLabel(a().enabled, a().nextRunAt, t)}
                  </span>
                </FieldRow>
                <FieldRow label={t("automation.detail.lastRun")}>
                  <span class="cdx-badge">{lastRunLabel(a().lastRunAt, t)}</span>
                </FieldRow>

                <div class="cdx-sec">{t("automation.detail.details")}</div>
                <FieldRow label={t("automation.detail.runsIn")}>
                  <CdxSelect
                    value={a().executionEnvironment}
                    options={execEnvOptions(t, a().executionEnvironment)}
                    onChange={(v) => patch({ executionEnvironment: v })}
                  />
                </FieldRow>
                <FieldRow label={t("automation.detail.project")}>
                  <span class="cdx-frow__plain">{projectLabel(a().directory, a().projectID) || "—"}</span>
                </FieldRow>
                <FieldRow label={t("automation.detail.repeats")}>
                  <CdxSchedulePill
                    config={coerceSchedule(a().scheduleConfig)}
                    showIcon={false}
                    triggerClass="cdx-pill--bare"
                    onChange={(c) => patch({ scheduleConfig: c })}
                  />
                </FieldRow>
                <FieldRow label={t("automation.detail.model")}>
                  <CdxSelect value={a().model} options={modelOptions()} onChange={(v) => patch({ model: v })} />
                </FieldRow>
                <FieldRow label={t("automation.detail.reasoning")}>
                  <CdxSelect
                    value={a().reasoningEffort ?? "medium"}
                    options={reasoningOptions(t)}
                    onChange={(v) => patch({ reasoningEffort: v })}
                  />
                </FieldRow>

                <FieldRow label={t("automation.detail.notification")}>
                  <CdxSelect
                    value={a().notificationPolicy ?? "all"}
                    options={notificationOptions(t)}
                    onChange={(v) => patch({ notificationPolicy: v === "failed_runs_only" ? "failed_runs_only" : null })}
                  />
                </FieldRow>

                <div class="cdx-sec cdx-sec--row">
                  <span>{t("automation.detail.history")}</span>
                  {/* 区块级批量操作(对照 Codex 的 Mark all as read / Archive all)。
                      归档只影响列表可见性,不删除会话本身。 */}
                  <span class="cdx-sec__actions">
                    <Show when={archivedRuns().length > 0}>
                      <button type="button" class="cdx-sec__act" onClick={() => setShowArchived((v) => !v)}>
                        {t(showArchived() ? "automation.inbox.showActive" : "automation.inbox.showArchived").replace(
                          "{count}",
                          String(showArchived() ? activeRuns().length : archivedRuns().length),
                        )}
                      </button>
                    </Show>
                    <Show when={!showArchived() && activeRuns().length > 0}>
                      <button type="button" class="cdx-sec__act" onClick={() => void markAllRead()}>
                        {t("automation.inbox.markAllRead")}
                      </button>
                      <button type="button" class="cdx-sec__act" onClick={confirmArchiveAll}>
                        {t("automation.inbox.archiveAll")}
                      </button>
                    </Show>
                  </span>
                </div>
                <div class="cdx-hist">
                  <Show
                    when={visibleRuns().length > 0}
                    fallback={<div class="cdx-hist__empty">{t("automation.detail.noRuns")}</div>}
                  >
                    <For each={visibleRuns()}>
                      {(r) => {
                        const linkable = () => !!r.sessionID && !!r.directory
                        // 触发方式 + 耗时 + 失败原因:后端早已落库,此前全被前端丢掉,
                        // 失败的运行只剩一个红点,用户无从判断为什么没出结果。
                        const trigger = () =>
                          t(r.trigger === "manual" ? "automation.run.triggerManual" : "automation.run.triggerSchedule")
                        const duration = () => {
                          // SDK 把数值字段编码成 number | "NaN" | "Infinity" 联合类型,先归一化再算
                          const started = Number(r.startedAt)
                          const finished = Number(r.finishedAt)
                          if (r.status === "running" || !Number.isFinite(started) || !Number.isFinite(finished))
                            return undefined
                          const seconds = Math.max(1, Math.round((finished - started) / 1000))
                          return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
                        }
                        const rowTitle = () =>
                          r.error ?? (linkable() ? t("automation.detail.openConversation") : undefined)
                        // 未读 = 跑完了但用户还没看(与后端 unreadCount 判据一致)
                        const unread = () => r.readAt === null && r.status !== "running"
                        // 标题优先用模型给的 ::inbox-item 摘要——「这次跑出了什么」比每行都一样的
                        // 触发方式有信息量;没有指令时回退到触发方式+耗时
                        const headline = () => r.inboxTitle?.trim() || trigger()
                        return (
                          <div
                            class="cdx-hist__row"
                            classList={{ "cdx-hist__row--link": linkable(), "cdx-hist__row--unread": unread() }}
                            title={rowTitle()}
                            onClick={() => openRunSession(r)}
                          >
                            <span class="cdx-hist__icon">
                              <span class="cdx-hist__dot" data-s={r.status} />
                            </span>
                            <span class="cdx-hist__title">
                              <span class="cdx-hist__headline">{headline()}</span>
                              <Show when={duration()}>{(d) => <span class="cdx-hist__meta"> · {d()}</span>}</Show>
                              <Show when={r.inboxSummary?.trim()}>
                                {(s) => <span class="cdx-hist__summary">{s()}</span>}
                              </Show>
                              <Show when={r.error}>
                                {(err) => <span class="cdx-hist__error">{err()}</span>}
                              </Show>
                            </span>
                            <span class="cdx-hist__time">
                              {r.status === "running" ? t("automation.run.running") : lastRunLabel(r.startedAt, t)}
                            </span>
                            {/* 未读点:与侧栏/列表页同一个视觉语言。左侧那个红/绿点是**运行结果**,
                                两者语义不同不能合并,所以未读点放行尾。 */}
                            <Show when={unread()}>
                              <span
                                class="size-1.5 rounded-full shrink-0"
                                style={{ "background-color": "var(--icon-interactive-base, #0a7cff)" }}
                                title={t("automation.inbox.unreadTooltip")}
                              />
                            </Show>
                            {/* 单条操作:stopPropagation 避免点操作时连带跳进会话 */}
                            <span class="cdx-hist__acts" onClick={(e) => e.stopPropagation()}>
                              <Show when={r.archivedAt !== null}>
                                <button
                                  type="button"
                                  class="cdx-hist__act"
                                  title={t("automation.inbox.unarchive")}
                                  onClick={() => void unarchiveRun(r.id)}
                                >
                                  {t("automation.inbox.unarchive")}
                                </button>
                              </Show>
                              <Show when={r.archivedAt === null && r.status !== "running"}>
                                <button
                                  type="button"
                                  class="cdx-hist__act"
                                  title={t(unread() ? "automation.inbox.markRead" : "automation.inbox.markUnread")}
                                  onClick={() => void setRunRead(r.id, unread())}
                                >
                                  {t(unread() ? "automation.inbox.markRead" : "automation.inbox.markUnread")}
                                </button>
                                <button
                                  type="button"
                                  class="cdx-hist__act"
                                  title={t("automation.inbox.archive")}
                                  onClick={() => void archiveRun(r.id)}
                                >
                                  {t("automation.inbox.archive")}
                                </button>
                              </Show>
                            </span>
                          </div>
                        )
                      }}
                    </For>
                  </Show>
                </div>
              </aside>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
