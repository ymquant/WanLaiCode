import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  AddonInstallNotAvailableError,
  AddonNotFoundInMarketplaceError,
  findInstallableAddonInMarketplace,
  findMarketplaceManifestPath,
  loadMarketplace,
  marketplaceRootFromManifestPath,
} from "./marketplace"

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "addon-marketplace-test-"))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function writeMarketplace(rootDir: string, rel: string, data: unknown) {
  const full = join(rootDir, rel)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, JSON.stringify(data))
  return full
}

describe("findMarketplaceManifestPath", () => {
  test("prefers .agents/plugins/marketplace.json", () => {
    const root = join(tmpRoot, "primary")
    const primary = writeMarketplace(root, ".agents/plugins/marketplace.json", { name: "x", plugins: [] })
    writeMarketplace(root, ".claude-plugin/marketplace.json", { name: "x", plugins: [] })
    expect(findMarketplaceManifestPath(root)).toBe(primary)
  })

  test("falls back to .claude-plugin/marketplace.json", () => {
    const root = join(tmpRoot, "fallback")
    const fallback = writeMarketplace(root, ".claude-plugin/marketplace.json", { name: "x", plugins: [] })
    expect(findMarketplaceManifestPath(root)).toBe(fallback)
  })

  test("returns null when no manifest exists", () => {
    const root = join(tmpRoot, "missing")
    mkdirSync(root, { recursive: true })
    expect(findMarketplaceManifestPath(root)).toBeNull()
  })
})

describe("marketplaceRootFromManifestPath", () => {
  test("strips .agents/plugins/marketplace.json", () => {
    const root = join(tmpRoot, "root1")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", { name: "x", plugins: [] })
    expect(marketplaceRootFromManifestPath(manifest)).toBe(root)
  })

  test("strips .claude-plugin/marketplace.json", () => {
    const root = join(tmpRoot, "root2")
    const manifest = writeMarketplace(root, ".claude-plugin/marketplace.json", { name: "x", plugins: [] })
    expect(marketplaceRootFromManifestPath(manifest)).toBe(root)
  })
})

describe("loadMarketplace - sources", () => {
  test("local source as string", async () => {
    const root = join(tmpRoot, "src-local-string")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "codex-curated",
      plugins: [{ name: "alpha", source: "./plugins/alpha" }],
    })
    const result = await loadMarketplace(manifest)
    expect(result.name).toBe("codex-curated")
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      name: "alpha",
      source: { type: "local", path: join(root, "plugins/alpha") },
    })
  })

  test("local source as object with explicit path", async () => {
    const root = join(tmpRoot, "src-local-object")
    const manifest = writeMarketplace(root, ".claude-plugin/marketplace.json", {
      name: "alt",
      plugins: [{ name: "beta", source: { source: "local", path: "./pkg/beta" } }],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]).toMatchObject({
      name: "beta",
      source: { type: "local", path: join(root, "pkg/beta") },
    })
  })

  test("url source with subdir, ref, sha", async () => {
    const root = join(tmpRoot, "src-url")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "remote",
      plugins: [
        {
          name: "remote-plugin",
          source: {
            source: "url",
            url: "https://github.com/openai/marketplace3",
            path: "plugins/toolkit",
            ref: "main",
            sha: "abc123",
          },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.source).toEqual({
      type: "git",
      url: "https://github.com/openai/marketplace3.git",
      subdir: "plugins/toolkit",
      ref: "main",
      sha: "abc123",
    })
  })

  test("git-subdir source normalizes url + path", async () => {
    const root = join(tmpRoot, "src-gitsubdir")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "gh",
      plugins: [
        {
          name: "remote-plugin",
          source: {
            source: "git-subdir",
            url: "openai/joey_marketplace3",
            path: "plugins/toolkit",
            ref: "main",
            sha: "abc123",
          },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.source).toEqual({
      type: "git",
      url: "https://github.com/openai/joey_marketplace3.git",
      subdir: "plugins/toolkit",
      ref: "main",
      sha: "abc123",
    })
  })

  test("github shorthand keeps existing .git suffix", async () => {
    const root = join(tmpRoot, "src-shorthand-git")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "gh",
      plugins: [
        {
          name: "remote-plugin",
          source: { source: "git-subdir", url: "openai/toolkit.git", path: "plugins/toolkit" },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect((result.plugins[0]?.source as { url: string }).url).toBe("https://github.com/openai/toolkit.git")
  })

  test("ssh:// and git@ urls are kept as-is", async () => {
    const root = join(tmpRoot, "src-ssh")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "ssh-mp",
      plugins: [
        { name: "a", source: { source: "url", url: "ssh://git@example.com/owner/repo.git" } },
        { name: "b", source: { source: "url", url: "git@github.com:owner/repo.git" } },
      ],
    })
    const result = await loadMarketplace(manifest)
    const urls = result.plugins.map((p) => (p.source as { url: string }).url)
    expect(urls).toEqual([
      "ssh://git@example.com/owner/repo.git",
      "git@github.com:owner/repo.git",
    ])
  })

  test("relative ./ git url resolves against marketplace root", async () => {
    const root = join(tmpRoot, "src-relative")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "rel",
      plugins: [{ name: "a", source: { source: "url", url: "./vendor/repo" } }],
    })
    const result = await loadMarketplace(manifest)
    expect((result.plugins[0]?.source as { url: string }).url).toBe(join(root, "vendor/repo"))
  })

  test("default policy is AVAILABLE + ON_INSTALL", async () => {
    const root = join(tmpRoot, "default-policy")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "policy-mp",
      plugins: [{ name: "a", source: "./pkg/a" }],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" })
  })

  test("unsupported source is recorded in unsupportedPlugins", async () => {
    const root = join(tmpRoot, "unsupported")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "u-mp",
      plugins: [
        { name: "good", source: "./pkg/good" },
        { name: "bad", source: { source: "ftp", url: "ftp://example.com" } },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins.map((p) => p.name)).toEqual(["good"])
    expect(result.unsupportedPlugins[0]?.name).toBe("bad")
  })

  test("rejects local path that escapes marketplace root", async () => {
    const root = join(tmpRoot, "escape")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "esc-mp",
      plugins: [{ name: "x", source: "./../outside" }],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins).toHaveLength(0)
    expect(result.unsupportedPlugins[0]?.name).toBe("x")
  })

  test("rejects file:// git plugin source url", async () => {
    const root = join(tmpRoot, "file-url")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "file-mp",
      plugins: [{ name: "x", source: { source: "url", url: "file:///tmp/repo" } }],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins).toHaveLength(0)
    expect(result.unsupportedPlugins[0]?.name).toBe("x")
  })

  test("rejects absolute path git plugin source url", async () => {
    const root = join(tmpRoot, "abs-url")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "abs-mp",
      plugins: [{ name: "x", source: { source: "url", url: "/etc/passwd" } }],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins).toHaveLength(0)
    expect(result.unsupportedPlugins[0]?.name).toBe("x")
  })

  test("category from plugin entry overrides interface category", async () => {
    const root = join(tmpRoot, "category")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "cat-mp",
      plugins: [
        {
          name: "x",
          source: "./pkg/x",
          category: "Tools",
          interface: { displayName: "X plugin", category: "Other" },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.category).toBe("Tools")
    expect(result.plugins[0]?.interface?.category).toBe("Tools")
  })

  test("plugin interface URL fields use Codex casing", async () => {
    const root = join(tmpRoot, "codex-url-casing")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "codex-url-mp",
      plugins: [
        {
          name: "x",
          source: "./pkg/x",
          interface: {
            websiteURL: "https://example.com/",
            privacyPolicyURL: "https://example.com/privacy",
            termsOfServiceURL: "https://example.com/terms",
          },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.interface?.websiteUrl).toBe("https://example.com/")
    expect(result.plugins[0]?.interface?.privacyPolicyUrl).toBe("https://example.com/privacy")
    expect(result.plugins[0]?.interface?.termsOfServiceUrl).toBe("https://example.com/terms")
  })

  test("plugin interface URL fields support legacy casing at runtime", async () => {
    const root = join(tmpRoot, "legacy-url-casing")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "legacy-url-mp",
      plugins: [
        {
          name: "x",
          source: "./pkg/x",
          interface: {
            websiteUrl: "https://example.com/",
            privacyPolicyUrl: "https://example.com/privacy",
            termsOfServiceUrl: "https://example.com/terms",
          },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.interface?.websiteUrl).toBe("https://example.com/")
    expect(result.plugins[0]?.interface?.privacyPolicyUrl).toBe("https://example.com/privacy")
    expect(result.plugins[0]?.interface?.termsOfServiceUrl).toBe("https://example.com/terms")
  })

  test("plugin interface URL fields prefer Codex casing over legacy casing", async () => {
    const root = join(tmpRoot, "codex-url-casing-priority")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "codex-url-priority-mp",
      plugins: [
        {
          name: "x",
          source: "./pkg/x",
          interface: {
            websiteURL: "https://codex.example.com/",
            websiteUrl: "https://legacy.example.com/",
          },
        },
      ],
    })
    const result = await loadMarketplace(manifest)
    expect(result.plugins[0]?.interface?.websiteUrl).toBe("https://codex.example.com/")
  })

  test("captures marketplace interface displayName", async () => {
    const root = join(tmpRoot, "interface")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "if-mp",
      interface: { displayName: "Curated" },
      plugins: [],
    })
    const result = await loadMarketplace(manifest)
    expect(result.interface).toEqual({ displayName: "Curated" })
  })

  test("missing name throws", async () => {
    const root = join(tmpRoot, "missing-name")
    const manifest = writeMarketplace(root, ".agents/plugins/marketplace.json", { plugins: [] })
    await expect(loadMarketplace(manifest)).rejects.toThrow(/missing `name`/)
  })
})

describe("findInstallableAddonInMarketplace", () => {
  test("returns addonId/source/policy for an installable entry", async () => {
    const root = join(tmpRoot, "installable-found")
    writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "curated",
      plugins: [{ name: "hello", source: "./pkg/hello" }],
    })
    const result = await findInstallableAddonInMarketplace(root, "hello")
    expect(result.addonId).toEqual({ addonName: "hello", marketplaceName: "curated" })
    expect(result.source).toEqual({ type: "local", path: join(root, "pkg/hello") })
    expect(result.policy.installation).toBe("AVAILABLE")
  })

  test("throws AddonNotFoundInMarketplaceError when addon name is unknown", async () => {
    const root = join(tmpRoot, "installable-missing")
    writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "curated",
      plugins: [{ name: "hello", source: "./pkg/hello" }],
    })
    await expect(findInstallableAddonInMarketplace(root, "nope")).rejects.toBeInstanceOf(
      AddonNotFoundInMarketplaceError,
    )
  })

  test("throws AddonInstallNotAvailableError when policy installation is NOT_AVAILABLE", async () => {
    const root = join(tmpRoot, "installable-not-available")
    writeMarketplace(root, ".agents/plugins/marketplace.json", {
      name: "curated",
      plugins: [
        {
          name: "hello",
          source: "./pkg/hello",
          policy: { installation: "NOT_AVAILABLE" },
        },
      ],
    })
    await expect(findInstallableAddonInMarketplace(root, "hello")).rejects.toBeInstanceOf(
      AddonInstallNotAvailableError,
    )
  })
})
