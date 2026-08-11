import { createSignal } from "solid-js"

// session 是否为前台激活状态（非 settings overlay 期间）。
// 由 layout.tsx 的 settingsOverlay 信号维护，settings 打开时为 false。
export const [sessionRouteActive, setSessionRouteActive] = createSignal(true)
