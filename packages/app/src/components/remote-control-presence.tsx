import { For, Show, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { openSettingsOverlay } from "@/context/open-settings"
import { remoteControlPhonePresence } from "@/context/remote-control"

type RemoteControlConnection = {
  name: string
  online: boolean
  platform?: string
  last_connected_at?: string
}

export const RemoteControlPresenceMenuItem: Component<{
  connections: readonly RemoteControlConnection[]
  class?: string
  compact?: boolean
  onOpenSettings?: () => void
}> = (props) => {
  const language = useLanguage()
  const presence = () => remoteControlPhonePresence(props.connections)
  const online = () => presence() === "online"
  const openSettings = () => (props.onOpenSettings ?? (() => openSettingsOverlay("remoteControl")))()

  return (
    <Tooltip
      // 底部栏入口的提示向上展开，避免贴到窗口右侧内容区域。
      placement="top"
      openDelay={180}
      contentClass="min-w-52 p-2"
      value={
        <div class="flex min-w-48 flex-col gap-2">
          <div class="text-12-medium text-text-strong">{language.t("settings.remote.title")}</div>
          <Show
            when={props.connections.length > 0}
            fallback={<div class="text-12-regular text-text-weak">{language.t("settings.remote.devices.empty")}</div>}
          >
            <div class="flex flex-col gap-1.5">
              <For each={props.connections}>
                {(connection) => (
                  <div class="flex min-w-0 items-center justify-between gap-3">
                    <span class="min-w-0 truncate text-12-regular text-text-base">{connection.name}</span>
                    <span
                      class="flex shrink-0 items-center gap-1 text-12-regular"
                      classList={{
                        "text-text-base": connection.online,
                        "text-text-weak": !connection.online,
                      }}
                    >
                      <span
                        class="size-1.5 rounded-full"
                        classList={{
                          "bg-icon-success-base": connection.online,
                          "bg-icon-weak-base": !connection.online,
                        }}
                        aria-hidden="true"
                      />
                      {connection.online
                        ? language.t("settings.remote.device.online")
                        : language.t("settings.remote.device.offline")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      }
    >
      <button
        type="button"
        class={props.class}
        data-component="remote-control-presence"
        data-state={presence()}
        aria-label={language.t("settings.remote.title")}
        onClick={openSettings}
        style={{ "-webkit-app-region": "no-drag" } as Record<string, string>}
      >
        {/* 手机图标放大一级；只有曾连接过设备时才显示灰色离线点或绿色在线点。 */}
        <span class="relative flex size-5 items-center justify-center">
          <Icon name="smartphone" size="normal" />
          <Show when={presence() !== "hidden"}>
            <span
              class="absolute -right-1 -top-1 size-1.5 rounded-full border border-border-weak-base"
              classList={{
                "bg-icon-success-base": online(),
                "bg-icon-weak-base": !online(),
              }}
              aria-hidden="true"
            />
          </Show>
        </span>
        <Show when={!props.compact}>
          <span class="flex-1 truncate">{language.t("settings.remote.title")}</span>
        </Show>
      </button>
    </Tooltip>
  )
}
