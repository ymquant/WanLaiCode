interface ImportMetaEnv {
  readonly VITE_WANLAICODE_SERVER_HOST?: string
  readonly VITE_WANLAICODE_SERVER_PORT?: string
  readonly VITE_WANLAICODE_CHANNEL?: "dev" | "beta" | "prod" | "canary"
  /** @deprecated Use VITE_WANLAICODE_* */
  readonly VITE_OPENCODE_SERVER_HOST: string
  /** @deprecated Use VITE_WANLAICODE_* */
  readonly VITE_OPENCODE_SERVER_PORT: string
  /** @deprecated Use VITE_WANLAICODE_* */
  readonly VITE_OPENCODE_CHANNEL?: "dev" | "beta" | "prod" | "canary"

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
