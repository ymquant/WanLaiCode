import { app } from "electron"

export type Channel = "dev" | "beta" | "prod" | "canary"
const raw = import.meta.env.WANLAICODE_CHANNEL ?? import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" || raw === "canary" ? raw : "dev"

export const SETTINGS_STORE = "wanlaicode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
// dev 构建默认开启；packaged 包通过 WANLAICODE_DEBUG_UPDATER=1 单独打开
export const DEBUG_UPDATER = !app.isPackaged || process.env.WANLAICODE_DEBUG_UPDATER === "1"
