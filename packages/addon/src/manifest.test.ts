import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseManifest, findManifestPath } from "./manifest"

let rootTmpDir: string

beforeAll(() => {
  rootTmpDir = mkdtempSync(join(tmpdir(), "addon-test-"))
})

afterAll(() => {
  rmSync(rootTmpDir, { recursive: true, force: true })
})

function makeDir(name: string): string {
  const dir = join(rootTmpDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJson(dir: string, relPath: string, data: unknown): void {
  const fullPath = join(dir, relPath)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, JSON.stringify(data))
}

describe("parseManifest", () => {
  test(".codex-plugin 路径解析", async () => {
    const addonRoot = makeDir("test-codex-plugin")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { name: "hello", version: "1.0.0" })

    const manifestPath = findManifestPath(addonRoot)
    expect(manifestPath).toBe(join(addonRoot, ".codex-plugin/plugin.json"))

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("hello")
    expect(result!.version).toBe("1.0.0")
  })

  test("hooks 字符串形式", async () => {
    const addonRoot = makeDir("test-hooks-string")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { name: "p", hooks: "echo hello" })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.paths.hooks).toBe("echo hello")
  })

  test("hooks 字符串数组形式", async () => {
    const addonRoot = makeDir("test-hooks-arr")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { name: "p", hooks: ["echo foo", "echo bar"] })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(Array.isArray(result!.paths.hooks)).toBe(true)
    expect(result!.paths.hooks).toEqual(["echo foo", "echo bar"])
  })

  test("hooks inline object 形式", async () => {
    const addonRoot = makeDir("test-hooks-obj")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      hooks: { path: "hooks/pre.sh", events: ["PreToolUse"] },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.paths.hooks).toEqual({ path: "hooks/pre.sh", events: ["PreToolUse"] })
  })

  test("hooks inline object 列表形式", async () => {
    const addonRoot = makeDir("test-hooks-obj-list")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      hooks: [{ path: "hooks/pre.sh" }, { path: "hooks/post.sh" }],
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(Array.isArray(result!.paths.hooks)).toBe(true)
  })

  test("defaultPrompt 字符串归一化", async () => {
    const addonRoot = makeDir("test-prompt-str")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      interface: { defaultPrompt: "single prompt" },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.interfaceInfo!.defaultPrompt).toEqual(["single prompt"])
  })

  test("defaultPrompt 超过 3 项截断", async () => {
    const addonRoot = makeDir("test-prompt-truncate")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      interface: { defaultPrompt: ["a", "b", "c", "d", "e"] },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.interfaceInfo!.defaultPrompt!.length).toBe(3)
  })

  test("defaultPrompt 每项超过 128 字符截断", async () => {
    const addonRoot = makeDir("test-prompt-char-truncate")
    const longStr = "x".repeat(200)
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      interface: { defaultPrompt: [longStr] },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect((result!.interfaceInfo!.defaultPrompt![0] ?? "").length).toBe(128)
  })

  test("locales 支持 defaultPrompt", async () => {
    const addonRoot = makeDir("test-prompt-locale")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      interface: {
        defaultPrompt: "single prompt",
        locales: {
          zh: { defaultPrompt: ["中文提示词"] },
        },
      },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.interfaceInfo!.locales?.zh?.defaultPrompt).toEqual(["中文提示词"])
  })

  test("interface URL fields use Codex casing", async () => {
    const addonRoot = makeDir("test-codex-url-casing")
    writeJson(addonRoot, ".wanlaicode-plugin/plugin.json", {
      name: "p",
      interface: {
        websiteURL: "https://example.com/",
        privacyPolicyURL: "https://example.com/privacy",
        termsOfServiceURL: "https://example.com/terms",
      },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.interfaceInfo?.websiteUrl).toBe("https://example.com/")
    expect(result!.interfaceInfo?.privacyPolicyUrl).toBe("https://example.com/privacy")
    expect(result!.interfaceInfo?.termsOfServiceUrl).toBe("https://example.com/terms")
  })

  test("interface URL fields support legacy casing at runtime", async () => {
    const addonRoot = makeDir("test-legacy-url-casing")
    writeJson(addonRoot, ".wanlaicode-plugin/plugin.json", {
      name: "p",
      interface: {
        websiteUrl: "https://example.com/",
        privacyPolicyUrl: "https://example.com/privacy",
        termsOfServiceUrl: "https://example.com/terms",
      },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.interfaceInfo?.websiteUrl).toBe("https://example.com/")
    expect(result!.interfaceInfo?.privacyPolicyUrl).toBe("https://example.com/privacy")
    expect(result!.interfaceInfo?.termsOfServiceUrl).toBe("https://example.com/terms")
  })

  test("interface URL fields prefer Codex casing over legacy casing", async () => {
    const addonRoot = makeDir("test-codex-url-casing-priority")
    writeJson(addonRoot, ".wanlaicode-plugin/plugin.json", {
      name: "p",
      interface: {
        websiteURL: "https://codex.example.com/",
        websiteUrl: "https://legacy.example.com/",
      },
    })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.interfaceInfo?.websiteUrl).toBe("https://codex.example.com/")
  })

  test("name 缺失时回退目录名", async () => {
    const addonRoot = makeDir("myplugin")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { version: "1.0.0" })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("myplugin")
  })

  test("name 缺失时目录名去除 @ 前缀", async () => {
    const addonRoot = makeDir("@myplugin")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { version: "1.0.0" })

    const result = await parseManifest(addonRoot)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("myplugin")
  })

  test("绝对路径被拒绝（skills 字段）", async () => {
    const addonRoot = makeDir("test-abs-path")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { name: "p", skills: "/absolute/path" })

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })

  test("路径穿越被拒绝（mcpServers 字段）", async () => {
    const addonRoot = makeDir("test-traversal")
    writeJson(addonRoot, ".codex-plugin/plugin.json", { name: "p", mcpServers: "../parent/config.json" })

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })

  test("hooks inline path 绝对路径被拒绝", async () => {
    const addonRoot = makeDir("test-hooks-abs")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      hooks: { path: "/etc/passwd" },
    })

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })

  test("hooks 字符串路径穿越被拒绝", async () => {
    const addonRoot = makeDir("test-hooks-str-traversal")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      hooks: "../parent/hooks.json",
    })

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })

  test("hooks 字符串数组路径穿越被拒绝", async () => {
    const addonRoot = makeDir("test-hooks-arr-traversal")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      hooks: ["ok/hooks.json", "../escape.json"],
    })

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })

  test("hooks 字符串绝对路径被拒绝", async () => {
    const addonRoot = makeDir("test-hooks-str-abs")
    writeJson(addonRoot, ".codex-plugin/plugin.json", {
      name: "p",
      hooks: "/etc/passwd",
    })

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })

  test("无清单文件返回 null", async () => {
    const addonRoot = makeDir("test-no-manifest")

    const manifestPath = findManifestPath(addonRoot)
    expect(manifestPath).toBeNull()

    const result = await parseManifest(addonRoot)
    expect(result).toBeNull()
  })
})
