import { beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import * as realPersistModule from "@/utils/persist"

// snapshot real persist exports BEFORE mock.module replaces the module,
// so the mock factory can forward non-stubbed exports back unchanged.
// bun:test 的 mock.module 是 process 级污染:遗漏的 export 会让后续
// test 文件(如 utils/persist.test.ts)拿到不完整模块。
const realPersistExports = { ...realPersistModule }

type ServerKey = Parameters<typeof import("./terminal").getTerminalServerScope>[1]

type RunInput = { title: string; command: string; cwd: string; os?: "windows" | "linux" | "macos"; terminalID?: string }

let getWorkspaceTerminalCacheKey: (dir: string, scope?: string) => string
let getSessionTerminalCacheKey: (dir: string, sessionID: string | undefined, scope?: string) => string
let getTerminalServerScope: typeof import("./terminal").getTerminalServerScope
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let createWorkspaceTerminalSession: typeof import("./terminal").createWorkspaceTerminalSession

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  mock.module("@/utils/persist", () => ({
    ...realPersistExports,
    persisted: (target: unknown, store: [unknown, unknown]) => {
      if (typeof target === "string" || !target || !("key" in (target as Record<string, unknown>))) {
        return [store[0], store[1], undefined, () => true]
      }
      return [store[0], store[1], undefined, () => true]
    },
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getSessionTerminalCacheKey = mod.getSessionTerminalCacheKey
  getTerminalServerScope = mod.getTerminalServerScope
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
  createWorkspaceTerminalSession = mod.createWorkspaceTerminalSession
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(getWorkspaceTerminalCacheKey("/repo")).toBe("/repo:__workspace__")
  })

  test("can include a server scope", () => {
    expect(getWorkspaceTerminalCacheKey("/repo", "wsl:Debian")).toBe("wsl:Debian:/repo:__workspace__")
  })
})

describe("getSessionTerminalCacheKey", () => {
  test("uses session id alongside directory when provided", () => {
    expect(getSessionTerminalCacheKey("/repo", "session-1")).toBe("/repo:session-1")
  })

  test("falls back to a stable placeholder when session id is absent", () => {
    expect(getSessionTerminalCacheKey("/repo", undefined)).toBe("/repo:__no-session__")
  })

  test("prefixes server scope before directory", () => {
    expect(getSessionTerminalCacheKey("/repo", "session-1", "wsl:Debian")).toBe("wsl:Debian:/repo:session-1")
  })
})

describe("getTerminalServerScope", () => {
  test("preserves local server keys", () => {
    expect(
      getTerminalServerScope(
        { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } },
        "sidecar" as ServerKey,
      ),
    ).toBeUndefined()
    expect(
      getTerminalServerScope(
        { type: "http", http: { url: "http://localhost:4096" } },
        "http://localhost:4096" as ServerKey,
      ),
    ).toBeUndefined()
    expect(
      getTerminalServerScope({ type: "http", http: { url: "http://[::1]:4096" } }, "http://[::1]:4096" as ServerKey),
    ).toBeUndefined()
  })

  test("scopes non-local server keys", () => {
    expect(
      getTerminalServerScope(
        { type: "sidecar", variant: "wsl", distro: "Debian", http: { url: "http://127.0.0.1:4096" } },
        "wsl:Debian" as ServerKey,
      ),
    ).toBe("wsl:Debian" as ServerKey)
    expect(
      getTerminalServerScope(
        { type: "http", http: { url: "https://example.com" } },
        "https://example.com" as ServerKey,
      ),
    ).toBe("https://example.com" as ServerKey)
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })
})

describe("createWorkspaceTerminalSession.run", () => {
  test("new() creates an unlocked blank terminal", async () => {
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })

    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async () => createPromise) as OpencodeClient["pty"]["create"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    session.new()
    createResolve!({ data: { id: "pty-1", title: "Terminal 1" } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(session.all()).toEqual([{ id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true }])
  })

  test("new() can force create a terminal when terminals already exist", async () => {
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async (input?: { title?: string }) => ({
              data: {
                id: input?.title === "Terminal 1" ? "pty-1" : "pty-2",
                title: String(input?.title ?? "Terminal"),
              },
            })) as OpencodeClient["pty"]["create"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.new({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.all()).toEqual([
      { id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true },
      { id: "pty-2", title: "Terminal 2", titleNumber: 2, shellOwnsTitle: true },
    ])
  })

  test("run() creates action terminals with locked titles", async () => {
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async (input?: { title?: string }) => ({
              data: {
                id: "pty-1",
                title: String(input?.title ?? "echo1"),
              },
            })) as OpencodeClient["pty"]["create"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    await session.run({
      title: "echo1",
      command: "echo 111",
      cwd: "/repo",
      os: "linux",
    })

    expect(session.all()).toEqual([{ id: "pty-1", title: "echo1", titleNumber: 1, shellOwnsTitle: false }])
  })

  test("run() keeps adopted blank terminals locked to action title", async () => {
    const createCalls: Array<Record<string, unknown>> = []
    const writeCalls: Array<Record<string, unknown>> = []
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async (input?: {
              directory?: string
              workspace?: string
              command?: string
              args?: string[]
              cwd?: string
              title?: string
              env?: Record<string, string>
            }) => {
              const next = input ?? {}
              createCalls.push(next)
              return {
                data: {
                  id: "pty-1",
                  title: String(next.title ?? "build"),
                },
              }
            }) as OpencodeClient["pty"]["create"],
            write: (async (input: { ptyID: string; data: string }) => {
              writeCalls.push(input)
              return { response: { status: 200 } }
            }) as OpencodeClient["pty"]["write"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    const first = await session.run({
      title: "build",
      command: "bun run build",
      cwd: "/repo",
      os: "linux",
    })
    const second = await session.run({
      title: "build",
      command: "bun run build",
      cwd: "/repo",
      os: "linux",
      terminalID: first,
    })

    expect(first).toBe("pty-1")
    expect(second).toBe("pty-1")
    expect(createCalls).toHaveLength(1)
    expect(writeCalls).toEqual([{ ptyID: "pty-1", data: "bun run build\n" }])
    expect(session.all()).toEqual([{ id: "pty-1", title: "build", titleNumber: 1, shellOwnsTitle: false }])
  })

  test("reused windows terminals submit commands with carriage return", async () => {
    const writeCalls: Array<Record<string, unknown>> = []
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async (input?: { title?: string }) => ({
              data: {
                id: "pty-1",
                title: String(input?.title ?? "echo1"),
              },
            })) as OpencodeClient["pty"]["create"],
            write: (async (input: { ptyID: string; data: string }) => {
              writeCalls.push(input)
              return { response: { status: 200 } }
            }) as OpencodeClient["pty"]["write"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    const terminalID = await session.run({
      title: "echo1",
      command: "echo 111",
      cwd: "/repo",
      os: "windows",
    })
    await session.run({
      title: "echo1",
      command: "echo 111",
      cwd: "/repo",
      os: "windows",
      terminalID,
    })

    expect(writeCalls).toEqual([{ ptyID: "pty-1", data: "echo 111\r" }])
  })

  test("creates new terminal when terminalID is not provided", async () => {
    const createCalls: Array<Record<string, unknown>> = []
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async (input?: {
              directory?: string
              workspace?: string
              command?: string
              args?: string[]
              cwd?: string
              title?: string
              env?: Record<string, string>
            }) => {
              const next = input ?? {}
              createCalls.push(next)
              return {
                data: {
                  id: `pty-${createCalls.length}`,
                  title: String(next.title ?? "action"),
                },
              }
            }) as OpencodeClient["pty"]["create"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    // 第一次运行 echo1
    const first = await session.run({
      title: "echo1",
      command: "echo 111",
      cwd: "/repo",
      os: "linux",
    })

    // 第二次运行 echo2（没有传入 terminalID，应该创建新终端）
    const second = await session.run({
      title: "echo2",
      command: "echo 222",
      cwd: "/repo",
      os: "linux",
    })

    // 每个 action 应该有独立的终端
    expect(first).toBe("pty-1")
    expect(second).toBe("pty-2")
    expect(createCalls).toHaveLength(2)
    expect(session.all()).toEqual([
      { id: "pty-1", title: "echo1", titleNumber: 1, shellOwnsTitle: false },
      { id: "pty-2", title: "echo2", titleNumber: 2, shellOwnsTitle: false },
    ])
  })

  test("new() prevents concurrent terminal creation", async () => {
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })

    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async () => {
              return createPromise
            }) as OpencodeClient["pty"]["create"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    // 第一次调用 new()
    session.new()
    // 第二次调用 new() 应该被忽略（因为第一次还在创建中）
    session.new()
    // 第三次调用 new() 也应该被忽略
    session.new()

    // 此时应该只有一个创建请求
    expect(session.all()).toEqual([])

    // 完成创建
    createResolve!({ data: { id: "pty-1", title: "Terminal 1" } })

    // 等待异步完成
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 应该只有一个终端
    expect(session.all()).toEqual([{ id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true }])
  })

  test("run() adopts existing empty terminal from store", async () => {
    const writeCalls: Array<Record<string, unknown>> = []
    const updateCalls: Array<Record<string, unknown>> = []
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async (input?: { title?: string }) => {
              return {
                data: {
                  id: "pty-1",
                  title: String(input?.title ?? "Terminal 1"),
                },
              }
            }) as OpencodeClient["pty"]["create"],
            update: (async (input: { ptyID: string; title?: string }) => {
              updateCalls.push(input)
              return { response: { status: 200 } }
            }) as OpencodeClient["pty"]["update"],
            write: (async (input: { ptyID: string; data: string }) => {
              writeCalls.push(input)
              return { response: { status: 200 } }
            }) as OpencodeClient["pty"]["write"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const terminalID = await session.run({
      title: "echo1",
      command: "echo 111",
      cwd: "/repo",
      os: "windows",
    })

    expect(terminalID).toBe("pty-1")
    expect(session.all()).toEqual([{ id: "pty-1", title: "echo1", titleNumber: 1, shellOwnsTitle: false }])
    expect(updateCalls).toEqual([{ ptyID: "pty-1", title: "echo1" }])
    expect(writeCalls).toEqual([{ ptyID: "pty-1", data: "echo 111\r" }])
  })

  test("run() adopts pending empty terminal creation", async () => {
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })

    let callCount = 0
    const writeCalls: Array<Record<string, unknown>> = []
    const updateCalls: Array<Record<string, unknown>> = []
    const session = createWorkspaceTerminalSession(
      {
        directory: "/repo",
        url: "http://localhost:4096",
        createClient: () => undefined as never,
        client: {
          pty: {
            create: (async () => {
              callCount++
              if (callCount === 1) return createPromise
              return { data: { id: `pty-${callCount}`, title: `Terminal ${callCount}` } }
            }) as OpencodeClient["pty"]["create"],
            update: (async (input: { ptyID: string; title?: string }) => {
              updateCalls.push(input)
              return { response: { status: 200 } }
            }) as OpencodeClient["pty"]["update"],
            write: (async (input: { ptyID: string; data: string }) => {
              writeCalls.push(input)
              return { response: { status: 200 } }
            }) as OpencodeClient["pty"]["write"],
          } as OpencodeClient["pty"],
        } as OpencodeClient,
        event: {
          on: () => () => undefined,
          listen: () => () => undefined,
          emit: () => undefined,
          clear: () => undefined,
        },
      },
      "/repo",
      undefined,
    )

    session.new()

    const runPromise = session.run({
      title: "build",
      command: "bun run build",
      cwd: "/repo",
      os: "linux",
    })

    createResolve!({ data: { id: "pty-1", title: "Terminal 1" } })

    const terminalID = await runPromise

    expect(terminalID).toBe("pty-1")
    expect(session.all()).toEqual([{ id: "pty-1", title: "build", titleNumber: 1, shellOwnsTitle: false }])
    expect(updateCalls).toEqual([{ ptyID: "pty-1", title: "build" }])
    expect(writeCalls).toEqual([{ ptyID: "pty-1", data: "bun run build\n" }])
  })
})

describe("createWorkspaceTerminalSession dispose race", () => {
  function buildSdkWithCreateAndRemove(options: {
    create: OpencodeClient["pty"]["create"]
    remove: OpencodeClient["pty"]["remove"]
  }) {
    return {
      directory: "/repo",
      url: "http://localhost:4096",
      createClient: () => undefined as never,
      client: {
        pty: {
          create: options.create,
          remove: options.remove,
        } as OpencodeClient["pty"],
      } as OpencodeClient,
      event: {
        on: () => () => undefined,
        listen: () => () => undefined,
        emit: () => undefined,
        clear: () => undefined,
      },
    }
  }

  test("clone() removes the orphaned PTY when disposed after create resolves", async () => {
    // 第一阶段：用一个已 resolve 的 create 建立源终端 pty-1
    const removedIDs: string[] = []
    let cloneCreateResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const cloneCreatePromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      cloneCreateResolve = resolve
    })
    let createCallCount = 0

    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        buildSdkWithCreateAndRemove({
          create: (async () => {
            createCallCount++
            // 第一次 create（new()）立即返回 pty-1；后续 create（clone）挂起在 cloneCreatePromise
            if (createCallCount === 1) return { data: { id: "pty-1", title: "Terminal 1" } }
            return cloneCreatePromise
          }) as OpencodeClient["pty"]["create"],
          remove: (async (input: { ptyID: string }) => {
            removedIDs.push(input.ptyID)
            return { response: { status: 200 } }
          }) as OpencodeClient["pty"]["remove"],
        }),
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    result.session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.session.all()).toEqual([{ id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true }])

    // 触发 clone（内部会走第二次 create，挂起在 cloneCreatePromise）
    const clonePromise = result.session.clone("pty-1")
    // 在 clone 的 create resolve 之前 dispose
    result.dispose()
    cloneCreateResolve!({ data: { id: "pty-cloned-orphan", title: "Terminal 1" } })
    await clonePromise

    // 源终端 pty-1 保留（clone 的 disposed 分支不触碰已有 store），新克隆的 PTY 被移除
    expect(result.session.all()).toEqual([{ id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true }])
    expect(removedIDs).toEqual(["pty-cloned-orphan"])
  })

  test("new() does not write store and removes orphaned PTY when disposed before create resolves", async () => {
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })
    const removedIDs: string[] = []

    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        buildSdkWithCreateAndRemove({
          create: (async () => createPromise) as OpencodeClient["pty"]["create"],
          remove: (async (input: { ptyID: string }) => {
            removedIDs.push(input.ptyID)
            return { response: { status: 200 } }
          }) as OpencodeClient["pty"]["remove"],
        }),
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    result.session.new()
    // 在 create resolve 之前 dispose
    result.dispose()
    createResolve!({ data: { id: "pty-orphan", title: "Terminal 1" } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.session.all()).toEqual([])
    expect(removedIDs).toEqual(["pty-orphan"])
  })

  test("new() removes orphan via the same client captured before directory switch", async () => {
    // 模拟 sdk.client 是随 directory 变化的响应式 getter：create 用旧 client，
    // create resolve 期间项目切换后 sdk.client 指向新 client。
    // remove 必须发回给 create 时捕获的旧 client，否则旧实例的 PTY 成为 orphan。
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })
    const oldRemoveCalls: Array<{ ptyID: string }> = []
    const newRemoveCalls: Array<{ ptyID: string }> = []

    const oldClient = {
      pty: {
        create: (async () => createPromise) as OpencodeClient["pty"]["create"],
        remove: (async (input: { ptyID: string }) => {
          oldRemoveCalls.push(input)
          return { response: { status: 200 } }
        }) as OpencodeClient["pty"]["remove"],
      } as OpencodeClient["pty"],
    } as OpencodeClient
    const newClient = {
      pty: {
        remove: (async (input: { ptyID: string }) => {
          newRemoveCalls.push(input)
          return { response: { status: 200 } }
        }) as OpencodeClient["pty"]["remove"],
      } as OpencodeClient["pty"],
    } as OpencodeClient

    // sdk.client 第一次读取返回 oldClient，new() 调用后切到 newClient
    let clientAccessorCallCount = 0
    const sdk = {
      directory: "/repo",
      url: "http://localhost:4096",
      createClient: () => undefined as never,
      get client() {
        clientAccessorCallCount++
        return clientAccessorCallCount === 1 ? oldClient : newClient
      },
      event: {
        on: () => () => undefined,
        listen: () => () => undefined,
        emit: () => undefined,
        clear: () => undefined,
      },
    }

    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(sdk, "/repo", undefined)
      return { dispose, session }
    })

    result.session.new()
    // create resolve 前 dispose（模拟项目切换触发 dispose + sdk.client 漂移）
    result.dispose()
    createResolve!({ data: { id: "pty-orphan", title: "Terminal 1" } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.session.all()).toEqual([])
    // remove 必须发给旧 client（create 的同一实例），新 client 不应收到
    expect(oldRemoveCalls).toEqual([{ ptyID: "pty-orphan" }])
    expect(newRemoveCalls).toEqual([])
  })

  test("run() does not write store and removes orphaned PTY when disposed before create resolves", async () => {
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })
    const removedIDs: string[] = []

    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        buildSdkWithCreateAndRemove({
          create: (async () => createPromise) as OpencodeClient["pty"]["create"],
          remove: (async (input: { ptyID: string }) => {
            removedIDs.push(input.ptyID)
            return { response: { status: 200 } }
          }) as OpencodeClient["pty"]["remove"],
        }),
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    const runPromise = result.session.run({
      title: "echo1",
      command: "echo 111",
      cwd: "/repo",
      os: "linux",
    })
    // 在 create resolve 之前 dispose
    result.dispose()
    createResolve!({ data: { id: "pty-run-orphan", title: "echo1" } })
    const runID = await runPromise

    expect(runID).toBeUndefined()
    expect(result.session.all()).toEqual([])
    expect(removedIDs).toEqual(["pty-run-orphan"])
  })

  test("run() stops before write when disposed after adopt title update", async () => {
    const writeCalls: Array<Record<string, unknown>> = []
    let updateResolve: (() => void) | undefined
    const updatePromise = new Promise<void>((resolve) => {
      updateResolve = resolve
    })

    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        {
          directory: "/repo",
          url: "http://localhost:4096",
          createClient: () => undefined as never,
          client: {
            pty: {
              create: (async (input?: { title?: string }) => ({
                data: { id: "pty-1", title: String(input?.title ?? "Terminal 1") },
              })) as OpencodeClient["pty"]["create"],
              update: (async (input: { ptyID: string; title?: string }) => {
                await updatePromise
                return { response: { status: 200 } }
              }) as OpencodeClient["pty"]["update"],
              write: (async (input: { ptyID: string; data: string }) => {
                writeCalls.push(input)
                return { response: { status: 200 } }
              }) as OpencodeClient["pty"]["write"],
            } as OpencodeClient["pty"],
          } as OpencodeClient,
          event: {
            on: () => () => undefined,
            listen: () => () => undefined,
            emit: () => undefined,
            clear: () => undefined,
          },
        },
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    // 先 new() 建一个 blank terminal，让 run() 走 adopt 分支
    result.session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const runPromise = result.session.run({
      title: "build",
      command: "bun run build",
      cwd: "/repo",
      os: "linux",
    })

    // update 挂起期间 dispose，再放行 update
    result.dispose()
    updateResolve!()
    const runID = await runPromise

    // adopt 分支 disposed 后返回 existingTerminal.id，但不执行 write
    expect(runID).toBe("pty-1")
    expect(writeCalls).toEqual([])
  })

  test("update() entry guard skips store write when disposed before call", async () => {
    // 覆盖延迟 finalize → bound update 的入口 guard：
    // dispose 后再次调用 session.update，入口的 if (disposed) return 阻止任何 setStore。
    let updateCallCount = 0
    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        {
          directory: "/repo",
          url: "http://localhost:4096",
          createClient: () => undefined as never,
          client: {
            pty: {
              create: (async (input?: { title?: string }) => ({
                data: { id: "pty-1", title: String(input?.title ?? "Terminal 1") },
              })) as OpencodeClient["pty"]["create"],
              update: (async (input: { ptyID: string; title?: string }) => {
                updateCallCount++
                return { response: { status: 200 } }
              }) as OpencodeClient["pty"]["update"],
            } as OpencodeClient["pty"],
          } as OpencodeClient,
          event: {
            on: () => () => undefined,
            listen: () => () => undefined,
            emit: () => undefined,
            clear: () => undefined,
          },
        },
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    result.session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const before = result.session.all().map((item) => ({ ...item }))

    result.dispose()
    result.session.update({ id: "pty-1", title: "changed-after-dispose" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.session.all()).toEqual(before)
    expect(result.session.all()[0]?.title).toBe("Terminal 1")
    expect(updateCallCount).toBe(0)
  })

  test("removeExited does not write store after dispose", async () => {
    // 覆盖 pty.exited 事件回调在 dispose 后不写 store：
    // event.on 捕获回调，dispose 后手动触发 exited，store 应保持不变。
    const captured: Array<(e: { properties: { id: string } }) => void> = []
    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        {
          directory: "/repo",
          url: "http://localhost:4096",
          createClient: () => undefined as never,
          client: {
            pty: {
              create: (async () => ({ data: { id: "pty-1", title: "Terminal 1" } })) as OpencodeClient["pty"]["create"],
            } as OpencodeClient["pty"],
          } as OpencodeClient,
          event: {
            on: ((_event: string, handler: (e: { properties: { id: string } }) => void) => {
              captured.push(handler)
              return () => undefined
            }) as never,
            listen: () => () => undefined,
            emit: () => undefined,
            clear: () => undefined,
          } as never,
        },
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    result.session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.session.all()).toEqual([{ id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true }])

    // dispose 后触发 pty.exited 事件：removeExited 入口的 if (disposed) return 应阻止 splice
    result.dispose()
    expect(captured.length).toBe(1)
    captured[0]!({ properties: { id: "pty-1" } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // store 保留 pty-1，未被移除
    expect(result.session.all()).toEqual([{ id: "pty-1", title: "Terminal 1", titleNumber: 1, shellOwnsTitle: true }])
  })

  test("run() pending-creation adopt stops before write when disposed after pty.update", async () => {
    // 覆盖 pending-creation adopt 分支（走 creationPromise）：update await 后 dispose，write 不执行。
    const writeCalls: Array<Record<string, unknown>> = []
    let updateResolve: (() => void) | undefined
    const updatePromise = new Promise<void>((resolve) => {
      updateResolve = resolve
    })
    let updateStartedResolve: (() => void) | undefined
    const updateStarted = new Promise<void>((resolve) => {
      updateStartedResolve = resolve
    })
    const updateCalls: Array<{ ptyID: string; title?: string }> = []
    let createResolve: ((value: { data: { id: string; title: string } }) => void) | undefined
    const createPromise = new Promise<{ data: { id: string; title: string } }>((resolve) => {
      createResolve = resolve
    })

    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        {
          directory: "/repo",
          url: "http://localhost:4096",
          createClient: () => undefined as never,
          client: {
            pty: {
              create: (async () => createPromise) as OpencodeClient["pty"]["create"],
              update: (async (input: { ptyID: string; title?: string }) => {
                updateCalls.push(input)
                updateStartedResolve!()
                await updatePromise
                return { response: { status: 200 } }
              }) as OpencodeClient["pty"]["update"],
              write: (async (input: { ptyID: string; data: string }) => {
                writeCalls.push(input)
                return { response: { status: 200 } }
              }) as OpencodeClient["pty"]["write"],
            } as OpencodeClient["pty"],
          } as OpencodeClient,
          event: {
            on: () => () => undefined,
            listen: () => () => undefined,
            emit: () => undefined,
            clear: () => undefined,
          },
        },
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    // new() 启动 pending creation（挂起在 createPromise）
    result.session.new()
    // run() 会 await creationPromise（pending-creation adopt 分支）
    const runPromise = result.session.run({
      title: "build",
      command: "bun run build",
      cwd: "/repo",
      os: "linux",
    })
    createResolve!({ data: { id: "pty-1", title: "Terminal 1" } })
    await updateStarted
    expect(updateCalls).toEqual([{ ptyID: "pty-1", title: "build" }])

    result.dispose()
    updateResolve!()
    const runID = await runPromise

    expect(runID).toBe("pty-1")
    expect(writeCalls).toEqual([])
  })
})

describe("createWorkspaceTerminalSession update error contract", () => {
  test("NotFoundError keeps optimistic update without rollback", async () => {
    // 非 dispose 场景下 PTY 404：终端组件会通过 gone() 走 onConnectError 恢复，
    // update 不回滚乐观更新、也不报错，避免与组件层恢复流程重复处理造成闪烁。
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined)
    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        {
          directory: "/repo",
          url: "http://localhost:4096",
          createClient: () => undefined as never,
          client: {
            pty: {
              create: (async (input?: { title?: string }) => ({
                data: { id: "pty-1", title: String(input?.title ?? "Terminal 1") },
              })) as OpencodeClient["pty"]["create"],
              update: (async () => {
                const error = new Error("not found")
                error.name = "NotFoundError"
                throw error
              }) as unknown as OpencodeClient["pty"]["update"],
            } as OpencodeClient["pty"],
          } as OpencodeClient,
          event: {
            on: () => () => undefined,
            listen: () => () => undefined,
            emit: () => undefined,
            clear: () => undefined,
          },
        },
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    result.session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 乐观更新 title 为 "renamed"
    result.session.update({ id: "pty-1", title: "renamed" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.session.all()).toEqual([{ id: "pty-1", title: "renamed", titleNumber: 1, shellOwnsTitle: true }])
    expect(consoleError).not.toHaveBeenCalled()
    result.dispose()
    consoleError.mockRestore()
  })

  test("ordinary update errors are logged", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined)
    const error = new Error("update failed")
    const result = createRoot((dispose) => {
      const session = createWorkspaceTerminalSession(
        {
          directory: "/repo",
          url: "http://localhost:4096",
          createClient: () => undefined as never,
          client: {
            pty: {
              create: (async (input?: { title?: string }) => ({
                data: { id: "pty-1", title: String(input?.title ?? "Terminal 1") },
              })) as OpencodeClient["pty"]["create"],
              update: (async () => {
                throw error
              }) as unknown as OpencodeClient["pty"]["update"],
            } as OpencodeClient["pty"],
          } as OpencodeClient,
          event: {
            on: () => () => undefined,
            listen: () => () => undefined,
            emit: () => undefined,
            clear: () => undefined,
          },
        },
        "/repo",
        undefined,
      )
      return { dispose, session }
    })

    result.session.new()
    await new Promise((resolve) => setTimeout(resolve, 0))
    result.session.update({ id: "pty-1", title: "renamed" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(consoleError).toHaveBeenCalledWith("Failed to update terminal", error)
    result.dispose()
    consoleError.mockRestore()
  })
})
