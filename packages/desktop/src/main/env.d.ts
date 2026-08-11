interface ImportMetaEnv {
  readonly WANLAICODE_CHANNEL: string
  /** @deprecated Use WANLAICODE_CHANNEL */
  readonly OPENCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export type Listener = {
      close: () => void | Promise<void>
    }
    export const listen: (opts: {
      port: number
      hostname: string
      username: string
      password: string
      cors: string[]
    }) => Promise<Listener>
  }

  export namespace Log {
    export const init: (opts: { level: string }) => Promise<void>
  }

  export namespace Database {
    export const Client: () => { $client: unknown }
  }

  export namespace JsonMigration {
    export type Progress = {
      current: number
      total: number
    }
    export const run: (
      db: unknown,
      opts: {
        progress: (event: Progress) => void
      },
    ) => Promise<void>
  }

  export const bootstrap: unknown
}
