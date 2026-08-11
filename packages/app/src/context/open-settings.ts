import type { SettingsTab } from "@/components/dialog-settings"

// 模块级单例，由 layout.tsx 注册，供全局任意入口调用，避免路由跳转。
let openFn: ((tab?: SettingsTab) => void) | null = null

export const setOpenSettingsFn = (fn: (tab?: SettingsTab) => void) => {
  openFn = fn
}

export const openSettingsOverlay = (tab?: SettingsTab) => {
  openFn?.(tab)
}
