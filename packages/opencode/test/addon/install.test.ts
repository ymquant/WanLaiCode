import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises"
import path from "path"
import * as tar from "tar"
import { Addon } from "../../src/addon"
import { AddonMarketplace } from "../../src/addon/marketplace"
import { Config } from "../../src/config/config"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await Promise.all(
    ["alice", "bob"].map((namespace) =>
      rm(addonsCachePath("wanlaicode", namespace), { recursive: true, force: true }),
    ),
  )
})

async function writeMarketplace(
  root: string,
  options: {
    marketplaceName?: string
    addonName?: string
    manifestName?: string
    addonVersion?: string
    installation?: "AVAILABLE" | "NOT_AVAILABLE"
  } = {},
) {
  const marketplaceName = options.marketplaceName ?? "fixture-market"
  const addonName = options.addonName ?? "hello"
  const manifestName = options.manifestName ?? addonName
  const installation = options.installation ?? "AVAILABLE"

  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true })
  await writeFile(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: marketplaceName,
      plugins: [
        {
          name: addonName,
          source: `./${addonName}`,
          policy: { installation },
        },
      ],
    }),
  )
  await mkdir(path.join(root, addonName, ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(root, addonName, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: manifestName,
      version: options.addonVersion ?? "0.1.0",
    }),
  )
}

function runWithServices<A>(
  directory: string,
  effect: Effect.Effect<A, unknown, AddonMarketplace.Service | Config.Service | Addon.Service>,
) {
  return provideTestInstance({
    directory,
    fn: () =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(AddonMarketplace.layer),
          Effect.provide(Layer.merge(Config.defaultLayer, Addon.defaultLayer)),
        ),
      ),
  })
}

function addonsCachePath(...parts: string[]) {
  return path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "addons", "cache", ...parts)
}

async function writeCachedRegistryAddonWithSkill(namespace: string, content: string) {
  const root = path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "addons", "cache", "wanlaicode", namespace, "demo", "1.0.0")
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true })
  await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0" }))
  await mkdir(path.join(root, "skills", "write"), { recursive: true })
  await writeFile(
    path.join(root, "skills", "write", "SKILL.md"),
    ["---", "name: write", "description: Write things", "---", content].join("\n"),
  )
}

function configFile() {
  return path.join(process.env.XDG_CONFIG_HOME!, "wanlaicode", "wanlaicode.jsonc")
}

test("installAddon materializes the addon, writes config, and uninstall reverts both", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const mp = yield* AddonMarketplace.Service
      const addon = yield* Addon.Service

      yield* mp.add(source.path, {})

      const installed = yield* addon.installAddon({
        addonName: "hello",
        marketplaceName: "fixture-market",
      })
      expect(installed.key).toBe("hello@fixture-market")
      expect(installed.version).toBe("0.1.0")
      // path.join 用 OS 原生分隔符（Windows \、Unix /），避免硬编码 "/" 让 Windows 假阴。
      expect(installed.installedPath.endsWith(path.join("fixture-market", "hello", "0.1.0"))).toBe(true)
      expect(installed.authPolicy).toBe("ON_INSTALL")

      const cfg = yield* (yield* Config.Service).getGlobal()
      expect(cfg.plugins?.["hello@fixture-market"]?.enabled).toBe(true)

      const reloaded = yield* addon.getAddons()
      const hit = reloaded.find(
        (a) =>
          a.addonId.addonName === "hello" && a.addonId.marketplaceName === "fixture-market",
      )
      expect(hit?.disabled).toBeFalsy()

      yield* addon.uninstallAddon("hello@fixture-market")
      const cfgAfter = yield* (yield* Config.Service).getGlobal()
      expect(cfgAfter.plugins?.["hello@fixture-market"]).toBeUndefined()
    }),
  )

  await expect(stat(addonsCachePath("fixture-market", "hello"))).rejects.toThrow()
  const cfg = JSON.parse(await readFile(configFile(), "utf8"))
  expect(cfg.plugins?.["hello@fixture-market"]).toBeUndefined()
})

test("installLocalArchive installs and enables a personal plugin from its manifest", async () => {
  await using project = await tmpdir()
  await using archive = await tmpdir({
    init: async (dir) => {
      await mkdir(path.join(dir, "package", ".codex-plugin"), { recursive: true })
      await writeFile(
        path.join(dir, "package", ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "local-demo", version: "1.2.3" }),
      )
      await tar.c({ cwd: dir, file: path.join(dir, "local-demo.tgz"), gzip: true }, ["package"])
    },
  })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const addon = yield* Addon.Service
      const installed = yield* addon.installLocalArchive(path.join(archive.path, "local-demo.tgz"))

      expect(installed.key).toBe("local-demo@personal")
      expect(installed.version).toBe("1.2.3")
      expect(installed.installedPath.endsWith(path.join("personal", "local-demo", "1.2.3"))).toBe(true)
      expect(installed.authPolicy).toBe("ON_USE")
      expect(
        yield* Effect.promise(() =>
          Bun.file(path.join(installed.installedPath, ".codex-plugin", "plugin.json")).exists(),
        ),
      ).toBe(true)

      const cfg = yield* (yield* Config.Service).getGlobal()
      expect(cfg.plugins?.["local-demo@personal"]?.enabled).toBe(true)

      const reloaded = yield* addon.getAddons()
      expect(
        reloaded.some((item) => item.addonId.addonName === "local-demo" && item.addonId.marketplaceName === "personal"),
      ).toBe(true)

      yield* addon.uninstallAddon("local-demo@personal")
    }),
  )

  await expect(stat(addonsCachePath("personal", "local-demo"))).rejects.toThrow()
})

test("previewLocalArchive returns manifest metadata without installing the plugin", async () => {
  await using project = await tmpdir()
  await using archive = await tmpdir({
    init: async (dir) => {
      await mkdir(path.join(dir, "package", ".codex-plugin"), { recursive: true })
      await mkdir(path.join(dir, "package", "skills", "review", "agents"), { recursive: true })
      await writeFile(
        path.join(dir, "package", ".codex-plugin", "plugin.json"),
        JSON.stringify({
          name: "preview-demo",
          version: "2.0.0",
          description: "Manifest fallback description",
          skills: "skills",
          mcpServers: "mcp.json",
          apps: "apps.json",
          hooks: ["hooks/run.sh"],
          interface: {
            displayName: "Preview Demo",
            shortDescription: "Short description",
            longDescription: "Long description",
            developerName: "Acme",
            category: "Productivity",
            capabilities: ["network", "filesystem"],
            locales: {
              zh: {
                displayName: "预览演示",
                shortDescription: "中文简介",
                longDescription: "中文详细介绍",
              },
            },
          },
        }),
      )
      await writeFile(
        path.join(dir, "package", "mcp.json"),
        JSON.stringify({ mcpServers: { review: { command: "review" } } }),
      )
      await writeFile(path.join(dir, "package", "apps.json"), JSON.stringify({ apps: { calendar: {} } }))
      await writeFile(
        path.join(dir, "package", "skills", "review", "agents", "openai.yaml"),
        "interface:\n  display_name: Review\n  short_description: Review files\n",
      )
      await tar.c({ cwd: dir, file: path.join(dir, "preview-demo.tgz"), gzip: true }, ["package"])
    },
  })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const addon = yield* Addon.Service
      const preview = yield* addon.previewLocalArchive(path.join(archive.path, "preview-demo.tgz"))

      expect(preview).toMatchObject({
        key: "preview-demo@personal",
        name: "preview-demo",
        version: "2.0.0",
        display_name: "Preview Demo",
        description: "Short description",
        long_description: "Long description",
        developer_name: "Acme",
        category: "Productivity",
        capabilities: ["network", "filesystem"],
        manifest_apps: [{ name: "calendar" }],
        manifest_mcp_servers: [{ name: "review" }],
        manifest_skills: [{ name: "review", display_name: "Review", description: "Review files" }],
        has_hooks: true,
      })
      expect(preview.installed).toBe(false)
      expect(preview.installation).toBe("AVAILABLE")

      const localized = yield* addon.previewLocalArchive(path.join(archive.path, "preview-demo.tgz"), "zh")
      expect(localized).toMatchObject({
        display_name: "预览演示",
        description: "中文简介",
        long_description: "中文详细介绍",
      })
    }),
  )

  expect(await readdir(addonsCachePath("personal")).catch(() => [])).toEqual([])
  const cfg = await readFile(configFile(), "utf8")
    .then(JSON.parse)
    .catch(() => ({}))
  expect(cfg.plugins?.["preview-demo@personal"]).toBeUndefined()
})

test("installLocalArchive rejects manifests without an explicit name", async () => {
  await using project = await tmpdir()
  await using rootArchive = await tmpdir({
    init: async (dir) => {
      await mkdir(path.join(dir, ".codex-plugin"), { recursive: true })
      await writeFile(path.join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }))
      await tar.c({ cwd: dir, file: path.join(dir, "missing-name-root.tar") }, [".codex-plugin"])
    },
  })
  await using wrappedArchive = await tmpdir({
    init: async (dir) => {
      await mkdir(path.join(dir, "package", ".codex-plugin"), { recursive: true })
      await writeFile(path.join(dir, "package", ".codex-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }))
      await tar.c({ cwd: dir, file: path.join(dir, "missing-name-wrapper.tar") }, ["package"])
    },
  })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const addon = yield* Addon.Service

      for (const archivePath of [
        path.join(rootArchive.path, "missing-name-root.tar"),
        path.join(wrappedArchive.path, "missing-name-wrapper.tar"),
      ]) {
        const exit = yield* Effect.exit(addon.installLocalArchive(archivePath))
        if (exit._tag === "Success") yield* addon.uninstallAddon(exit.value.key)
        expect(exit._tag).toBe("Failure")
      }

      const cfg = yield* (yield* Config.Service).getGlobal()
      expect(Object.keys(cfg.plugins ?? {}).some((key) => key.endsWith("@personal"))).toBe(false)
    }),
  )

  expect(await readdir(addonsCachePath("personal")).catch(() => [])).toEqual([])
})

test("installLocalArchive leaves config and cache unchanged for a corrupt package", async () => {
  await using project = await tmpdir()
  await using archive = await tmpdir({
    init: (dir) => writeFile(path.join(dir, "corrupt.tar"), "not a tar archive"),
  })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const addon = yield* Addon.Service
      const exit = yield* Effect.exit(addon.installLocalArchive(path.join(archive.path, "corrupt.tar")))
      expect(exit._tag).toBe("Failure")

      const cfg = yield* (yield* Config.Service).getGlobal()
      expect(Object.keys(cfg.plugins ?? {}).some((key) => key.endsWith("@personal"))).toBe(false)
    }),
  )

  expect(await readdir(addonsCachePath("personal")).catch(() => [])).toEqual([])
})

test("installAddon fails when marketplace is not configured", async () => {
  await using project = await tmpdir()

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const addon = yield* Addon.Service
      const exit = yield* Effect.exit(
        addon.installAddon({ addonName: "hello", marketplaceName: "missing" }),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
})

test("installAddon rejects namespaced registry addon keys", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const mp = yield* AddonMarketplace.Service
      const addon = yield* Addon.Service
      yield* mp.add(source.path, {})

      const exit = yield* Effect.exit(
        addon.installAddon({
          addonName: "hello",
          marketplaceName: "fixture-market",
          registryNamespace: "alice",
        }),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )

  await expect(stat(addonsCachePath("fixture-market", "alice"))).rejects.toThrow()
})

test("getSkillContent matches full namespace-aware addon identity", async () => {
  await using project = await tmpdir()

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await writeCachedRegistryAddonWithSkill("alice", "Alice content")
          await writeCachedRegistryAddonWithSkill("bob", "Bob content")
        },
        catch: (error) => error,
      })

      const addon = yield* Addon.Service
      const content = yield* addon.getSkillContent("demo@wanlaicode/bob", "write")
      expect(content.content).toContain("Bob content")
      expect(content.content).not.toContain("Alice content")
    }),
  )
})

test("installAddon fails when addon is not in the marketplace", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const mp = yield* AddonMarketplace.Service
      const addon = yield* Addon.Service
      yield* mp.add(source.path, {})

      const exit = yield* Effect.exit(
        addon.installAddon({ addonName: "missing-addon", marketplaceName: "fixture-market" }),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )

  await expect(stat(addonsCachePath("fixture-market", "missing-addon"))).rejects.toThrow()
})

test("installAddon refuses NOT_AVAILABLE policy", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({
    init: (dir) =>
      writeMarketplace(dir, {
        marketplaceName: "policy-market",
        installation: "NOT_AVAILABLE",
      }),
  })

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const mp = yield* AddonMarketplace.Service
      const addon = yield* Addon.Service
      yield* mp.add(source.path, {})

      const exit = yield* Effect.exit(
        addon.installAddon({ addonName: "hello", marketplaceName: "policy-market" }),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
})

test("default personal marketplace under <data>/personal is auto-loaded into available addons", async () => {
  await using project = await tmpdir()

  // Global.Path.data == <XDG_DATA_HOME>/wanlaicode (see packages/core/src/global.ts).
  const personalRoot = path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "personal")
  await writeMarketplace(personalRoot, {
    marketplaceName: "personal",
    addonName: "my-personal-plugin",
  })

  try {
    await runWithServices(
      project.path,
      Effect.gen(function* () {
        const addon = yield* Addon.Service

        const marketplaces = yield* addon.getMarketplaces()
        const personal = marketplaces.find((m) => m.name === "personal")
        expect(personal).toBeDefined()
        expect(personal?.root).toBe(personalRoot)
        expect(personal?.plugins.some((p) => p.name === "my-personal-plugin")).toBe(true)

        const available = yield* addon.getAvailableAddons()
        const hit = available.find(
          (a) => a.name === "my-personal-plugin" && a.marketplace_name === "personal",
        )
        expect(hit).toBeDefined()
      }),
    )
  } finally {
    // 清理:避免该自动加载的 personal marketplace 残留影响同进程内其它用例。
    await rm(personalRoot, { recursive: true, force: true })
  }
})

test("uninstallAddon is a no-op when the addon is not installed", async () => {
  await using project = await tmpdir()

  await runWithServices(
    project.path,
    Effect.gen(function* () {
      const addon = yield* Addon.Service
      const outcome = yield* addon.uninstallAddon("ghost@market")
      expect(outcome.key).toBe("ghost@market")
    }),
  )
})
