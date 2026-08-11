import { Show, type JSX } from "solid-js"
import { createQuery } from "@tanstack/solid-query"
import { Mark } from "@opencode-ai/ui/logo"
import { getBrand } from "@opencode-ai/brand"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { remoteControlStatusQuery } from "@/context/remote-control"
import { RemoteControlPresenceMenuItem } from "@/components/remote-control-presence"
import { AccountPopover } from "./account-popover"

// Region 4：footer 左 设置与手机状态入口 / 右 万来品牌入口 (跳转用户中心)
export const SidebarFooter = (props: {
  onOpenSettings: () => void
  onAccountPopoverOpenChange?: (open: boolean) => void
}): JSX.Element => {
  const language = useLanguage()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()

  // 底部入口持续复用远控状态查询，账号弹层关闭时也能及时显示在线/离线点。
  const remoteControlStatus = createQuery(() => ({
    ...remoteControlStatusQuery(globalSDK.client),
    enabled: platform.platform === "desktop",
  }))

  const onOpenUserCenter = async () => {
    const status = await globalSDK.client.wanlaicodeUserCenter.status()
    if (status.data?.site_url) platform.openLink(status.data.site_url)
  }

  return (
    <div class="flex items-center justify-between h-12 px-3 ">
      {/* 设置与手机入口保持 4px 紧凑间距，让手机状态更贴近设置但不发生粘连。 */}
      <div class="flex items-center gap-1">
        <AccountPopover
          onOpenSettings={props.onOpenSettings}
          onOpenChange={props.onAccountPopoverOpenChange}
          trigger={
            <button
              type="button"
              class="flex items-center gap-2 px-3 py-1.5 rounded-md text-text-strong whitespace-nowrap shrink-0 hover:bg-surface-base-hover"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="shrink-0">
                <path
                  d="M7.62516 4.46094L5.05225 3.86719L3.86475 5.05469L4.4585 7.6276L2.0835 9.21094V10.7943L4.4585 12.3776L3.86475 14.9505L5.05225 16.138L7.62516 15.5443L9.2085 17.9193H10.7918L12.3752 15.5443L14.9481 16.138L16.1356 14.9505L15.5418 12.3776L17.9168 10.7943V9.21094L15.5418 7.6276L16.1356 5.05469L14.9481 3.86719L12.3752 4.46094L10.7918 2.08594H9.2085L7.62516 4.46094Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
                <path
                  d="M12.5002 10.0026C12.5002 11.3833 11.3809 12.5026 10.0002 12.5026C8.61945 12.5026 7.50016 11.3833 7.50016 10.0026C7.50016 8.62189 8.61945 7.5026 10.0002 7.5026C11.3809 7.5026 12.5002 8.62189 12.5002 10.0026Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
              </svg>
              <span class="text-[13px] font-medium">{language.t("sidebar.footer.settings")}</span>
            </button>
          }
        />
        <Show when={platform.platform === "desktop"}>
          {/* 手机入口紧邻设置按钮；不复用普通设置回调，点击后直接进入手机与设备页。 */}
          {/* 默认保持透明，只在悬浮或触摸反馈时使用与设置按钮相同的底色。 */}
          <RemoteControlPresenceMenuItem
            compact
            class="flex size-8 shrink-0 items-center justify-center rounded-full text-text-base hover:bg-surface-base-hover"
            connections={remoteControlStatus.data?.connections ?? []}
          />
        </Show>
      </div>
      <button
        type="button"
        onClick={() => void onOpenUserCenter()}
        class="flex items-center gap-0.5 px-1 py-1 rounded-full whitespace-nowrap shrink-0 hover:bg-surface-base-hover"
      >
        <Show
          when={getBrand().ui?.footerShowUpgrade}
          fallback={
            <>
              <Mark class="w-[18px] h-[18px] shrink-0" />
              <span class="text-[13px] font-medium ">{language.t("sidebar.footer.brand")}</span>
            </>
          }
        >
          <span class="text-[13px] font-medium">{language.t("sidebar.footer.upgrade")}</span>
        </Show>
      </button>
    </div>
  )
}
