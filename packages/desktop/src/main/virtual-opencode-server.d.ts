export type VirtualOpencodeServerModule = {
  Server: {
    listen: (opts: {
      port: number
      hostname: string
      username: string
      password: string
      cors: string[]
    }) => Promise<{
      stop: () => void | Promise<void>
      close: () => void | Promise<void>
    }>
  }
  Log: {
    init: (opts: { level: string }) => Promise<void>
  }
  Database: {
    Client: () => { $client: object }
  }
  JsonMigration: {
    run: (
      db: unknown,
      opts: {
        progress: (event: { current: number; total: number }) => void
      },
    ) => Promise<void>
  }
  bootstrap: unknown
}

export const loadVirtualOpencodeServer: () => Promise<VirtualOpencodeServerModule>
