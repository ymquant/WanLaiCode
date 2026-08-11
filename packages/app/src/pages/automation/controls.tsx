import { For, Show } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useLanguage } from "@/context/language"
import { CdxIcon, type CdxIconName } from "./cdx-icons"
import "./codex.css"

export type SelectOption = { id: string; label: string }
type Translate = (key: string) => string

// 通用下拉(执行环境/模型/推理/项目):触发器 ghost 文字 + chevron,菜单项选中打勾
export function CdxSelect(props: {
  value: string | null
  options: SelectOption[]
  onChange: (id: string) => void
  placeholder?: string
  triggerClass?: string
  cdxIcon?: CdxIconName
  iconOnly?: boolean
  ariaLabel?: string
}) {
  const current = () => props.options.find((o) => o.id === props.value)
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as="button"
        type="button"
        class={props.triggerClass ?? "cdx-select"}
        aria-label={props.ariaLabel}
      >
        <Show when={props.cdxIcon}>
          <CdxIcon name={props.cdxIcon!} class="cdx-pill__lead shrink-0" />
        </Show>
        <Show when={!props.iconOnly}>
          <span class="cdx-select__label truncate">{current()?.label ?? props.placeholder ?? props.value ?? ""}</span>
          <CdxIcon name="chevronDown" class="cdx-pill__chev shrink-0" />
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="cdx cdx-menu cdx-menu--select">
          <For each={props.options}>
            {(o) => (
              <DropdownMenu.Item as="button" class="cdx-menu__item" onSelect={() => props.onChange(o.id)}>
                <span class="cdx-menu__label">{o.label}</span>
                <Show when={o.id === props.value}>
                  <CdxIcon name="check" class="shrink-0" />
                </Show>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

// 状态徽章:圆点 + 文字(对照 Codex tn,Active 绿 / Paused 橙)
export function CdxStatusBadge(props: { enabled: boolean }) {
  const language = useLanguage()
  return (
    <span class="cdx-badge">
      <span class="cdx-badge__dot" data-status={props.enabled ? "active" : "paused"} />
      <span>{language.t(props.enabled ? "automation.status.active" : "automation.status.paused")}</span>
    </span>
  )
}

export const EXEC_ENVS = ["local", "worktree", "thread"] as const
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const

// 运行环境选项。对照 Codex 当前构建:自动化编辑器**已经没有 worktree 选项**了,
// automation_update 的 schema 明写「New automations must use local; updates may preserve
// worktree for existing automations」。我们此前的 worktree 也从未真的建过工作树
// (local/worktree 走完全相同的代码路径),摆在 UI 上只是个骗人的隔离承诺。
// 因此只在当前值已经是 worktree 的存量记录上保留该选项,新建一律 local。
export function execEnvOptions(t: Translate, current?: string | null): SelectOption[] {
  return [
    { id: "local", label: t("automation.env.local") },
    ...(current === "worktree" ? [{ id: "worktree", label: t("automation.env.worktree") }] : []),
    { id: "thread", label: t("automation.env.thread") },
  ]
}

// 通知策略(对照 Codex:枚举只有 failed_runs_only,空值=每次跑完都通知)。
// 选「仅失败」时成功的运行会直接标已读,不产生未读也不弹通知。
export function notificationOptions(t: Translate): SelectOption[] {
  return [
    { id: "all", label: t("automation.notification.all") },
    { id: "failed_runs_only", label: t("automation.notification.failedOnly") },
  ]
}

// 不提供「无」(none):自动化默认 medium,推理强度必须为具体档位
export function reasoningOptions(t: Translate): SelectOption[] {
  return REASONING_EFFORTS.filter((r) => r !== "none").map((r) => ({ id: r, label: t(`automation.reasoning.${r}`) }))
}
