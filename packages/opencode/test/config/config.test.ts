import { test, expect, describe, mock, afterEach, beforeEach } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { commitGlobalUpdate, Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Env } from "../../src/env"
import { provideTestInstance, provideTmpdirInstance } from "../fixture/fixture"
import { tmpdir } from "../fixture/fixture"
import { InstanceRuntime } from "@/project/instance-runtime"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
import path from "path"
import fs from "fs/promises"
import { writeFileSync } from "fs"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { ProjectID } from "../../src/project/schema"
import { Filesystem } from "@/util/filesystem"
import { ConfigPlugin } from "@/config/plugin"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionMode } from "../../src/permission/mode"

test("permission mode defaults to auto_review when omitted", () => {
  expect(PermissionMode.resolve(undefined)).toBe("auto_review")
})

test("permission mode reference defaults to auto_review", () => {
  expect(
    Effect.runSync(
      Effect.gen(function* () {
        return yield* PermissionMode.Ref
      }),
    ),
  ).toBe("auto_review")
})

test("permission mode accepts all three product profiles", () => {
  expect(PermissionMode.Info.zod.parse("ask")).toBe("ask")
  expect(PermissionMode.Info.zod.parse("auto_review")).toBe("auto_review")
  expect(PermissionMode.Info.zod.parse("full_access")).toBe("full_access")
})

test("approval review main-model fallback accepts an explicit global switch", () => {
  expect(Config.Info.zod.parse({ approval_review_fallback_to_main_model: false })).toMatchObject({
    approval_review_fallback_to_main_model: false,
  })
})

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const testFlock = EffectFlock.defaultLayer

const noopNpm = Layer.mock(Npm.Service)({
  install: () => Effect.void,
  add: () => Effect.die("not implemented"),
  which: () => Effect.succeed(Option.none()),
})

const layer = Config.layer.pipe(
  Layer.provide(testFlock),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
  Layer.provide(noopNpm),
)

const it = testEffect(layer)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
const loadGlobal = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.getGlobal()).pipe(Effect.scoped, Effect.provide(layer)))
const loadGlobalMcpRaw = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.getGlobalMcpRaw()).pipe(Effect.scoped, Effect.provide(layer)))
const save = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.update(config)).pipe(Effect.scoped, Effect.provide(layer)))
const saveGlobal = (config: Config.Info) =>
  Effect.runPromise(
    Config.Service.use((svc) => svc.updateGlobal(config)).pipe(
      Effect.map((result) => result.info),
      Effect.scoped,
      Effect.provide(layer),
    ),
  )
const clear = async (wait = false) => {
  await Effect.runPromise(Config.Service.use((svc) => svc.invalidate()).pipe(Effect.scoped, Effect.provide(layer)))
  if (wait) await InstanceRuntime.disposeAllInstances()
}
const listDirs = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.directories()).pipe(Effect.scoped, Effect.provide(layer)))
const ready = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.waitForDependencies()).pipe(Effect.scoped, Effect.provide(layer)))

// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = (process.env.WANLAICODE_TEST_MANAGED_CONFIG_DIR ??
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR)!

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  await clear(true)
})

async function writeManagedSettings(settings: object, filename = "wanlaicode.json") {
  await fs.mkdir(managedConfigDir, { recursive: true })
  await Filesystem.write(path.join(managedConfigDir, filename), JSON.stringify(settings))
}

async function writeConfig(dir: string, config: object, name = "wanlaicode.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

async function check(map: (dir: string) => string) {
  if (process.platform !== "win32") return
  await using globalTmp = await tmpdir()
  await using tmp = await tmpdir({ git: true, config: { snapshot: true } })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = globalTmp.path
  await clear()
  try {
    await writeConfig(globalTmp.path, {
      $schema: "https://opencode.ai/config.json",
      snapshot: false,
    })
    await WithInstance.provide({
      directory: map(tmp.path),
      fn: async () => {
        const cfg = await load()
        expect(cfg.snapshot).toBe(true)
        expect(Instance.directory).toBe(Filesystem.resolve(tmp.path))
        expect(Instance.project.id).not.toBe(ProjectID.global)
      },
    })
  } finally {
    await InstanceRuntime.disposeAllInstances()
    ;(Global.Path as { config: string }).config = prev
    await clear()
  }
}

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.username).toBeDefined()
    },
  })
})

test("getGlobalMcpRaw preserves env references without exposing resolved secrets", async () => {
  const original = process.env.MCP_MANAGEMENT_SECRET
  await using tmp = await tmpdir()
  const previousConfigDir = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path
  process.env.MCP_MANAGEMENT_SECRET = "resolved-secret"

  try {
    await Bun.write(
      path.join(tmp.path, "wanlaicode.json"),
      JSON.stringify({
        mcp: {
          local: {
            type: "remote",
            url: "https://mcp.example.com/local",
          },
          remote: {
            type: "remote",
            url: "https://mcp.example.com/old",
          },
        },
      }),
    )
    await Bun.write(
      path.join(tmp.path, "wanlaicode.jsonc"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer {env:MCP_MANAGEMENT_SECRET}" },
          },
        },
      }),
    )
    await clear(true)

    expect((await loadGlobal()).mcp?.remote).toMatchObject({
      headers: { Authorization: "Bearer resolved-secret" },
    })
    const mcp = await loadGlobalMcpRaw()
    expect(mcp.local).toMatchObject({ url: "https://mcp.example.com/local" })
    expect(mcp.remote).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer {env:MCP_MANAGEMENT_SECRET}" },
    })
  } finally {
    ;(Global.Path as { config: string }).config = previousConfigDir
    if (original === undefined) delete process.env.MCP_MANAGEMENT_SECRET
    else process.env.MCP_MANAGEMENT_SECRET = original
    await clear(true)
  }
})

test("getGlobalMcpRaw reads legacy MCP without migrating the config file", async () => {
  await using tmp = await tmpdir()
  const previousConfigDir = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path

  try {
    await Bun.write(
      path.join(tmp.path, "wanlaicode.jsonc"),
      JSON.stringify({
        mcp: {
          legacy: {
            type: "remote",
            url: "https://mcp.example.com/jsonc",
          },
        },
      }),
    )
    const legacy = path.join(tmp.path, "config")
    await Bun.write(
      legacy,
      [
        "[mcp.legacy]",
        'type = "remote"',
        'url = "https://mcp.example.com/legacy"',
        "",
        "[mcp.legacy.headers]",
        'Authorization = "Bearer {env:MCP_MANAGEMENT_SECRET}"',
      ].join("\n"),
    )
    await clear(true)

    expect((await loadGlobalMcpRaw()).legacy).toMatchObject({
      url: "https://mcp.example.com/legacy",
      headers: { Authorization: "Bearer {env:MCP_MANAGEMENT_SECRET}" },
    })
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "config.json")).exists()).toBe(false)
  } finally {
    ;(Global.Path as { config: string }).config = previousConfigDir
    await clear(true)
  }
})

test("updateGlobal removes an MCP definition from every JSON config source", async () => {
  await using tmp = await tmpdir()
  const previousConfigDir = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path

  try {
    const files = [
      ["config.json", { username: "low-source" }],
      ["wanlaicode.json", { shell: "middle-source" }],
      ["wanlaicode.jsonc", { model: "high/source" }],
    ] as const
    for (const [name, marker] of files) {
      await Bun.write(
        path.join(tmp.path, name),
        `${name.endsWith(".jsonc") ? "// keep source comment\n" : ""}${JSON.stringify({
          ...marker,
          mcp: { shared: { type: "local", command: ["echo", name] } },
        })}`,
      )
    }
    await clear(true)

    await saveGlobal({ mcp: { shared: undefined } } as unknown as Config.Info)

    expect((await loadGlobalMcpRaw()).shared).toBeUndefined()
    for (const [name, marker] of files) {
      const source = await Bun.file(path.join(tmp.path, name)).text()
      expect(source).not.toContain('"shared"')
      expect(source).toContain(`"${Object.keys(marker)[0]}"`)
      if (name.endsWith(".jsonc")) expect(source.startsWith("// keep source comment\n")).toBe(true)
    }
  } finally {
    ;(Global.Path as { config: string }).config = previousConfigDir
    await clear(true)
  }
})

test("updateGlobal rolls back every source when a later MCP write fails", async () => {
  await using tmp = await tmpdir()
  const previousConfigDir = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path
  const originals = new Map<string, string>()
  const delegate = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* AppFileSystem.Service
    }).pipe(Effect.provide(AppFileSystem.defaultLayer)),
  )
  let releaseFirst!: () => void
  const firstWritten = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let injected = false
  const touched: string[] = []
  const failingFileSystem = AppFileSystem.Service.of({
    ...delegate,
    writeFileString: (file, data, options) => {
      touched.push(file)
      if (path.basename(file) === "config.json") {
        return delegate.writeFileString(file, data, options).pipe(Effect.tap(() => Effect.sync(releaseFirst)))
      }
      if (path.basename(file) === "wanlaicode.json" && !injected) {
        injected = true
        return Effect.gen(function* () {
          yield* Effect.promise(() => firstWritten)
          return yield* Effect.die(new Error("injected write failure"))
        })
      }
      return delegate.writeFileString(file, data, options)
    },
  })
  const failingLayer = Config.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        testFlock,
        Layer.succeed(AppFileSystem.Service, failingFileSystem),
        Env.defaultLayer,
        emptyAuth,
        emptyAccount,
        noopNpm,
      ).pipe(Layer.provideMerge(infra)),
    ),
  )

  try {
    for (const [name, marker] of [
      ["config.json", { username: "low" }],
      ["wanlaicode.json", { shell: "middle" }],
      ["wanlaicode.jsonc", { model: "high/model" }],
    ] as const) {
      const source = `${name.endsWith(".jsonc") ? "// keep rollback comment\n" : ""}${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...marker,
        mcp: { shared: { type: "local", command: ["echo", name] } },
      })}`
      originals.set(name, source)
      await Bun.write(path.join(tmp.path, name), source)
    }
    const exit = await Effect.runPromiseExit(
      Config.Service.use((service) =>
        service.updateGlobal({ mcp: { shared: undefined } } as unknown as Config.Info),
      ).pipe(Effect.scoped, Effect.provide(failingLayer)),
    )

    expect({ injected, touched }).toMatchObject({ injected: true })
    expect(touched.length).toBeGreaterThan(2)
    expect(exit._tag).toBe("Failure")
    for (const [name, source] of originals) {
      expect(await Bun.file(path.join(tmp.path, name)).text()).toBe(source)
    }
  } finally {
    ;(Global.Path as { config: string }).config = previousConfigDir
    await clear(true)
  }
})

test("updateGlobal rolls back a file that reaches disk before external interruption", async () => {
  const previousConfigDir = Global.Path.config
  const delegate = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* AppFileSystem.Service
    }).pipe(Effect.provide(AppFileSystem.defaultLayer)),
  )

  try {
    for (const original of [
      undefined,
      '// keep interrupted rollback comment\n{"mcp":{"shared":{"type":"local","command":["echo","before"]}}}',
    ]) {
      await using tmp = await tmpdir()
      ;(Global.Path as { config: string }).config = tmp.path
      const file = path.join(tmp.path, "wanlaicode.jsonc")
      if (original !== undefined) await Bun.write(file, original)

      let releaseWrite!: () => void
      const holdWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      let markWritten!: () => void
      const written = new Promise<void>((resolve) => {
        markWritten = resolve
      })
      let intercepted = false
      const interruptibleFileSystem = AppFileSystem.Service.of({
        ...delegate,
        writeFileString: (target, data, options) => {
          if (target !== file || intercepted) return delegate.writeFileString(target, data, options)
          intercepted = true
          writeFileSync(target, data)
          markWritten()
          return Effect.promise(() => holdWrite)
        },
      })
      const interruptibleLayer = Config.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            testFlock,
            Layer.succeed(AppFileSystem.Service, interruptibleFileSystem),
            Env.defaultLayer,
            emptyAuth,
            emptyAccount,
            noopNpm,
          ).pipe(Layer.provideMerge(infra)),
        ),
      )

      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* Config.Service
          const update = yield* Effect.forkScoped(
            service.updateGlobal({
              mcp: { shared: { type: "local", command: ["echo", "after"] } },
            } as Config.Info),
          )
          yield* Effect.promise(() => written)
          setTimeout(releaseWrite, 0)
          yield* Fiber.interrupt(update)
          return yield* Fiber.await(update)
        }).pipe(Effect.scoped, Effect.provide(interruptibleLayer)),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(await Bun.file(file).exists()).toBe(original !== undefined)
      if (original !== undefined) expect(await Bun.file(file).text()).toBe(original)
    }
  } finally {
    ;(Global.Path as { config: string }).config = previousConfigDir
    await clear(true)
  }
})

test("global update transaction rolls back disk and cache state when invalidation fails", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "transaction.json")
  const before = '{"value":"before"}'
  const after = '{"value":"after"}'

  const faults: Array<() => Effect.Effect<never, Error>> = [
    () => Effect.fail(new Error("invalidate error")),
    () => Effect.die(new Error("invalidate defect")),
    () => Effect.interrupt,
  ]
  for (const fault of faults) {
    await Bun.write(file, before)
    let cache: string | undefined = before
    let invalidations = 0
    const exit = await Effect.runPromiseExit(
      commitGlobalUpdate(
        [
          {
            apply: Effect.promise(() => Bun.write(file, after).then(() => undefined)),
            rollback: Effect.promise(() => Bun.write(file, before).then(() => undefined)),
          },
        ],
        Effect.gen(function* () {
          invalidations += 1
          if (invalidations === 1) return yield* fault()
          cache = undefined
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Bun.file(file).text()).toBe(before)
    expect(cache ?? (await Bun.file(file).text())).toBe(before)
    expect(invalidations).toBe(2)
  }
})

test("global update transaction invalidates exactly once after a successful commit", async () => {
  let disk = "before"
  let cache: string | undefined = "before"
  let invalidations = 0

  await Effect.runPromise(
    commitGlobalUpdate(
      [
        {
          apply: Effect.sync(() => {
            disk = "after"
          }),
          rollback: Effect.sync(() => {
            disk = "before"
          }),
        },
      ],
      Effect.sync(() => {
        invalidations += 1
        cache = undefined
      }),
    ),
  )

  expect(disk).toBe("after")
  expect(cache).toBeUndefined()
  expect(invalidations).toBe(1)
})

test("preserves disjoint concurrent global config updates", async () => {
  await Promise.all([
    saveGlobal({ instruction_import: { agents_md: false } }),
    saveGlobal({ rules: [{ id: "tests", title: "Tests", content: "Run focused tests.", enabled: true }] }),
  ])

  const config = await saveGlobal({})
  expect(config.instruction_import?.agents_md).toBe(false)
  expect(config.rules).toEqual([{ id: "tests", title: "Tests", content: "Run focused tests.", enabled: true }])
})

test("loads JSON config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        model: "test/model",
        username: "testuser",
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("loads shell config field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        shell: "bash",
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.shell).toBe("bash")
    },
  })
})

test("updates config and preserves empty shell sentinel", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(
        dir,
        {
          $schema: "https://opencode.ai/config.json",
          shell: "bash",
        },
        "config.json",
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await save({ shell: "" })

      const writtenConfig = await Filesystem.readJson<{ shell?: string }>(path.join(tmp.path, "config.json"))
      expect(writtenConfig.shell).toBe("")
    },
  })
})

test("updates global config and omits empty shell key in json", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        shell: "bash",
      })
    },
  })

  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path
  await clear(true)

  try {
    await saveGlobal({ shell: "" })

    const writtenConfig = await Filesystem.readJson<{ shell?: string }>(path.join(tmp.path, "wanlaicode.json"))
    expect("shell" in writtenConfig).toBe(false)
  } finally {
    ;(Global.Path as { config: string }).config = prev
    await clear(true)
  }
})

test("updates global config and omits empty shell key in jsonc", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.jsonc"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          shell: "bash",
          model: "test/model",
        }),
      )
    },
  })

  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path
  await clear(true)

  try {
    await saveGlobal({ shell: "" })

    const file = path.join(tmp.path, "wanlaicode.jsonc")
    const writtenConfig = await Filesystem.readText(file)
    const parsed = ConfigParse.schema(Config.Info.zod, ConfigParse.jsonc(writtenConfig, file), file)
    expect(writtenConfig).not.toContain('"shell"')
    expect(parsed.shell).toBeUndefined()
    expect(parsed.model).toBe("test/model")
  } finally {
    ;(Global.Path as { config: string }).config = prev
    await clear(true)
  }
})

test("updates global proxy config and deletes empty proxy fields", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        shell: "bash",
        proxy: {
          mode: "manual",
          url: "http://127.0.0.1:7890",
          http_url: "http://127.0.0.1:7891",
          https_url: "http://127.0.0.1:7892",
          no_proxy: "example.com",
        },
      })
    },
  })

  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = tmp.path
  await clear(true)

  try {
    await saveGlobal({
      proxy: {
        mode: "manual",
        url: "",
        http_url: "",
        https_url: " http://127.0.0.1:7893 ",
        no_proxy: "",
      },
    })

    const writtenConfig = await Filesystem.readJson<{
      shell?: string
      proxy?: Record<string, unknown>
    }>(path.join(tmp.path, "wanlaicode.json"))
    expect(writtenConfig.shell).toBe("bash")
    expect(writtenConfig.proxy).toEqual({
      mode: "manual",
      https_url: "http://127.0.0.1:7893",
    })
  } finally {
    ;(Global.Path as { config: string }).config = prev
    await clear(true)
  }
})

test("loads formatter boolean config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        formatter: true,
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.formatter).toBe(true)
    },
  })
})

test("loads lsp boolean config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        lsp: true,
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.lsp).toBe(true)
    },
  })
})

test("loads project config from Git Bash and MSYS2 paths on Windows", async () => {
  // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/${drive}${rest}`
  })
})

test("loads project config from Cygwin paths on Windows", async () => {
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/cygdrive/${drive}${rest}`
  })
})

test("ignores legacy tui keys in opencode config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        model: "test/model",
        theme: "legacy",
        tui: { scroll_speed: 4 },
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("test/model")
      expect((config as Record<string, unknown>).theme).toBeUndefined()
      expect((config as Record<string, unknown>).tui).toBeUndefined()
    },
  })
})

test("loads JSONC config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.jsonc"),
        `{
        // This is a comment
        "$schema": "https://opencode.ai/config.json",
        "model": "test/model",
        "username": "testuser"
      }`,
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("jsonc overrides json in the same directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(
        dir,
        {
          $schema: "https://opencode.ai/config.json",
          model: "base",
          username: "base",
        },
        "wanlaicode.jsonc",
      )
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        model: "override",
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("base")
      expect(config.username).toBe("base")
    },
  })
})

test("handles environment variable substitution", async () => {
  const originalEnv = process.env["TEST_VAR"]
  process.env["TEST_VAR"] = "test-user"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          username: "{env:TEST_VAR}",
        })
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await load()
        expect(config.username).toBe("test-user")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["TEST_VAR"] = originalEnv
    } else {
      delete process.env["TEST_VAR"]
    }
  }
})

test("preserves env variables when adding $schema to config", async () => {
  const originalEnv = process.env["PRESERVE_VAR"]
  process.env["PRESERVE_VAR"] = "secret_value"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Config without $schema - should trigger auto-add
        await Filesystem.write(
          path.join(dir, "wanlaicode.json"),
          JSON.stringify({
            username: "{env:PRESERVE_VAR}",
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await load()
        expect(config.username).toBe("secret_value")

        // Read the file to verify the env variable was preserved
        const content = await Filesystem.readText(path.join(tmp.path, "wanlaicode.json"))
        expect(content).toContain("{env:PRESERVE_VAR}")
        expect(content).not.toContain("secret_value")
        expect(content).toContain("$schema")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["PRESERVE_VAR"] = originalEnv
    } else {
      delete process.env["PRESERVE_VAR"]
    }
  }
})

test("resolves env templates in account config with account token", async () => {
  const originalControlToken = process.env["WANLAICODE_CONSOLE_TOKEN"] ?? process.env["OPENCODE_CONSOLE_TOKEN"]

  const fakeAccount = Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some({
          id: AccountID.make("account-1"),
          email: "user@example.com",
          url: "https://control.example.com",
          active_org_id: OrgID.make("org-1"),
        }),
      ),
    activeOrg: () =>
      Effect.succeed(
        Option.some({
          account: {
            id: AccountID.make("account-1"),
            email: "user@example.com",
            url: "https://control.example.com",
            active_org_id: OrgID.make("org-1"),
          },
          org: {
            id: OrgID.make("org-1"),
            name: "Example Org",
          },
        }),
      ),
    config: () =>
      Effect.succeed(
        Option.some({
          provider: { wanlaicode: { options: { apiKey: "{env:WANLAICODE_CONSOLE_TOKEN}" } } },
        }),
      ),
    token: () => Effect.succeed(Option.some(AccessToken.make("st_test_token"))),
  })

  const layer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(emptyAuth),
    Layer.provide(fakeAccount),
    Layer.provideMerge(infra),
    Layer.provide(noopNpm),
  )

  try {
    await provideTmpdirInstance(() =>
      Config.Service.use((svc) =>
        Effect.gen(function* () {
          const config = yield* svc.get()
          expect(config.provider?.["wanlaicode"]?.options?.apiKey).toBe("st_test_token")
        }),
      ),
    ).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  } finally {
    if (originalControlToken !== undefined) {
      process.env["WANLAICODE_CONSOLE_TOKEN"] = originalControlToken
    } else {
      delete process.env["WANLAICODE_CONSOLE_TOKEN"]
      delete process.env["OPENCODE_CONSOLE_TOKEN"]
    }
  }
})

test("handles file inclusion substitution", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "included.txt"), "test-user")
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        username: "{file:included.txt}",
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.username).toBe("test-user")
    },
  })
})

test("handles file inclusion with replacement tokens", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "included.md"), "const out = await Bun.$`echo hi`")
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        username: "{file:included.md}",
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.username).toBe("const out = await Bun.$`echo hi`")
    },
  })
})

test("validates config schema and throws on invalid fields", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        invalid_field: "should cause error",
      })
    },
  })
  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      // Strict schema should throw an error for invalid fields
      await expect(load()).rejects.toThrow()
    },
  })
})

test("throws error for invalid JSON", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "wanlaicode.json"), "{ invalid json }")
    },
  })
  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      await expect(load()).rejects.toThrow()
    },
  })
})

test("handles agent configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        agent: {
          test_agent: {
            model: "test/model",
            temperature: 0.7,
            description: "test agent",
          },
        },
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test_agent"]).toEqual(
        expect.objectContaining({
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        }),
      )
    },
  })
})

test("treats agent variant as model-scoped setting (not provider option)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        agent: {
          test_agent: {
            model: "openai/gpt-5.2",
            variant: "xhigh",
            max_tokens: 123,
          },
        },
      })
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      const agent = config.agent?.["test_agent"]

      expect(agent?.variant).toBe("xhigh")
      expect(agent?.options).toMatchObject({
        max_tokens: 123,
      })
      expect(agent?.options).not.toHaveProperty("variant")
    },
  })
})

test("handles command configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        command: {
          test_command: {
            template: "test template",
            description: "test command",
            agent: "test_agent",
          },
        },
      })
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.command?.["test_command"]).toEqual({
        template: "test template",
        description: "test command",
        agent: "test_agent",
      })
    },
  })
})

test("migrates autoshare to share field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          autoshare: true,
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.share).toBe("auto")
      expect(config.autoshare).toBe(true)
    },
  })
})

test("migrates mode field to agent field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mode: {
            test_mode: {
              model: "test/model",
              temperature: 0.5,
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test_mode"]).toEqual({
        model: "test/model",
        temperature: 0.5,
        mode: "primary",
        options: {},
        permission: {},
      })
    },
  })
})

test("loads config from .wanlaicode directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })
      const agentDir = path.join(opencodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "test.md"),
        `---
model: test/model
---
Test agent prompt`,
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]).toEqual(
        expect.objectContaining({
          name: "test",
          model: "test/model",
          prompt: "Test agent prompt",
        }),
      )
    },
  })
})

test("agent markdown permission config preserves user key order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const agentDir = path.join(dir, ".wanlaicode", "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "ordered.md"),
        `---
permission:
  bash: allow
  "*": deny
  edit: ask
---
Ordered permissions`,
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(Object.keys(config.agent?.ordered?.permission ?? {})).toEqual(["bash", "*", "edit"])
    },
  })
})

test("loads agents from .wanlaicode/agents (plural)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      const agentsDir = path.join(opencodeDir, "agents")
      await fs.mkdir(path.join(agentsDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(agentsDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper agent prompt`,
      )

      await Filesystem.write(
        path.join(agentsDir, "nested", "child.md"),
        `---
model: test/model
mode: subagent
---
Nested agent prompt`,
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()

      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper agent prompt",
      })

      expect(config.agent?.["nested/child"]).toMatchObject({
        name: "nested/child",
        model: "test/model",
        mode: "subagent",
        prompt: "Nested agent prompt",
      })
    },
  })
})

test("loads commands from .wanlaicode/command (singular)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      const commandDir = path.join(opencodeDir, "command")
      await fs.mkdir(path.join(commandDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(commandDir, "hello.md"),
        `---
description: Test command
---
Hello from singular command`,
      )

      await Filesystem.write(
        path.join(commandDir, "nested", "child.md"),
        `---
description: Nested command
---
Nested command template`,
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()

      expect(config.command?.["hello"]).toEqual({
        description: "Test command",
        template: "Hello from singular command",
      })

      expect(config.command?.["nested/child"]).toEqual({
        description: "Nested command",
        template: "Nested command template",
      })
    },
  })
})

test("loads commands from .wanlaicode/commands (plural)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      const commandsDir = path.join(opencodeDir, "commands")
      await fs.mkdir(path.join(commandsDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(commandsDir, "hello.md"),
        `---
description: Test command
---
Hello from plural commands`,
      )

      await Filesystem.write(
        path.join(commandsDir, "nested", "child.md"),
        `---
description: Nested command
---
Nested command template`,
      )
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()

      expect(config.command?.["hello"]).toEqual({
        description: "Test command",
        template: "Hello from plural commands",
      })

      expect(config.command?.["nested/child"]).toEqual({
        description: "Nested command",
        template: "Nested command template",
      })
    },
  })
})

test("updates config and writes to file", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const newConfig = { model: "updated/model" }
      await save(newConfig as any)

      const writtenConfig = await Filesystem.readJson<{ model: string }>(path.join(tmp.path, "config.json"))
      expect(writtenConfig.model).toBe("updated/model")
    },
  })
})

test("gets config directories", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = await listDirs()
      expect(dirs.length).toBeGreaterThanOrEqual(1)
    },
  })
})

test("does not try to install dependencies in read-only OPENCODE_CONFIG_DIR", async () => {
  if (process.platform === "win32") return

  await using tmp = await tmpdir<string>({
    init: async (dir) => {
      const ro = path.join(dir, "readonly")
      await fs.mkdir(ro, { recursive: true })
      await fs.chmod(ro, 0o555)
      return ro
    },
    dispose: async (dir) => {
      const ro = path.join(dir, "readonly")
      await fs.chmod(ro, 0o755).catch(() => {})
      return ro
    },
  })

  const prev = process.env.WANLAICODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR
  process.env.WANLAICODE_CONFIG_DIR = tmp.extra

  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await load()
      },
    })
  } finally {
    if (prev === undefined) {
      delete process.env.WANLAICODE_CONFIG_DIR
      delete process.env.OPENCODE_CONFIG_DIR
    } else process.env.WANLAICODE_CONFIG_DIR = prev
  }
})

test("installs dependencies in writable OPENCODE_CONFIG_DIR", async () => {
  await using tmp = await tmpdir<string>({
    init: async (dir) => {
      const cfg = path.join(dir, "configdir")
      await fs.mkdir(cfg, { recursive: true })
      return cfg
    },
  })

  const prev = process.env.WANLAICODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR
  process.env.WANLAICODE_CONFIG_DIR = tmp.extra

  const testLayer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(emptyAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(noopNpm),
  )

  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)))
        await Effect.runPromise(
          Config.Service.use((svc) => svc.waitForDependencies()).pipe(Effect.scoped, Effect.provide(testLayer)),
        )
      },
    })

    // TODO: this is a hack to wait for backgruounded gitignore
    await new Promise((resolve) => setTimeout(resolve, 1000))

    expect(await Filesystem.exists(path.join(tmp.extra, ".gitignore"))).toBe(true)
    expect(await Filesystem.readText(path.join(tmp.extra, ".gitignore"))).toContain("package-lock.json")
  } finally {
    if (prev === undefined) {
      delete process.env.WANLAICODE_CONFIG_DIR
      delete process.env.OPENCODE_CONFIG_DIR
    } else process.env.WANLAICODE_CONFIG_DIR = prev
  }
})

// Note: deduplication and serialization of npm installs is now handled by the
// core Npm.Service (via EffectFlock). Those behaviors are tested in the core
// package's npm tests, not here.

test("resolves scoped npm plugins in config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const pluginDir = path.join(dir, "node_modules", "@scope", "plugin")
      await fs.mkdir(pluginDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
      )

      await Filesystem.write(
        path.join(pluginDir, "package.json"),
        JSON.stringify(
          {
            name: "@scope/plugin",
            version: "1.0.0",
            type: "module",
            main: "./index.js",
          },
          null,
          2,
        ),
      )

      await Filesystem.write(path.join(pluginDir, "index.js"), "export default {}\n")

      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["@scope/plugin"] }, null, 2),
      )
    },
  })

  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      const pluginEntries = config.plugin ?? []
      expect(pluginEntries).toContain("@scope/plugin")
    },
  })
})

test("merges plugin arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .wanlaicode config
      const projectDir = path.join(dir, "project")
      const opencodeDir = path.join(projectDir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      // Global config with plugins
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: ["global-plugin-1", "global-plugin-2"],
        }),
      )

      // Local .wanlaicode config with different plugins
      await Filesystem.write(
        path.join(opencodeDir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: ["local-plugin-1"],
        }),
      )
    },
  })

  await provideTestInstance({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const plugins = config.plugin ?? []

      // Should contain both global and local plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)

      // Should have all 3 plugins (not replaced, but merged)
      const pluginNames = plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin"))
      expect(pluginNames.length).toBeGreaterThanOrEqual(3)
    },
  })
})

test("does not error when only custom agent is a subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })
      const agentDir = path.join(opencodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper subagent prompt",
      })
    },
  })
})

test("merges instructions arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const projectDir = path.join(dir, "project")
      const opencodeDir = path.join(projectDir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          instructions: ["global-instructions.md", "shared-rules.md"],
        }),
      )

      await Filesystem.write(
        path.join(opencodeDir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          instructions: ["local-instructions.md"],
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-instructions.md")
      expect(instructions).toContain("shared-rules.md")
      expect(instructions).toContain("local-instructions.md")
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate instructions from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const projectDir = path.join(dir, "project")
      const opencodeDir = path.join(projectDir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          instructions: ["duplicate.md", "global-only.md"],
        }),
      )

      await Filesystem.write(
        path.join(opencodeDir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          instructions: ["duplicate.md", "local-only.md"],
        }),
      )
    },
  })

  await WithInstance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-only.md")
      expect(instructions).toContain("local-only.md")
      expect(instructions).toContain("duplicate.md")

      const duplicates = instructions.filter((i) => i === "duplicate.md")
      expect(duplicates.length).toBe(1)
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate plugins from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .wanlaicode config
      const projectDir = path.join(dir, "project")
      const opencodeDir = path.join(projectDir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })

      // Global config with plugins
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: ["duplicate-plugin", "global-plugin-1"],
        }),
      )

      // Local .wanlaicode config with some overlapping plugins
      await Filesystem.write(
        path.join(opencodeDir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: ["duplicate-plugin", "local-plugin-1"],
        }),
      )
    },
  })

  await provideTestInstance({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await load()
      const plugins = config.plugin ?? []

      // Should contain all unique plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("duplicate-plugin"))).toBe(true)

      // Should deduplicate the duplicate plugin
      const duplicatePlugins = plugins.filter((p) => p.includes("duplicate-plugin"))
      expect(duplicatePlugins.length).toBe(1)

      // Should have exactly 3 unique plugins
      const pluginNames = plugins.filter(
        (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
      )
      expect(pluginNames.length).toBe(3)
    },
  })
})

test("keeps plugin origins aligned with merged plugin list", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const project = path.join(dir, "project")
      const local = path.join(project, ".wanlaicode")
      await fs.mkdir(local, { recursive: true })

      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"],
        }),
      )

      await Filesystem.write(
        path.join(local, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"],
        }),
      )
    },
  })

  await provideTestInstance({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const cfg = await load()
      const plugins = cfg.plugin ?? []
      const origins = cfg.plugin_origins ?? []
      const names = plugins.map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(names).toContain("shared-plugin@2.0.0")
      expect(names).not.toContain("shared-plugin@1.0.0")
      expect(names).toContain("global-only@1.0.0")
      expect(names).toContain("local-only@1.0.0")

      expect(origins.map((item) => item.spec)).toEqual(plugins)
      const hit = origins.find((item) => ConfigPlugin.pluginSpecifier(item.spec) === "shared-plugin@2.0.0")
      expect(hit?.scope).toBe("local")
    },
  })
})

// Legacy tools migration tests

test("migrates legacy tools config to permissions - allow", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              tools: {
                bash: true,
                read: true,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        read: "allow",
      })
    },
  })
})

test("migrates legacy tools config to permissions - deny", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              tools: {
                bash: false,
                webfetch: false,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "deny",
        webfetch: "deny",
      })
    },
  })
})

test("migrates legacy write tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              tools: {
                write: true,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

// Managed settings tests
// Note: preload.ts sets OPENCODE_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

test("managed settings override user settings", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        model: "user/model",
        share: "auto",
        username: "testuser",
      })
    },
  })

  await writeManagedSettings({
    $schema: "https://opencode.ai/config.json",
    model: "managed/model",
    share: "disabled",
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("managed/model")
      expect(config.share).toBe("disabled")
      expect(config.username).toBe("testuser")
    },
  })
})

test("managed settings override project settings", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        autoupdate: true,
        disabled_providers: [],
      })
    },
  })

  await writeManagedSettings({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    disabled_providers: ["openai"],
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.autoupdate).toBe(false)
      expect(config.disabled_providers).toEqual(["openai"])
    },
  })
})

test("missing managed settings file is not an error", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        model: "user/model",
      })
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.model).toBe("user/model")
    },
  })
})

test("migrates legacy edit tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              tools: {
                edit: false,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates legacy patch tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              tools: {
                patch: true,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

test("migrates mixed legacy tools config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              tools: {
                bash: true,
                write: true,
                read: false,
                webfetch: true,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        edit: "allow",
        read: "deny",
        webfetch: "allow",
      })
    },
  })
})

test("merges legacy tools with existing permission config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            test: {
              permission: {
                glob: "allow",
              },
              tools: {
                bash: true,
              },
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.agent?.["test"]?.permission).toEqual({
        glob: "allow",
        bash: "allow",
      })
    },
  })
})

test("permission config preserves user key order", async () => {
  // Permission precedence follows the order users write in config, so parsing
  // must not canonicalise known keys ahead of wildcard or custom keys.
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "deny",
            edit: "ask",
            write: "ask",
            external_directory: "ask",
            read: "allow",
            todowrite: "allow",
            "thoughts_*": "allow",
            "reasoning_model_*": "allow",
            "tools_*": "allow",
            "pr_comments_*": "allow",
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(Object.keys(config.permission!)).toEqual([
        "*",
        "edit",
        "write",
        "external_directory",
        "read",
        "todowrite",
        "thoughts_*",
        "reasoning_model_*",
        "tools_*",
        "pr_comments_*",
      ])
    },
  })
})

test("Effect config parser preserves permission order while rejecting unknown top-level keys", () => {
  const config = ConfigParse.effectSchema(
    Config.Info,
    {
      permission: {
        bash: "allow",
        "*": "deny",
        edit: "ask",
      },
    },
    "test",
  )

  expect(Object.keys(config.permission!)).toEqual(["bash", "*", "edit"])
  try {
    ConfigParse.effectSchema(Config.Info, { invalid_field: true }, "test")
    throw new Error("expected config parse to fail")
  } catch (err) {
    const error = err as { data?: { issues?: Array<{ code?: string; keys?: string[]; path?: string[] }> } }
    expect(error.data?.issues?.[0]).toMatchObject({ code: "unrecognized_keys", keys: ["invalid_field"], path: [] })
  }
})

// MCP config merging tests

test("project config can override MCP server enabled status", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Simulates a base config (like from remote .well-known) with disabled MCP
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: false,
            },
            wiki: {
              type: "remote",
              url: "https://wiki.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Project config enables just jira
      await Filesystem.write(
        path.join(dir, "wanlaicode.jsonc"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      // jira should be enabled (overridden by project config)
      expect(config.mcp?.jira).toEqual({
        type: "remote",
        url: "https://jira.example.com/mcp",
        enabled: true,
      })
      // wiki should still be disabled (not overridden)
      expect(config.mcp?.wiki).toEqual({
        type: "remote",
        url: "https://wiki.example.com/mcp",
        enabled: false,
      })
    },
  })
})

test("MCP config deep merges preserving base config properties", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Base config with full MCP definition
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: false,
              headers: {
                "X-Custom-Header": "value",
              },
            },
          },
        }),
      )
      // Override just enables it, should preserve other properties
      await Filesystem.write(
        path.join(dir, "wanlaicode.jsonc"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.mcp?.myserver).toEqual({
        type: "remote",
        url: "https://myserver.example.com/mcp",
        enabled: true,
        headers: {
          "X-Custom-Header": "value",
        },
      })
    },
  })
})

test("local .wanlaicode config can override MCP from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Project config with disabled MCP
      await Filesystem.write(
        path.join(dir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Local .wanlaicode directory config enables it
      const opencodeDir = path.join(dir, ".wanlaicode")
      await fs.mkdir(opencodeDir, { recursive: true })
      await Filesystem.write(
        path.join(opencodeDir, "wanlaicode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await load()
      expect(config.mcp?.docs?.enabled).toBe(true)
    },
  })
})

test("project config overrides remote well-known config", async () => {
  const originalFetch = globalThis.fetch
  let fetchedUrl: string | undefined
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    if (urlStr.includes(".well-known/opencode")) {
      fetchedUrl = urlStr
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false } },
            },
          }),
          { status: 200 },
        ),
      )
    }
    return originalFetch(url)
  }) as unknown as typeof fetch

  const fakeAuth = Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        "https://example.com": new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

  const layer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(fakeAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(noopNpm),
  )

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe("https://example.com/.well-known/opencode")
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      {
        git: true,
        config: { mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } },
      },
    ).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wellknown URL with trailing slash is normalized", async () => {
  const originalFetch = globalThis.fetch
  let fetchedUrl: string | undefined
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    if (urlStr.includes(".well-known/opencode")) {
      fetchedUrl = urlStr
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              mcp: { slack: { type: "remote", url: "https://slack.example.com/mcp", enabled: true } },
            },
          }),
          { status: 200 },
        ),
      )
    }
    return originalFetch(url)
  }) as unknown as typeof fetch

  const fakeAuth = Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        "https://example.com/": new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

  const layer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(fakeAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(noopNpm),
  )

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            yield* svc.get()
            expect(fetchedUrl).toBe("https://example.com/.well-known/opencode")
          }),
        ),
      { git: true },
    ).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("remote-control credential is not fetched as well-known provider config", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = mock((url: string | URL | Request) => {
    requests.push(url instanceof Request ? url.url : url.toString())
    throw new Error("远控凭证不应触发网络请求")
  }) as unknown as typeof fetch

  const fakeAuth = Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [`${Auth.REMOTE_CONTROL_CREDENTIAL_PREFIX}:account-hash`]: new Auth.WellKnown({
          type: "wellknown",
          key: "desktop-device-id",
          token: "desktop-device-token",
        }),
      }),
  })
  const remoteCredentialLayer = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(fakeAuth),
    Layer.provide(emptyAccount),
    Layer.provideMerge(infra),
    Layer.provide(noopNpm),
  )

  try {
    await provideTmpdirInstance(() => Config.Service.use((service) => service.get()), { git: true }).pipe(
      Effect.scoped,
      Effect.provide(remoteCredentialLayer),
      Effect.runPromise,
    )
    expect(requests).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
  }
})

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "wanlaicode.json")
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-opencode@2.4.3", file)).toBe("oh-my-opencode@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "wanlaicode.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "wanlaicode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "wanlaicode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "wanlaicode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPlugin.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-opencode@2.4.3", "file:///project/.wanlaicode/plugin/oh-my-opencode.js"]

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.wanlaicode/plugin/demo.ts", "file:///project/.wanlaicode/plugin/demo.ts"]

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.wanlaicode/plugin/demo.ts"])
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  test("loads auto-discovered local plugins as file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const projectDir = path.join(dir, "project")
        const opencodeDir = path.join(projectDir, ".wanlaicode")
        const pluginDir = path.join(opencodeDir, "plugin")
        await fs.mkdir(pluginDir, { recursive: true })

        await Filesystem.write(
          path.join(dir, "wanlaicode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: ["my-plugin@1.0.0"],
          }),
        )

        await Filesystem.write(path.join(pluginDir, "my-plugin.js"), "export default {}")
      },
    })

    await provideTestInstance({
      directory: path.join(tmp.path, "project"),
      fn: async () => {
        const config = await load()
        const plugins = config.plugin ?? []

        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p) === "my-plugin@1.0.0")).toBe(true)
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p).startsWith("file://"))).toBe(true)
      },
    })
  })
})

describe("OPENCODE_DISABLE_PROJECT_CONFIG", () => {
  test("skips project config files when flag is set", async () => {
    const originalEnv =
      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] ?? process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
    process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a project config that would normally be loaded
          await Filesystem.write(
            path.join(dir, "wanlaicode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              model: "project/model",
              username: "project-user",
            }),
          )
        },
      })
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await load()
          // Project config should NOT be loaded - model should be default, not "project/model"
          expect(config.model).not.toBe("project/model")
          expect(config.username).not.toBe("project-user")
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"]
        delete process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("skips project .wanlaicode/ directories when flag is set", async () => {
    const originalEnv =
      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] ?? process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
    process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a .wanlaicode directory with a command
          const opencodeDir = path.join(dir, ".wanlaicode", "command")
          await fs.mkdir(opencodeDir, { recursive: true })
          await Filesystem.write(path.join(opencodeDir, "test-cmd.md"), "# Test Command\nThis is a test command.")
        },
      })
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const directories = await listDirs()
          // Project .wanlaicode should NOT be in directories list
          const hasProjectOpencode = directories.some((d) => d.startsWith(tmp.path))
          expect(hasProjectOpencode).toBe(false)
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"]
        delete process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("still loads global config when flag is set", async () => {
    const originalEnv =
      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] ?? process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
    process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir()
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          // Should still get default config (from global or defaults)
          const config = await load()
          expect(config).toBeDefined()
          expect(config.username).toBeDefined()
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"]
        delete process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("skips relative instructions with warning when flag is set but no config dir", async () => {
    const originalDisable =
      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] ?? process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
    const originalConfigDir = process.env["WANLAICODE_CONFIG_DIR"] ?? process.env["OPENCODE_CONFIG_DIR"]

    try {
      // Ensure no config dir is set
      delete process.env["WANLAICODE_CONFIG_DIR"]
      delete process.env["OPENCODE_CONFIG_DIR"]
      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = "true"

      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a config with relative instruction path
          await Filesystem.write(
            path.join(dir, "wanlaicode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              instructions: ["./CUSTOM.md"],
            }),
          )
          // Create the instruction file (should be skipped)
          await Filesystem.write(path.join(dir, "CUSTOM.md"), "# Custom Instructions")
        },
      })

      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          // The relative instruction should be skipped without error
          // We're mainly verifying this doesn't throw and the config loads
          const config = await load()
          expect(config).toBeDefined()
          // The instruction should have been skipped (warning logged)
          // We can't easily test the warning was logged, but we verify
          // the relative path didn't cause an error
        },
      })
    } finally {
      if (originalDisable === undefined) {
        delete process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"]
        delete process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = originalDisable
      }
      if (originalConfigDir === undefined) {
        delete process.env["WANLAICODE_CONFIG_DIR"]
        delete process.env["OPENCODE_CONFIG_DIR"]
      } else {
        process.env["WANLAICODE_CONFIG_DIR"] = originalConfigDir
      }
    }
  })

  test("OPENCODE_CONFIG_DIR still works when flag is set", async () => {
    const originalDisable =
      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] ?? process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
    const originalConfigDir = process.env["WANLAICODE_CONFIG_DIR"] ?? process.env["OPENCODE_CONFIG_DIR"]

    try {
      await using configDirTmp = await tmpdir({
        init: async (dir) => {
          // Create config in the custom config dir
          await Filesystem.write(
            path.join(dir, "wanlaicode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              model: "configdir/model",
            }),
          )
        },
      })

      await using projectTmp = await tmpdir({
        init: async (dir) => {
          // Create config in project (should be ignored)
          await Filesystem.write(
            path.join(dir, "wanlaicode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              model: "project/model",
            }),
          )
        },
      })

      process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = "true"
      process.env["WANLAICODE_CONFIG_DIR"] = configDirTmp.path

      await WithInstance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const config = await load()
          // Should load from OPENCODE_CONFIG_DIR, not project
          expect(config.model).toBe("configdir/model")
        },
      })
    } finally {
      if (originalDisable === undefined) {
        delete process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"]
        delete process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["WANLAICODE_DISABLE_PROJECT_CONFIG"] = originalDisable
      }
      if (originalConfigDir === undefined) {
        delete process.env["WANLAICODE_CONFIG_DIR"]
        delete process.env["OPENCODE_CONFIG_DIR"]
      } else {
        process.env["WANLAICODE_CONFIG_DIR"] = originalConfigDir
      }
    }
  })
})

describe("OPENCODE_CONFIG_CONTENT token substitution", () => {
  test("substitutes {env:} tokens in OPENCODE_CONFIG_CONTENT", async () => {
    const originalEnv = process.env["WANLAICODE_CONFIG_CONTENT"] ?? process.env["OPENCODE_CONFIG_CONTENT"]
    const originalTestVar = process.env["TEST_CONFIG_VAR"]
    process.env["TEST_CONFIG_VAR"] = "test_api_key_12345"
    process.env["WANLAICODE_CONFIG_CONTENT"] = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      username: "{env:TEST_CONFIG_VAR}",
    })

    try {
      await using tmp = await tmpdir()
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await load()
          expect(config.username).toBe("test_api_key_12345")
        },
      })
    } finally {
      if (originalEnv !== undefined) {
        process.env["WANLAICODE_CONFIG_CONTENT"] = originalEnv
      } else {
        delete process.env["WANLAICODE_CONFIG_CONTENT"]
        delete process.env["OPENCODE_CONFIG_CONTENT"]
      }
      if (originalTestVar !== undefined) {
        process.env["TEST_CONFIG_VAR"] = originalTestVar
      } else {
        delete process.env["TEST_CONFIG_VAR"]
      }
    }
  })

  test("substitutes {file:} tokens in OPENCODE_CONFIG_CONTENT", async () => {
    const originalEnv = process.env["WANLAICODE_CONFIG_CONTENT"] ?? process.env["OPENCODE_CONFIG_CONTENT"]

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "api_key.txt"), "secret_key_from_file")
          process.env["WANLAICODE_CONFIG_CONTENT"] = JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            username: "{file:./api_key.txt}",
          })
        },
      })
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await load()
          expect(config.username).toBe("secret_key_from_file")
        },
      })
    } finally {
      if (originalEnv !== undefined) {
        process.env["WANLAICODE_CONFIG_CONTENT"] = originalEnv
      } else {
        delete process.env["WANLAICODE_CONFIG_CONTENT"]
        delete process.env["OPENCODE_CONFIG_CONTENT"]
      }
    }
  })
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.effectSchema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "OpenCode Managed",
          PayloadIdentifier: "ai.wanlaicode.managed.test",
          PayloadType: "ai.wanlaicode.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          share: "disabled",
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.share).toBe("disabled")
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses server settings", async () => {
  const config = ConfigParse.effectSchema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: { hostname: "127.0.0.1", mdns: false },
          autoupdate: true,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
  expect(config.autoupdate).toBe(true)
})

test("parseManagedPlist parses permission rules", async () => {
  const config = ConfigParse.effectSchema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "ask",
            bash: { "*": "ask", "rm -rf *": "deny", "curl *": "deny" },
            grep: "allow",
            glob: "allow",
            webfetch: "ask",
            "~/.ssh/*": "deny",
          },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permission?.["*"]).toBe("ask")
  expect(config.permission?.grep).toBe("allow")
  expect(config.permission?.webfetch).toBe("ask")
  expect(config.permission?.["~/.ssh/*"]).toBe("deny")
  const bash = config.permission?.bash as Record<string, string>
  expect(bash?.["rm -rf *"]).toBe("deny")
  expect(bash?.["curl *"]).toBe("deny")
})

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.effectSchema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.effectSchema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: "https://opencode.ai/config.json" })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe("https://opencode.ai/config.json")
})
