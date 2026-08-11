import type { ElectronAPI } from "../preload/types"

interface ImportMetaEnv {
  readonly VITE_WANLAICODE_CHANNEL?: "dev" | "beta" | "prod" | "canary"
  /** @deprecated Use VITE_WANLAICODE_CHANNEL */
  readonly VITE_OPENCODE_CHANNEL?: "dev" | "beta" | "prod" | "canary"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    api: ElectronAPI
    __WANLAICODE__?: {
      deepLinks?: string[]
    }
    /** @deprecated Use __WANLAICODE__ */
    __OPENCODE__?: {
      deepLinks?: string[]
    }
  }
}
