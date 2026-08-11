import { Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { CdxIcon } from "@/pages/automation/cdx-icons"
import { useAutomationSessions } from "@/context/automation-sessions"
import { useLanguage } from "@/context/language"
import { useLocation } from "@solidjs/router"
import { usePlatform } from "@/context/platform"

// 全局入口对齐 Codex 侧栏：文字和图标走主题 token，让玻璃背景下的明暗由主题统一控制
const LABEL_WEIGHT = "400"

const ROW_CLASS =
  "w-full flex items-center h-8 pl-4 pr-3 gap-3 rounded-md text-left text-[14px] font-medium text-text-base hover:bg-button-secondary-hover hover:text-text-strong"

const labelStyle = { "font-weight": LABEL_WEIGHT } as const

// Region 1：全局功能（新对话 / 搜索 / 插件 / 自动化）
export const SidebarGlobals = (props: {
  onNewChat: () => void
  onSearch: () => void
  onPlugins: () => void
  onAutomations: () => void
  onQuickChat: () => void
}): JSX.Element => {
  const language = useLanguage()
  const automationSessions = useAutomationSessions()
  const platform = usePlatform()
  const location = useLocation()
  const isAutomations = () => location.pathname === "/automations"
  return (
    <div class="flex flex-col gap-1 px-2 py-2">
      <button
        type="button"
        class={ROW_CLASS}
        style={labelStyle}
        onClick={props.onNewChat}
        data-action="globals-new-chat"
      >
        <Icon name="pencil-line" size="small" class="shrink-0" />
        <span>{language.t("sidebar.global.newChat")}</span>
      </button>
      <button type="button" class={ROW_CLASS} style={labelStyle} onClick={props.onSearch} data-action="globals-search">
        <Icon name="magnifying-glass" size="small" class="shrink-0" />
        <span>{language.t("sidebar.global.search")}</span>
      </button>
      <button type="button" class={ROW_CLASS} style={labelStyle} onClick={props.onPlugins} data-action="globals-plugins">
        <Icon name="apps-grid" size="small" class="shrink-0" />
        <span>{language.t("sidebar.global.plugins")}</span>
      </button>
      <button
        type="button"
        class={ROW_CLASS}
        classList={{ "bg-button-secondary-base text-text-strong": isAutomations() }}
        style={labelStyle}
        onClick={props.onAutomations}
        data-action="globals-automations"
        aria-current={isAutomations() ? "page" : undefined}
      >
        {/* 对照 Codex:侧栏「自动化」入口与每个自动化对话统一用时钟图标(clock-CDmkoq1h) */}
        <span class="shrink-0 inline-flex items-center justify-center">
          <CdxIcon name="clock" size={16} />
        </span>
        <span class="min-w-0 flex-1 truncate text-left">{language.t("sidebar.global.automations")}</span>
        {/* 未读指示器(对照 Codex 侧栏 Scheduled 尾部的小圆点)。必须挂在这个**常驻**入口上:
            下方「自动化」区块只渲染 scope=global 的孤儿目录会话,而默认 scope 是 current_project,
            挂在那里等于绝大多数用户永远看不到红点。 */}
        <Show when={(automationSessions?.unreadTotal() ?? 0) > 0}>
          <span
            class="size-1.5 rounded-full shrink-0"
                // 用内联 style + 主题变量,不用 Tailwind 颜色类:本项目是自定义 token 调色板,
                // bg-blue-500 / bg-accent-base 这类类名都不存在,写上去元素照样渲染但背景透明 —— 静默失效
                style={{ "background-color": "var(--icon-interactive-base, #0a7cff)" }}
            title={language.t("automation.inbox.unreadTooltip")}
          />
        </Show>
      </button>
      <Show when={platform.platform === "desktop"}>
        <button
          type="button"
          class={ROW_CLASS}
          style={labelStyle}
          onClick={props.onQuickChat}
          data-action="globals-quick-chat"
        >
          <Icon name="speech-bubble" size="small" class="shrink-0" />
          <span>{language.t("sidebar.global.quickChat")}</span>
        </button>
      </Show>
    </div>
  )
}
