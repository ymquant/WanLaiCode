import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadAddonsFromPaths } from "@opencode-ai/addon"
import {
  Addon,
  cleanupLegacyDefaultMarketplace,
  enrichMarketplaces,
  McpNotFoundError,
  toAvailableList,
  toDetail,
} from "."
import { addonsCacheRoot, marketplaceInstallRoot } from "./paths"
import { Config } from "../config/config"
import { disposeAllInstances, provideTestInstance, tmpdir as testTmpdir } from "../../test/fixture/fixture"
import { WithInstance } from "../project/with-instance"
import { Global } from "@opencode-ai/core/global"

let rootTmpDir: string

beforeAll(() => {
  rootTmpDir = mkdtempSync(join(tmpdir(), "addon-available-test-"))
})

afterAll(() => {
  rmSync(rootTmpDir, { recursive: true, force: true })
})

function writeManifest(root: string, data: Record<string, unknown>) {
  mkdirSync(join(root, ".codex-plugin"), { recursive: true })
  writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(data))
}

function runWithServices<A>(directory: string, effect: Effect.Effect<A, unknown, Config.Service | Addon.Service>) {
  return provideTestInstance({
    directory,
    fn: () => Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(Config.defaultLayer, Addon.defaultLayer)))),
  })
}

describe("toAvailableList", () => {
  test("empty inputs → empty list", () => {
    expect(toAvailableList([], [])).toEqual([])
  })

  test("marketplace with plugins, none installed → all entries marked installed=false", async () => {
    // marketplace.json catalog 是 browse-only：不会 auto-load
    const base = join(rootTmpDir, "browse-only")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [
          { name: "alpha", source: "./plugins/alpha" },
          { name: "beta", source: "./plugins/beta" },
          { name: "gamma", source: "./plugins/gamma" },
        ],
      }),
    )
    writeManifest(join(base, "plugins/alpha"), { name: "alpha", version: "0.1.0" })
    writeManifest(join(base, "plugins/beta"), { name: "beta", version: "0.1.0" })
    writeManifest(join(base, "plugins/gamma"), { name: "gamma", version: "0.1.0" })

    const load = await loadAddonsFromPaths([base], {})
    expect(load.addons).toHaveLength(0) // ↑ 关键：catalog 不会 auto-load
    expect(load.marketplaces[0]?.plugins).toHaveLength(3)

    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.installed === false)).toBe(true)
    expect(result.map((r) => r.key).sort()).toEqual([
      "alpha@codex-curated",
      "beta@codex-curated",
      "gamma@codex-curated",
    ])
    expect(result[0].installation).toBe("AVAILABLE")
  })

  test("marketplace plugins + some installed → all surfaced, installed flag accurate", async () => {
    // 模拟真实状态：marketplace 提供 3 个插件，alpha 已经被 install 到 cache
    const marketRoot = join(rootTmpDir, "mixed-market")
    mkdirSync(join(marketRoot, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(marketRoot, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [
          { name: "alpha", source: "./plugins/alpha" },
          { name: "beta", source: "./plugins/beta" },
          { name: "gamma", source: "./plugins/gamma" },
        ],
      }),
    )
    writeManifest(join(marketRoot, "plugins/alpha"), { name: "alpha", version: "0.1.0" })
    writeManifest(join(marketRoot, "plugins/beta"), { name: "beta", version: "0.1.0" })
    writeManifest(join(marketRoot, "plugins/gamma"), { name: "gamma", version: "0.1.0" })

    // 已安装的 alpha 放到独立 cache 路径
    const cacheRoot = join(rootTmpDir, "mixed-cache")
    writeManifest(join(cacheRoot, "codex-curated/alpha/0.1.0"), { name: "alpha", version: "0.1.0" })

    const load = await loadAddonsFromPaths([cacheRoot, marketRoot], {})
    expect(load.addons).toHaveLength(1)
    expect(load.addons[0]?.addonId.addonName).toBe("alpha")
    expect(load.marketplaces[0]?.plugins).toHaveLength(3)

    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result).toHaveLength(3) // ← 关键：未安装的 beta/gamma 也必须出现
    const byKey = Object.fromEntries(result.map((r) => [r.key, r]))
    expect(byKey["alpha@codex-curated"]?.installed).toBe(true)
    expect(byKey["beta@codex-curated"]?.installed).toBe(false)
    expect(byKey["gamma@codex-curated"]?.installed).toBe(false)
  })

  test("sideload addons not in any marketplace are surfaced as installed=true", async () => {
    // 用户在 ~/.codex/plugins/cache/<market>/<name>/<version> 直接放了 plugin，
    // 但没配 marketplace.json — 这种 addon 不能丢
    const cacheRoot = join(rootTmpDir, "sideload-cache")
    writeManifest(join(cacheRoot, "openai/legacy/0.1.0"), { name: "legacy", version: "0.1.0" })

    const load = await loadAddonsFromPaths([cacheRoot], {})
    expect(load.addons).toHaveLength(1)
    expect(load.marketplaces).toHaveLength(0)

    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      key: "legacy@openai",
      name: "legacy",
      marketplace_name: "openai",
      installed: true,
      installation: "AVAILABLE",
    })
  })

  test("namespace-aware registry addons with same slug stay separate", () => {
    const result = toAvailableList(
      [
        {
          root: "/tmp/cache/wanlaicode/alice/demo/1.0.0",
          addonId: { addonName: "demo", marketplaceName: "wanlaicode", registryNamespace: "alice" },
          manifest: { name: "demo", paths: {} },
          version: "1.0.0",
        },
        {
          root: "/tmp/cache/wanlaicode/bob/demo/1.0.0",
          addonId: { addonName: "demo", marketplaceName: "wanlaicode", registryNamespace: "bob" },
          manifest: { name: "demo", paths: {} },
          version: "1.0.0",
        },
      ],
      [],
    )

    expect(result.map((item) => item.key).sort()).toEqual(["demo@wanlaicode/alice", "demo@wanlaicode/bob"])
    expect(result.every((item) => item.installed)).toBe(true)
  })

  test("detail uses namespace-aware registry skill names", () => {
    const detail = toDetail({
      root: "/tmp/cache/wanlaicode/alice/demo/1.0.0",
      addonId: { addonName: "demo", marketplaceName: "wanlaicode", registryNamespace: "alice" },
      manifest: { name: "demo", paths: {} },
      skills: [{ name: "write", description: "Write things", content: "", location: "/tmp/skill" }],
      version: "1.0.0",
    })

    expect(detail.skills[0]?.namespaced_name).toBe("alice/demo:write")
    expect(detail.addon_id).toEqual({
      addon_name: "demo",
      marketplace_name: "wanlaicode",
      registry_namespace: "alice",
    })
  })

  test("marketplace + sideload mix → both surfaced, no duplicates", async () => {
    const marketRoot = join(rootTmpDir, "mix-market")
    mkdirSync(join(marketRoot, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(marketRoot, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [{ name: "alpha", source: "./plugins/alpha" }],
      }),
    )
    writeManifest(join(marketRoot, "plugins/alpha"), { name: "alpha", version: "0.1.0" })

    const cacheRoot = join(rootTmpDir, "mix-cache")
    // alpha 已安装到 cache（应去重，不重复出现）
    writeManifest(join(cacheRoot, "codex-curated/alpha/0.1.0"), { name: "alpha", version: "0.1.0" })
    // sideload — 不在 marketplace 配置里
    writeManifest(join(cacheRoot, "openai/sideloaded/0.1.0"), { name: "sideloaded", version: "0.1.0" })

    const load = await loadAddonsFromPaths([cacheRoot, marketRoot], {})
    expect(load.addons).toHaveLength(2)
    expect(load.marketplaces[0]?.plugins).toHaveLength(1)

    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result).toHaveLength(2)
    const keys = result.map((r) => r.key).sort()
    expect(keys).toEqual(["alpha@codex-curated", "sideloaded@openai"])
  })

  test("NOT_AVAILABLE policy carries through", async () => {
    const base = join(rootTmpDir, "not-avail")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [
          {
            name: "blocked",
            source: "./plugins/blocked",
            policy: { installation: "NOT_AVAILABLE", authentication: "ON_USE" },
          },
        ],
      }),
    )
    writeManifest(join(base, "plugins/blocked"), { name: "blocked", version: "0.1.0" })

    const load = await loadAddonsFromPaths([base], {})
    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result[0]?.installation).toBe("NOT_AVAILABLE")
  })

  test("defaultPrompt 字符串不会被展开成字符", async () => {
    const base = join(rootTmpDir, "default-prompt-string")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "personal",
        plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" } }],
      }),
    )
    writeManifest(join(base, "plugins/demo"), {
      name: "demo",
      version: "0.1.0",
      interface: { displayName: "Demo", defaultPrompt: "Help me use Demo." },
    })

    const load = await loadAddonsFromPaths([base], {})
    const enriched = await enrichMarketplaces(load.marketplaces)
    const result = toAvailableList(load.addons, enriched.marketplaces, enriched.summaries)

    expect(result[0]?.default_prompt).toEqual(["Help me use Demo."])
  })

  test("按 locale 返回插件信息和默认提示词译文", async () => {
    const base = join(rootTmpDir, "localized-default-prompt")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "personal",
        plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" } }],
      }),
    )
    writeManifest(join(base, "plugins/demo"), {
      name: "demo",
      version: "0.1.0",
      interface: {
        displayName: "Demo",
        shortDescription: "English short",
        defaultPrompt: "Help me use Demo.",
        locales: {
          zh: {
            displayName: "演示插件",
            shortDescription: "中文简介",
            defaultPrompt: ["帮我使用演示插件"],
          },
        },
      },
    })

    const load = await loadAddonsFromPaths([base], {})
    const enriched = await enrichMarketplaces(load.marketplaces)
    const result = toAvailableList(load.addons, enriched.marketplaces, enriched.summaries, undefined, "zh")

    expect(result[0]).toMatchObject({
      display_name: "演示插件",
      description: "中文简介",
      default_prompt: ["帮我使用演示插件"],
    })
  })

  test("openai marketplace 插件缺少 locales 时不做本地兜底翻译", async () => {
    const base = join(rootTmpDir, "openai-locale-untouched")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "openai-plugins",
        plugins: [
          { name: "build-ios-apps", source: { source: "local", path: "./plugins/build-ios-apps" } },
          { name: "build-web-apps", source: { source: "local", path: "./plugins/build-web-apps" } },
        ],
      }),
    )
    writeManifest(join(base, "plugins/build-ios-apps"), {
      name: "build-ios-apps",
      version: "0.1.0",
      interface: {
        displayName: "Build iOS Apps",
        shortDescription: "Build iOS apps with SwiftUI",
        defaultPrompt: "Build or debug an iOS app with SwiftUI.",
      },
    })
    writeManifest(join(base, "plugins/build-web-apps"), {
      name: "build-web-apps",
      version: "0.1.0",
      interface: {
        displayName: "Build Web Apps",
        shortDescription: "Build frontend-focused web apps",
        defaultPrompt: "Design a new landing page for my new SaaS product.",
      },
    })

    const load = await loadAddonsFromPaths([base], {})
    const enriched = await enrichMarketplaces(load.marketplaces)
    const result = toAvailableList(load.addons, enriched.marketplaces, enriched.summaries, undefined, "zh")
    const byKey = Object.fromEntries(result.map((item) => [item.key, item]))

    expect(byKey["build-ios-apps@openai-plugins"]).toMatchObject({
      display_name: "Build iOS Apps",
      description: "Build iOS apps with SwiftUI",
      default_prompt: ["Build or debug an iOS app with SwiftUI."],
    })
    expect(byKey["build-web-apps@openai-plugins"]).toMatchObject({
      display_name: "Build Web Apps",
      description: "Build frontend-focused web apps",
      default_prompt: ["Design a new landing page for my new SaaS product."],
    })
  })

  test("enrichMarketplaces 从 plugin.json 注入 logo (作为 data URI) + brand color + displayName", async () => {
    // 模拟 cloned marketplace 的真实布局：marketplace.json + plugins/<name>/.codex-plugin/plugin.json + 资源
    const base = join(rootTmpDir, "enrich-logo")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [{ name: "gmail", source: { source: "local", path: "./plugins/gmail" } }],
      }),
    )
    mkdirSync(join(base, "plugins/gmail/assets"), { recursive: true })
    // 1x1 透明 PNG，base64 后 inline
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    )
    writeFileSync(join(base, "plugins/gmail/assets/gmail.png"), pngBytes)
    mkdirSync(join(base, "plugins/gmail/.codex-plugin"), { recursive: true })
    writeFileSync(
      join(base, "plugins/gmail/.codex-plugin/plugin.json"),
      JSON.stringify({
        name: "gmail",
        version: "0.1.0",
        interface: {
          displayName: "Gmail",
          shortDescription: "Read and manage Gmail",
          brandColor: "#EA4335",
          logo: "./assets/gmail.png",
        },
      }),
    )

    const load = await loadAddonsFromPaths([base], {})
    const enriched = await enrichMarketplaces(load.marketplaces)
    const result = toAvailableList(load.addons, enriched.marketplaces, enriched.summaries)

    expect(result).toHaveLength(1)
    expect(result[0]?.display_name).toBe("Gmail")
    expect(result[0]?.description).toBe("Read and manage Gmail")
    expect(result[0]?.brand_color).toBe("#EA4335")
    expect(result[0]?.logo).toMatch(/^data:image\/png;base64,/)
  })

  test("logo 路径越界 addon 根目录时拒绝读取(沙箱)", async () => {
    // marketplace plugin.json 不可信 —— 恶意 logo 路径(`../` 相对 / 绝对路径)指向 addon
    // 目录外的图片应被 readLogoAsDataUri 拒掉,即便扩展名是允许的 .png。
    const base = join(rootTmpDir, "enrich-escape-logo")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [
          { name: "rel", source: { source: "local", path: "./plugins/rel" } },
          { name: "abs", source: { source: "local", path: "./plugins/abs" } },
        ],
      }),
    )
    // 越界目标文件 —— 真实存在 + 合法扩展名 + 在大小限内,仅靠沙箱阻断
    const outsideDir = join(base, "outside-assets")
    mkdirSync(outsideDir, { recursive: true })
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    )
    writeFileSync(join(outsideDir, "leaked.png"), pngBytes)
    // 用 `../` 越界(相对 addonRoot=`<base>/plugins/rel`)
    mkdirSync(join(base, "plugins/rel/.codex-plugin"), { recursive: true })
    writeFileSync(
      join(base, "plugins/rel/.codex-plugin/plugin.json"),
      JSON.stringify({
        name: "rel",
        version: "0.1.0",
        interface: { displayName: "Rel", logo: "../../outside-assets/leaked.png" },
      }),
    )
    // 用绝对路径越界
    mkdirSync(join(base, "plugins/abs/.codex-plugin"), { recursive: true })
    writeFileSync(
      join(base, "plugins/abs/.codex-plugin/plugin.json"),
      JSON.stringify({
        name: "abs",
        version: "0.1.0",
        interface: { displayName: "Abs", logo: join(outsideDir, "leaked.png") },
      }),
    )

    const load = await loadAddonsFromPaths([base], {})
    const enriched = await enrichMarketplaces(load.marketplaces)
    const result = toAvailableList(load.addons, enriched.marketplaces, enriched.summaries)
    const byKey = Object.fromEntries(result.map((r) => [r.key, r]))
    expect(byKey["rel@codex-curated"]?.logo).toBeUndefined()
    expect(byKey["abs@codex-curated"]?.logo).toBeUndefined()
    // 其它字段不受沙箱影响 —— 拒 logo 是定点,不要殃及 displayName 等
    expect(byKey["rel@codex-curated"]?.display_name).toBe("Rel")
    expect(byKey["abs@codex-curated"]?.display_name).toBe("Abs")
  })

  test("logo 超过 LOGO_MAX_BYTES 跳过 inline 不写入字段", async () => {
    const base = join(rootTmpDir, "enrich-large-logo")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [{ name: "huge", source: { source: "local", path: "./plugins/huge" } }],
      }),
    )
    mkdirSync(join(base, "plugins/huge/assets"), { recursive: true })
    // 上限 2MB，写 3MB 触发跳过
    writeFileSync(join(base, "plugins/huge/assets/big.png"), Buffer.alloc(3 * 1024 * 1024))
    mkdirSync(join(base, "plugins/huge/.codex-plugin"), { recursive: true })
    writeFileSync(
      join(base, "plugins/huge/.codex-plugin/plugin.json"),
      JSON.stringify({
        name: "huge",
        version: "0.1.0",
        interface: { displayName: "Huge", logo: "./assets/big.png" },
      }),
    )

    const load = await loadAddonsFromPaths([base], {})
    const enriched = await enrichMarketplaces(load.marketplaces)
    const result = toAvailableList(load.addons, enriched.marketplaces, enriched.summaries)
    expect(result[0]?.logo).toBeUndefined() // 太大 → 不 inline
    expect(result[0]?.display_name).toBe("Huge")
  })

  test("clone 后的目录如果含 marketplace.json，会被 loadAddonsFromPaths 识别", async () => {
    // 模拟 clone 完成后的状态：写一个 marketplace.json 到任意目录
    const root = join(rootTmpDir, "default-clone-sim")
    mkdirSync(join(root, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(root, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "openai-plugins",
        plugins: [
          {
            name: "gmail",
            source: "./plugins/gmail",
            category: "Featured",
            interface: { displayName: "Gmail", shortDescription: "Email assistant" },
          },
        ],
      }),
    )
    writeManifest(join(root, "plugins/gmail"), { name: "gmail", version: "0.1.0" })

    // 模拟 state init 把它作为隐式 marketplace input 注入
    const load = await loadAddonsFromPaths([], {
      marketplaces: [{ name: "openai-plugins", root }],
    })
    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result.map((r) => r.name)).toContain("gmail")
    expect(result[0]?.installed).toBe(false)
  })

  test("category / display_name / description from marketplace interface bubble up", async () => {
    const base = join(rootTmpDir, "with-interface")
    mkdirSync(join(base, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(base, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "codex-curated",
        plugins: [
          {
            name: "github",
            source: "./plugins/github",
            category: "Coding",
            interface: {
              displayName: "GitHub",
              shortDescription: "Triage PRs, issues, CI",
            },
          },
        ],
      }),
    )
    writeManifest(join(base, "plugins/github"), { name: "github", version: "0.1.0" })

    const load = await loadAddonsFromPaths([base], {})
    const result = toAvailableList(load.addons, load.marketplaces)
    expect(result[0]).toMatchObject({
      key: "github@codex-curated",
      display_name: "GitHub",
      description: "Triage PRs, issues, CI",
      category: "Coding",
    })
  })
})

describe("cleanupLegacyDefaultMarketplace", () => {
  function writeLegacyMarketplace() {
    const root = marketplaceInstallRoot("openai-plugins")
    mkdirSync(join(root, ".agents/plugins"), { recursive: true })
    writeFileSync(
      join(root, ".agents/plugins/marketplace.json"),
      JSON.stringify({ name: "openai-plugins", plugins: [] }),
    )
    return root
  }

  test("removes old implicit openai-plugins catalog without touching installed addon cache", async () => {
    const legacyRoot = writeLegacyMarketplace()
    const cacheRoot = join(addonsCacheRoot(), "openai-plugins", "installed-demo", "0.1.0")
    writeManifest(cacheRoot, { name: "installed-demo", version: "0.1.0" })

    try {
      await cleanupLegacyDefaultMarketplace({})

      await expect(Bun.file(join(legacyRoot, ".agents/plugins/marketplace.json")).exists()).resolves.toBe(false)
      await expect(Bun.file(join(cacheRoot, ".codex-plugin/plugin.json")).exists()).resolves.toBe(true)
    } finally {
      rmSync(join(addonsCacheRoot(), "openai-plugins", "installed-demo"), { recursive: true, force: true })
      rmSync(legacyRoot, { recursive: true, force: true })
    }
  })

  test("keeps old openai-plugins catalog when user explicitly configured it", async () => {
    const legacyRoot = writeLegacyMarketplace()

    try {
      await cleanupLegacyDefaultMarketplace({
        marketplaces: {
          "openai-plugins": {
            source_type: "git",
            source: "https://github.com/openai/plugins.git",
          },
        },
      })

      await expect(Bun.file(join(legacyRoot, ".agents/plugins/marketplace.json")).exists()).resolves.toBe(true)
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true })
    }
  })
})

describe("Addon MCP overrides", () => {
  test("MCP toggle preserves sibling plugin overrides and rejects missing servers", async () => {
    await using project = await testTmpdir({
      init: async (directory) => {
        const addonRoot = join(directory, "demo")
        writeManifest(addonRoot, { name: "demo", version: "0.1.0" })
        writeFileSync(
          join(addonRoot, ".mcp.json"),
          JSON.stringify({
            search: { command: "node", args: ["search.js"] },
            other: { command: "node", args: ["other.js"] },
          }),
        )
        await Bun.write(
          join(directory, "wanlaicode.json"),
          JSON.stringify({
            marketplaces: {
              personal: { source_type: "local", source: addonRoot },
            },
          }),
        )
      },
    })

    await runWithServices(
      project.path,
      Effect.gen(function* () {
        const addon = yield* Addon.Service
        const configService = yield* Config.Service
        yield* configService.updateGlobal({
          mcp: {
            search: { enabled: false },
          },
          plugins: {
            "demo@personal": {
              disabled_skills: ["draft"],
              mcp_servers: { other: { enabled: true } },
            },
          },
        })

        yield* addon.setMcpEnabled("demo@personal", "search", false)
        const config = yield* configService.getGlobal()
        expect(config.plugins?.["demo@personal"]?.mcp_servers).toMatchObject({
          search: { enabled: false },
          other: { enabled: true },
        })
        expect(config.plugins?.["demo@personal"]?.disabled_skills).toEqual(["draft"])

        yield* addon.setMcpEnabled("demo@personal", "search", true, { removeGlobalMcp: true })
        const enabledConfig = yield* configService.getGlobal()
        expect(enabledConfig.mcp?.search).toBeUndefined()
        expect(enabledConfig.plugins?.["demo@personal"]?.mcp_servers).toMatchObject({
          search: { enabled: true },
          other: { enabled: true },
        })

        const missing = yield* Effect.flip(addon.setMcpEnabled("demo@personal", "missing", false))
        expect(missing).toBeInstanceOf(McpNotFoundError)
        expect((missing as McpNotFoundError).key).toBe("demo@personal:missing")

        const updateGlobal = configService.updateGlobal
        let updateGlobalCalls = 0
        Object.assign(configService, {
          updateGlobal: (...args: Parameters<typeof updateGlobal>) => {
            updateGlobalCalls += 1
            return updateGlobal(...args)
          },
        })
        const inheritedExit = yield* Effect.exit(addon.setMcpEnabled("demo@personal", "toString", false))
        Object.assign(configService, { updateGlobal })
        expect(Exit.isFailure(inheritedExit)).toBe(true)
        expect(updateGlobalCalls).toBe(0)
      }),
    )
  })

  test("MCP toggle invalidates addon caches for every open directory", async () => {
    await using configDir = await testTmpdir()
    await using first = await testTmpdir()
    await using second = await testTmpdir()
    await using addonDir = await testTmpdir({
      init: async (directory) => {
        writeManifest(directory, { name: "demo", version: "0.1.0" })
        writeFileSync(
          join(directory, ".mcp.json"),
          JSON.stringify({ search: { command: "node", args: ["search.js"] } }),
        )
      },
    })
    const previousConfigDir = Global.Path.config
    ;(Global.Path as { config: string }).config = configDir.path
    const projectConfig = JSON.stringify({
      marketplaces: {
        personal: { source_type: "local", source: addonDir.path },
      },
    })
    await Promise.all([
      Bun.write(join(first.path, "wanlaicode.json"), projectConfig),
      Bun.write(join(second.path, "wanlaicode.json"), projectConfig),
    ])

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const addon = yield* Addon.Service
          const use = <A>(directory: string, effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
            Effect.promise(async () => {
              const value = await WithInstance.provide({
                directory,
                fn: () => Effect.runPromise(effect),
              })
              return await value
            })

          expect((yield* use(first.path, addon.getAddons()))[0]?.mcpServers?.search?.enabled).not.toBe(false)
          expect((yield* use(second.path, addon.getAddons()))[0]?.mcpServers?.search?.enabled).not.toBe(false)

          yield* use(first.path, addon.setMcpEnabled("demo@personal", "search", false))

          expect((yield* use(first.path, addon.getAddons()))[0]?.mcpServers?.search?.enabled).toBe(false)
          expect((yield* use(second.path, addon.getAddons()))[0]?.mcpServers?.search?.enabled).toBe(false)
        }).pipe(Effect.provide(Layer.merge(Config.defaultLayer, Addon.defaultLayer)), Effect.scoped),
      )
    } finally {
      ;(Global.Path as { config: string }).config = previousConfigDir
      await disposeAllInstances()
    }
  })
})
