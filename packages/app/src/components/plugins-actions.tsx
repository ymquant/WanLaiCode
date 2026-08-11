import { Show, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

// plugins 列表页 / Manage 页头部右侧的操作区共享组件，两页形态不同：
// 列表页：[刷新icon] [⚙ 管理] [+ ▾(Create plugin / Add marketplace / Record a skill)]
//   → refreshAs 默认 "icon"，刷新是最左侧独立图标按钮。
// Manage 页：[+ ▾(Create plugin / Create skill / Record a skill)] [··· (刷新)]
//   → refreshAs="menu"，刷新收进最右侧 ··· 菜单；不传 onManage（已在管理页，无需 ⚙）。
//
// 下拉每一项按对应 handler 是否传入决定是否渲染（顺序固定，缺省项自动跳过）。
// 当前各项均为 coming-soon 占位，handler 由调用方传入。

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

const ICON_BTN_CLASS =
  "size-8 rounded-md flex items-center justify-center text-text-base hover:bg-surface-base"

export function PluginsActions(props: {
  onRefresh: () => void
  refreshAs?: "icon" | "menu"
  primaryAction?: "plugin" | "skill"
  onManage?: () => void
  onCreatePlugin?: () => void
  onAddMarketplace?: () => void
  onCreateSkill?: () => void
  onRecordSkill?: () => void
}): JSX.Element {
  const language = useLanguage()
  const refreshAs = () => props.refreshAs ?? "icon"
  const primary = () => {
    if (props.primaryAction === "skill" && props.onCreateSkill) {
      return {
        label: language.t("plugins.menu.createSkill"),
        onSelect: props.onCreateSkill,
      }
    }
    if (props.onCreatePlugin) {
      return {
        label: language.t("plugins.menu.createPlugin"),
        onSelect: props.onCreatePlugin,
      }
    }
    if (props.onCreateSkill) {
      return {
        label: language.t("plugins.menu.createSkill"),
        onSelect: props.onCreateSkill,
      }
    }
    return undefined
  }
  const hasAddMenu = () =>
    Boolean(
      props.onCreatePlugin || props.onAddMarketplace || props.onCreateSkill || props.onRecordSkill,
    )
  return (
    <div class="flex items-center gap-1">
      <Show when={refreshAs() === "icon"}>
        <button
          type="button"
          class={ICON_BTN_CLASS}
          style={NO_DRAG}
          aria-label={language.t("plugins.menu.refresh")}
          onClick={props.onRefresh}
        >
          <Icon name="refresh-cw" size="small" />
        </button>
      </Show>
      <Show when={props.onManage}>
        <button
          type="button"
          class={ICON_BTN_CLASS}
          style={NO_DRAG}
          aria-label={language.t("plugins.action.manage")}
          onClick={() => props.onManage?.()}
        >
          <Icon name="settings-gear" size="small" />
        </button>
      </Show>
      <Show when={hasAddMenu()}>
        <div
          class="h-7 rounded-xl border border-border-weak-base flex items-center overflow-hidden text-text-base"
          style={NO_DRAG}
        >
          {/* 左半：快捷主操作，不展开菜单 */}
          <Show when={primary()}>
            {(item) => (
              <button
                type="button"
                class="flex items-center h-full pl-2 pr-0.5 hover:bg-surface-base"
                style={NO_DRAG}
                aria-label={item().label}
                onClick={() => item().onSelect()}
              >
                <Icon name="plus-small" size="small" class="[&_svg]:[stroke-width:1.6]" />
              </button>
            )}
          </Show>
          {/* 右半：展开下拉菜单 */}
          <DropdownMenu placement="bottom-end" gutter={6}>
            <DropdownMenu.Trigger
              class="flex items-center h-full pl-0.5 pr-2 hover:bg-surface-base"
              style={NO_DRAG}
              aria-label={language.t("plugins.menu.add")}
            >
              <Icon name="chevron-down" size="small" class="text-icon-weak [&_svg]:[stroke-width:1.6]" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="codex-chat-menu min-w-48">
              <Show when={props.onCreatePlugin}>
                <DropdownMenu.Item onSelect={() => props.onCreatePlugin?.()}>
                  <Icon name="at-sign" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>{language.t("plugins.menu.createPlugin")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <Show when={props.onAddMarketplace}>
                <DropdownMenu.Item onSelect={() => props.onAddMarketplace?.()}>
                  <Icon name="plus-small" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>{language.t("plugins.menu.addMarketplace")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <Show when={props.onCreateSkill}>
                <DropdownMenu.Item onSelect={() => props.onCreateSkill?.()}>
                  <Icon name="hexagon" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>{language.t("plugins.menu.createSkill")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              {/* 录制技能：暂时隐藏，待功能就绪后再放出
              <Show when={props.onRecordSkill}>
                <DropdownMenu.Item onSelect={() => props.onRecordSkill?.()}>
                  <Icon name="record-circle" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>{language.t("plugins.menu.recordSkill")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              */}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </Show>
      <Show when={refreshAs() === "menu"}>
        <DropdownMenu placement="bottom-end" gutter={4}>
          <DropdownMenu.Trigger
            class="size-8 rounded-md flex items-center justify-center text-text-base hover:bg-surface-base"
            style={NO_DRAG}
            aria-label={language.t("plugins.menu.more")}
          >
            <Icon name="ellipsis-horizontal" size="small" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="codex-chat-menu min-w-48">
              <DropdownMenu.Item onSelect={props.onRefresh}>
                <Icon name="refresh-cw" size="small" class="text-icon-weak" />
                <DropdownMenu.ItemLabel>{language.t("plugins.menu.refresh")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </Show>
    </div>
  )
}
