import { createMemo, createSignal, For, Show } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import { useLanguage } from "@/context/language"
import { CdxIcon } from "./cdx-icons"
import {
  ALL_WEEKDAYS,
  HOUR_SLOTS,
  MINUTE_SLOTS,
  SCHEDULE_MODES,
  WEEKDAY_TO_NUM,
  joinTime,
  scheduleSummary,
  splitTime,
  type ScheduleConfig,
  type ScheduleMode,
  type WeekdayCode,
} from "./schedule"
import "./codex.css"

// 本机 IANA 时区名(如 Asia/Shanghai)。计划里的时刻按它解释;取不到时退回 UTC 偏移。
function localTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (zone) return zone
  const offset = -new Date().getTimezoneOffset() / 60
  return `UTC${offset >= 0 ? "+" : ""}${offset}`
}

type Opt = { id: string; label: string }

// 就地下拉(不 portal,避免触发外层 Popover 外部点击关闭);对照 Codex 的模式/星期下拉
function CdxInlineSelect(props: { value: string; options: Opt[]; onChange: (id: string) => void; ariaLabel?: string }) {
  const [open, setOpen] = createSignal(false)
  const current = () => props.options.find((o) => o.id === props.value)
  return (
    <div class="cdx-isel">
      <button type="button" class="cdx-isel__trigger" aria-label={props.ariaLabel} onClick={() => setOpen((v) => !v)}>
        <span class="min-w-0 truncate">{current()?.label ?? props.value}</span>
        <CdxIcon name="chevronDown" class="cdx-isel__chev shrink-0" />
      </button>
      <Show when={open()}>
        <div class="cdx-isel__list">
          <For each={props.options}>
            {(o) => (
              <button
                type="button"
                class="cdx-isel__item"
                data-sel={o.id === props.value ? "true" : "false"}
                onClick={() => {
                  props.onChange(o.id)
                  setOpen(false)
                }}
              >
                <span class="min-w-0 flex-1 truncate">{o.label}</span>
                <Show when={o.id === props.value}>
                  <CdxIcon name="check" class="shrink-0" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// 时间选择器:原生 input(隐藏系统指示器,可直接输到任意分钟)+ 时钟切换 + 小时/分钟两列面板
function CdxTimePicker(props: { value: string; onChange: (t: string) => void }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const parts = createMemo(() => splitTime(props.value))
  let hourRef: HTMLDivElement | undefined
  let minuteRef: HTMLDivElement | undefined
  const toggle = () => {
    const next = !open()
    setOpen(next)
    if (next)
      requestAnimationFrame(() => {
        for (const col of [hourRef, minuteRef]) {
          const sel = col?.querySelector('[data-sel="true"]') as HTMLElement | null
          sel?.scrollIntoView({ block: "center" })
        }
      })
  }
  return (
    <div class="cdx-time">
      <div class="cdx-time__row">
        <input
          class="cdx-time__input"
          type="time"
          value={props.value}
          onInput={(e) => props.onChange(e.currentTarget.value)}
        />
        <button
          type="button"
          class="cdx-time__toggle"
          data-open={open() ? "true" : "false"}
          aria-label={language.t("automation.schedule.title")}
          onClick={toggle}
        >
          <CdxIcon name="clock" />
        </button>
      </div>
      <Show when={open()}>
        <div class="cdx-time__panel" onWheel={(e) => e.stopPropagation()}>
          <div class="cdx-time__col" ref={hourRef}>
            <For each={HOUR_SLOTS}>
              {(h) => (
                <button
                  type="button"
                  class="cdx-time__item"
                  data-sel={h === parts().hour ? "true" : "false"}
                  onClick={() => props.onChange(joinTime(h, parts().minute))}
                >
                  {h}
                </button>
              )}
            </For>
          </div>
          <div class="cdx-time__col" ref={minuteRef}>
            <For each={MINUTE_SLOTS}>
              {(m) => (
                <button
                  type="button"
                  class="cdx-time__item"
                  data-sel={m === parts().minute ? "true" : "false"}
                  onClick={() => props.onChange(joinTime(parts().hour, m))}
                >
                  {m}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

// Codex 计划 Popover:模式/间隔/星期/时间/RRULE
export function CdxSchedulePill(props: {
  config: ScheduleConfig
  onChange: (c: ScheduleConfig) => void
  triggerClass?: string
  showIcon?: boolean
}) {
  const language = useLanguage()
  const c = () => props.config
  const set = (patch: Partial<ScheduleConfig>) => props.onChange({ ...c(), ...patch })
  const modeOpts = (): Opt[] => SCHEDULE_MODES.map((m) => ({ id: m, label: language.t(`automation.schedule.${m}`) }))
  const weekdayOpts = (): Opt[] =>
    ALL_WEEKDAYS.map((w) => ({ id: w, label: language.t(`automation.weekday.${WEEKDAY_TO_NUM[w]}`) }))

  return (
    <Popover
      portal
      // modal:本弹层会用在「手动创建」的模态 CdxModal(Kobalte Dialog)内,且 portal 到 body。
      // 非 modal 时 Dialog 的 focus-trap 会把焦点拽回 dialog → Popover.onFocusIn 判为「外部」→ 一开就闪退。
      // modal 让 Kobalte 把焦点锁在 popover 内,避免被外层 trap 抢走。
      modal
      gutter={6}
      triggerAs="button"
      triggerProps={{ type: "button", class: `cdx-pill ${props.triggerClass ?? ""}` }}
      class="cdx cdx-sched-pop"
      trigger={
        <>
          <Show when={props.showIcon !== false}>
            <CdxIcon name="clock" class="cdx-pill__lead shrink-0" />
          </Show>
          <span class="truncate">{scheduleSummary(c(), language.t)}</span>
          <CdxIcon name="chevronDown" class="cdx-pill__chev shrink-0" />
        </>
      }
    >
      <div class="cdx-sched">
        <div class="cdx-sched__title">{language.t("automation.schedule.title")}</div>

        <CdxInlineSelect
          value={c().mode}
          options={modeOpts()}
          ariaLabel={language.t("automation.schedule.title")}
          onChange={(v) => set({ mode: v as ScheduleMode })}
        />

        <Show when={c().mode === "interval"}>
          <label class="cdx-sched__interval">
            <span>{language.t("automation.schedule.every")}</span>
            <input
              class="cdx-sched__num"
              type="number"
              min="1"
              max="1440"
              value={c().intervalMinutes}
              onInput={(e) => set({ intervalMinutes: Math.max(1, Math.min(1440, Number(e.currentTarget.value) || 1)) })}
            />
            <span>{language.t("automation.schedule.minutes")}</span>
          </label>
        </Show>

        <Show when={c().mode === "hourly"}>
          <label class="cdx-sched__interval">
            <span>{language.t("automation.schedule.every")}</span>
            <input
              class="cdx-sched__num"
              type="number"
              min="1"
              max="24"
              value={c().intervalHours}
              onInput={(e) => set({ intervalHours: Math.max(1, Math.min(24, Number(e.currentTarget.value) || 1)) })}
            />
            <span>{language.t("automation.schedule.hours")}</span>
          </label>
        </Show>

        <Show when={c().mode === "weekly"}>
          <CdxInlineSelect
            value={c().weekdays[0] ?? "MO"}
            options={weekdayOpts()}
            onChange={(v) => set({ weekdays: [v as WeekdayCode] })}
          />
        </Show>

        <Show when={c().mode === "daily" || c().mode === "weekdays" || c().mode === "weekly"}>
          <CdxTimePicker value={c().time} onChange={(t) => set({ time: t })} />
        </Show>

        <Show when={c().mode === "custom"}>
          <input
            class="cdx-sched__rrule"
            type="text"
            spellcheck={false}
            placeholder={language.t("automation.schedule.customPlaceholder")}
            value={c().customRrule}
            onInput={(e) => set({ customRrule: e.currentTarget.value })}
          />
        </Show>

        {/* 时区明示。计划里的时刻按**本机时区的墙上时间**解释(对照 Codex:不存 IANA 时区)。
            此前这件事完全不可见 —— 用户说「北京时间 09:00」,数据层只存了 "09:00",
            换机器时区或在 UTC 服务器上就会偏几小时,而 UI 上看不出任何异常。
            custom 模式同样要显示:裸 RRULE 的 BYHOUR 也按本机墙钟解释,那才是最容易误解的一种。 */}
        <p class="cdx-sched__tz">
          {language.t("automation.schedule.timezoneNote").replace("{tz}", localTimezone())}
        </p>
      </div>
    </Popover>
  )
}
