import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import * as tar from "tar"
import {
  AddonInstallError,
  AddonManifestMismatchError,
  cloneGitSource,
  fetchAndCheckout,
  gitRemoteRevision,
  gitRevParseHead,
  installAddonToCache,
  LocalAddonArchiveError,
  materializeAddonSource,
  materializeLocalAddonArchive,
  MarketplaceAddError,
  parseMarketplaceSource,
  safeMarketplaceDirName,
  uninstallAddonFromCache,
} from "./installer"
import { REVISION_FILE, type FetchImpl } from "./http-source"

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "addon-installer-test-"))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// 构造一个 gzip 过的 tar 包,模拟 GitHub /tarball endpoint —— GitHub 返回的 tarball 顶层是
// 单个 `owner-repo-sha/` 目录(strip:1 砍掉这一层)。所以这里要求 srcDir 下只有一个子目录
// 作为顶层,把它显式作为 entries 传给 tar.c,这样 entry 名才是 "topdir/...",strip:1 才能干净剥掉。
async function buildTarballBytes(srcDir: string): Promise<Uint8Array> {
  const entries = readdirSync(srcDir)
  const stream = tar.c({ gzip: true, cwd: srcDir }, entries) as unknown as AsyncIterable<Uint8Array>
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

async function createLocalAddonArchive(input: { extension: string; gzip: boolean; wrapper: boolean }) {
  const source = mkdtempSync(join(tmpRoot, "local-archive-source-"))
  const root = input.wrapper ? join(source, "package") : source
  writeManifest(root, { name: "demo", version: "1.2.3" })
  const archivePath = join(tmpRoot, `demo-${crypto.randomUUID()}${input.extension}`)
  await tar.c({ cwd: source, file: archivePath, gzip: input.gzip }, readdirSync(source))
  return archivePath
}

interface RecordedRequest {
  url: string
  init?: RequestInit
}

interface MockFetchOptions {
  // 命中 tarball / archive endpoint 时返回的字节;true=取默认空目录,false/undefined=404
  archiveBytes?: Uint8Array
  // 命中 commits API 时返回的 sha;null=404
  sha?: string | null
}

function mockFetch(options: MockFetchOptions = {}): { fetchImpl: FetchImpl; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    requests.push({ url, init })
    if (url.includes("/tarball") || url.includes("/archive/")) {
      if (options.archiveBytes) {
        return new Response(options.archiveBytes as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        })
      }
      return new Response("archive not configured", { status: 404 })
    }
    if (url.includes("/commits/") || url.includes("/repository/commits/")) {
      if (options.sha === null || options.sha === undefined) {
        return new Response("commits not configured", { status: 404 })
      }
      return new Response(JSON.stringify({ sha: options.sha, id: options.sha }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("unhandled", { status: 404 })
  }
  return { fetchImpl, requests }
}

describe("parseMarketplaceSource", () => {
  test("github shorthand parses to https url", () => {
    const result = parseMarketplaceSource("openai/repo")
    expect(result).toEqual({
      type: "git",
      url: "https://github.com/openai/repo.git",
      ref: undefined,
      display: "https://github.com/openai/repo.git",
    })
  })

  test("github shorthand with #ref", () => {
    const result = parseMarketplaceSource("openai/repo#main")
    expect(result.type).toBe("git")
    if (result.type !== "git") return
    expect(result.url).toBe("https://github.com/openai/repo.git")
    expect(result.ref).toBe("main")
    expect(result.display).toBe("https://github.com/openai/repo.git#main")
  })

  test("github shorthand with @ref", () => {
    const result = parseMarketplaceSource("openai/repo@release")
    expect(result.type).toBe("git")
    if (result.type !== "git") return
    expect(result.ref).toBe("release")
  })

  test("explicit ref overrides parsed ref", () => {
    const result = parseMarketplaceSource("openai/repo@dev", { ref: "main" })
    expect(result.type).toBe("git")
    if (result.type !== "git") return
    expect(result.ref).toBe("main")
  })

  test("https url normalises trailing slash and adds .git on github", () => {
    expect(parseMarketplaceSource("https://github.com/owner/repo/").display).toBe(
      "https://github.com/owner/repo.git",
    )
  })

  test("non-github URL rejected in parse stage", () => {
    expect(() => parseMarketplaceSource("https://gitlab.com/owner/repo")).toThrow(
      /only GitHub marketplace sources are supported/,
    )
    expect(() => parseMarketplaceSource("https://gitea.example.com/owner/repo")).toThrow(
      /only GitHub marketplace sources are supported/,
    )
    expect(() => parseMarketplaceSource("git@gitlab.com:owner/repo.git")).toThrow(
      /only GitHub marketplace sources are supported/,
    )
  })

  test("ssh git url parses with #ref", () => {
    const result = parseMarketplaceSource("ssh://git@github.com/owner/repo.git#main")
    expect(result).toMatchObject({
      type: "git",
      url: "ssh://git@github.com/owner/repo.git",
      ref: "main",
    })
  })

  test("git@github.com short SSH form parses", () => {
    const result = parseMarketplaceSource("git@github.com:owner/repo.git")
    expect(result).toMatchObject({
      type: "git",
      url: "git@github.com:owner/repo.git",
    })
  })

  test("local absolute path", () => {
    const dir = join(tmpRoot, "src")
    mkdirSync(dir, { recursive: true })
    const result = parseMarketplaceSource(dir)
    expect(result).toEqual({ type: "local", path: dir, display: dir })
  })

  test("local relative path resolves against cwd", () => {
    const result = parseMarketplaceSource("./pkg/foo", { cwd: "/tmp/some" })
    expect(result.type).toBe("local")
    if (result.type !== "local") return
    expect(result.path).toBe("/tmp/some/pkg/foo")
  })

  test("local ~ expansion", () => {
    const result = parseMarketplaceSource("~/foo", { homeDir: "/home/developer" })
    expect(result.type).toBe("local")
    if (result.type !== "local") return
    expect(result.path).toBe("/home/developer/foo")
  })

  test("local path with --ref is rejected", () => {
    expect(() => parseMarketplaceSource("./pkg", { ref: "main" })).toThrow(
      /--ref is only supported for git/,
    )
  })

  test("file:// parses as local path", () => {
    const result = parseMarketplaceSource("file:///tmp/marketplace")
    expect(result.type).toBe("local")
    if (result.type !== "local") return
    expect(result.path).toBe("/tmp/marketplace")
  })

  test("empty source is rejected", () => {
    expect(() => parseMarketplaceSource("   ")).toThrow(/marketplace source must not be empty/)
  })
})

describe("cloneGitSource (HTTP tarball)", () => {
  test("fetches GitHub tarball and extracts strip:1 into destination", async () => {
    const src = mkdtempSync(join(tmpRoot, "src-"))
    mkdirSync(join(src, "topdir", "plugins", "foo"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "hello")
    writeFileSync(join(src, "topdir", "plugins", "foo", "bar.md"), "body")
    const tarballBytes = await buildTarballBytes(src)

    const dest = mkdtempSync(join(tmpRoot, "dest-"))
    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarballBytes, sha: "abc123" })
    await cloneGitSource({
      url: "https://github.com/owner/repo.git",
      destination: dest,
      fetchImpl,
    })

    // tar strip:1 砍掉 ./topdir,marker 应在 dest 根目录;sidecar 写入 sha
    expect(existsSync(join(dest, "marker"))).toBe(true)
    expect(existsSync(join(dest, "plugins", "foo", "bar.md"))).toBe(true)
    expect(readFileSync(join(dest, REVISION_FILE), "utf-8")).toBe("abc123")
    // 至少命中 tarball 端点一次
    expect(requests.some((r) => r.url.includes("/tarball"))).toBe(true)
  })

  test("ref is encoded into tarball URL", async () => {
    const src = mkdtempSync(join(tmpRoot, "src-ref-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "x")
    const tarball = await buildTarballBytes(src)

    const dest = mkdtempSync(join(tmpRoot, "dest-ref-"))
    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: "deadbeef" })
    await cloneGitSource({
      url: "https://github.com/owner/repo.git",
      ref: "release/v1",
      destination: dest,
      fetchImpl,
    })
    const archiveReq = requests.find((r) => r.url.includes("/tarball/"))
    expect(archiveReq?.url).toContain(encodeURIComponent("release/v1"))
  })

  test("sparse paths filter excludes off-target entries", async () => {
    const src = mkdtempSync(join(tmpRoot, "src-sparse-"))
    mkdirSync(join(src, "topdir", "plugins", "keep"), { recursive: true })
    mkdirSync(join(src, "topdir", "plugins", "skip"), { recursive: true })
    writeFileSync(join(src, "topdir", "plugins", "keep", "x.md"), "keep")
    writeFileSync(join(src, "topdir", "plugins", "skip", "y.md"), "skip")
    const tarball = await buildTarballBytes(src)

    const dest = mkdtempSync(join(tmpRoot, "dest-sparse-"))
    const { fetchImpl } = mockFetch({ archiveBytes: tarball, sha: "sha-sparse" })
    await cloneGitSource({
      url: "https://github.com/owner/repo.git",
      destination: dest,
      sparsePaths: ["plugins/keep"],
      fetchImpl,
    })
    expect(existsSync(join(dest, "plugins", "keep", "x.md"))).toBe(true)
    expect(existsSync(join(dest, "plugins", "skip", "y.md"))).toBe(false)
  })

  test("non-200 archive response wraps as MarketplaceAddError", async () => {
    const dest = mkdtempSync(join(tmpRoot, "dest-fail-"))
    const { fetchImpl } = mockFetch({}) // archive 全 404,commits 也 404
    await expect(
      cloneGitSource({
        url: "https://github.com/owner/repo.git",
        destination: dest,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(MarketplaceAddError)
  })

  test("non-GitHub/GitLab URL rejected", async () => {
    const dest = mkdtempSync(join(tmpRoot, "dest-bad-"))
    const { fetchImpl } = mockFetch({ sha: "abc" })
    await expect(
      cloneGitSource({
        url: "https://example.com/repo.git",
        destination: dest,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(MarketplaceAddError)
  })
})

describe("gitRemoteRevision / gitRevParseHead", () => {
  test("gitRemoteRevision returns sha from commits API", async () => {
    const { fetchImpl } = mockFetch({ sha: "deadbeef" })
    expect(await gitRemoteRevision("https://github.com/owner/repo.git", "main", fetchImpl)).toBe("deadbeef")
  })

  test("gitRemoteRevision throws when API returns 404", async () => {
    const { fetchImpl } = mockFetch({ sha: null })
    await expect(
      gitRemoteRevision("https://github.com/owner/repo.git", undefined, fetchImpl),
    ).rejects.toBeInstanceOf(MarketplaceAddError)
  })

  test("gitRemoteRevision rejects unsupported host", async () => {
    const { fetchImpl } = mockFetch({ sha: "abc" })
    await expect(
      gitRemoteRevision("https://example.com/repo.git", undefined, fetchImpl),
    ).rejects.toBeInstanceOf(MarketplaceAddError)
  })

  test("gitRevParseHead reads sidecar revision file", async () => {
    const dir = mkdtempSync(join(tmpRoot, "rev-"))
    writeFileSync(join(dir, REVISION_FILE), "abc123\n")
    expect(await gitRevParseHead(dir)).toBe("abc123")
  })

  test("gitRevParseHead errors when sidecar missing", async () => {
    const dir = mkdtempSync(join(tmpRoot, "rev-missing-"))
    await expect(gitRevParseHead(dir)).rejects.toBeInstanceOf(MarketplaceAddError)
  })
})

describe("fetchAndCheckout (HTTP refresh)", () => {
  test("short-circuits when remote SHA matches sidecar", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "refresh-same-"))
    writeFileSync(join(cwd, REVISION_FILE), "sha-same")
    const { fetchImpl, requests } = mockFetch({ sha: "sha-same" })
    await fetchAndCheckout({
      cwd,
      url: "https://github.com/owner/repo.git",
      fetchImpl,
    })
    // 只命中 commits API,不下 tarball
    expect(requests.some((r) => r.url.includes("/commits/"))).toBe(true)
    expect(requests.some((r) => r.url.includes("/tarball") || r.url.includes("/archive/"))).toBe(false)
  })

  test("re-fetches when remote SHA differs", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "refresh-diff-"))
    writeFileSync(join(cwd, REVISION_FILE), "old-sha")
    writeFileSync(join(cwd, "stale"), "should be gone")

    const src = mkdtempSync(join(tmpRoot, "refresh-src-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "fresh"), "new content")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl } = mockFetch({ sha: "new-sha", archiveBytes: tarball })
    await fetchAndCheckout({
      cwd,
      url: "https://github.com/owner/repo.git",
      fetchImpl,
    })
    expect(existsSync(join(cwd, "fresh"))).toBe(true)
    expect(existsSync(join(cwd, "stale"))).toBe(false)
    expect(readFileSync(join(cwd, REVISION_FILE), "utf-8")).toBe("new-sha")
  })

  test("re-fetches when no sidecar exists", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "refresh-noside-"))
    const src = mkdtempSync(join(tmpRoot, "refresh-src2-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "fresh"), "x")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl } = mockFetch({ sha: "some-sha", archiveBytes: tarball })
    await fetchAndCheckout({
      cwd,
      url: "https://github.com/owner/repo.git",
      fetchImpl,
    })
    expect(existsSync(join(cwd, "fresh"))).toBe(true)
  })
})

describe("safeMarketplaceDirName", () => {
  test("keeps allowed chars", () => {
    expect(safeMarketplaceDirName("openai-curated_v1.0")).toBe("openai-curated_v1.0")
  })
  test("replaces unsafe chars", () => {
    expect(safeMarketplaceDirName("foo/bar baz")).toBe("foo-bar-baz")
  })
  test("rejects empty / dot-only", () => {
    expect(() => safeMarketplaceDirName("...")).toThrow(MarketplaceAddError)
  })
})

function writeManifest(dir: string, data: Record<string, unknown>) {
  mkdirSync(join(dir, ".codex-plugin"), { recursive: true })
  writeFileSync(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify(data))
}

describe("materializeAddonSource", () => {
  test("local source is copied into staging; cleanup leaves the original alone", async () => {
    const dir = join(tmpRoot, "mat-local")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "marker"), "x")
    const stagingRoot = join(tmpRoot, "mat-local-staging")
    const result = await materializeAddonSource({
      source: { type: "local", path: dir },
      stagingRoot,
    })
    expect(result.path).not.toBe(dir)
    expect(result.path.startsWith(stagingRoot)).toBe(true)
    expect(existsSync(join(result.path, "marker"))).toBe(true)
    await result.cleanup()
    expect(existsSync(result.path)).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  test("git source extracts tarball; sha overrides ref into URL; subdir resolves under staging", async () => {
    const stagingRoot = join(tmpRoot, "mat-git-staging")
    mkdirSync(stagingRoot, { recursive: true })

    const src = mkdtempSync(join(tmpRoot, "mat-src-"))
    mkdirSync(join(src, "topdir", "plugins", "foo"), { recursive: true })
    writeFileSync(join(src, "topdir", "plugins", "foo", "marker"), "ok")
    const tarball = await buildTarballBytes(src)
    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: "abc123" })

    const result = await materializeAddonSource({
      source: {
        type: "git",
        url: "https://github.com/owner/repo.git",
        subdir: "plugins/foo",
        ref: "main",
        sha: "abc123",
      },
      stagingRoot,
      fetchImpl,
    })
    const archive = requests.find((r) => r.url.includes("/tarball/"))
    expect(archive?.url).toContain("abc123")
    expect(result.path.endsWith("plugins/foo")).toBe(true)
    expect(result.path.startsWith(stagingRoot)).toBe(true)
    expect(existsSync(join(result.path, "marker"))).toBe(true)
    await result.cleanup()
  })

  test("git source without subdir uses ref when sha missing", async () => {
    const stagingRoot = join(tmpRoot, "mat-git-noref")
    mkdirSync(stagingRoot, { recursive: true })

    const src = mkdtempSync(join(tmpRoot, "mat-src-noref-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "x")
    const tarball = await buildTarballBytes(src)
    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: "abc" })

    const result = await materializeAddonSource({
      source: { type: "git", url: "https://github.com/owner/repo.git", ref: "release" },
      stagingRoot,
      fetchImpl,
    })
    const archive = requests.find((r) => r.url.includes("/tarball/"))
    expect(archive?.url).toContain("release")
    expect(result.path.startsWith(stagingRoot)).toBe(true)
    expect(existsSync(join(result.path, "marker"))).toBe(true)
    await result.cleanup()
  })

  test("cleanup removes staging directory", async () => {
    const stagingRoot = join(tmpRoot, "mat-cleanup")
    mkdirSync(stagingRoot, { recursive: true })

    const src = mkdtempSync(join(tmpRoot, "mat-cleanup-src-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "x")
    const tarball = await buildTarballBytes(src)
    const { fetchImpl } = mockFetch({ archiveBytes: tarball, sha: "abc" })

    const result = await materializeAddonSource({
      source: { type: "git", url: "https://github.com/owner/repo.git" },
      stagingRoot,
      fetchImpl,
    })
    expect(existsSync(result.path)).toBe(true)
    await result.cleanup()
    expect(existsSync(result.path)).toBe(false)
  })
})

describe("materializeLocalAddonArchive", () => {
  for (const item of [
    { extension: ".tar", gzip: false },
    { extension: ".tar.gz", gzip: true },
    { extension: ".tgz", gzip: true },
  ]) {
    test(`materializes ${item.extension} with a root manifest`, async () => {
      const stagingRoot = join(tmpRoot, `local-archive-staging-${item.extension.replaceAll(".", "-")}`)
      const archivePath = await createLocalAddonArchive({ ...item, wrapper: false })
      const result = await materializeLocalAddonArchive({ archivePath, stagingRoot })

      expect(JSON.parse(readFileSync(join(result.path, ".codex-plugin/plugin.json"), "utf-8"))).toMatchObject({
        name: "demo",
        version: "1.2.3",
      })
      await result.cleanup()
      expect(existsSync(result.path)).toBe(false)
    })
  }

  test("uses the only top-level directory as the plugin root", async () => {
    const stagingRoot = join(tmpRoot, "local-archive-wrapper-staging")
    const archivePath = await createLocalAddonArchive({ extension: ".tar", gzip: false, wrapper: true })
    const result = await materializeLocalAddonArchive({ archivePath, stagingRoot })

    expect(result.path.endsWith("/package")).toBe(true)
    expect(JSON.parse(readFileSync(join(result.path, ".codex-plugin/plugin.json"), "utf-8"))).toMatchObject({
      name: "demo",
      version: "1.2.3",
    })
    await result.cleanup()
  })

  test("rejects unsupported archive extensions without retaining staging files", async () => {
    const stagingRoot = join(tmpRoot, "local-archive-invalid-staging")
    mkdirSync(stagingRoot, { recursive: true })
    const archivePath = join(tmpRoot, "demo.zip")
    writeFileSync(archivePath, "not an archive")

    await expect(materializeLocalAddonArchive({ archivePath, stagingRoot })).rejects.toBeInstanceOf(
      LocalAddonArchiveError,
    )
    expect(readdirSync(stagingRoot)).toEqual([])
  })

  test("rejects a directory disguised with a supported extension", async () => {
    const stagingRoot = join(tmpRoot, "local-archive-directory-staging")
    const archivePath = join(tmpRoot, "directory.tar")
    mkdirSync(archivePath, { recursive: true })

    await expect(materializeLocalAddonArchive({ archivePath, stagingRoot })).rejects.toBeInstanceOf(
      LocalAddonArchiveError,
    )
    expect(existsSync(stagingRoot)).toBe(false)
  })

  test("cleans staging after a corrupt archive fails to extract", async () => {
    const stagingRoot = join(tmpRoot, "local-archive-corrupt-staging")
    const archivePath = join(tmpRoot, "corrupt.tar")
    writeFileSync(archivePath, "not a tar archive")

    await expect(materializeLocalAddonArchive({ archivePath, stagingRoot })).rejects.toBeInstanceOf(
      LocalAddonArchiveError,
    )
    expect(readdirSync(stagingRoot)).toEqual([])
  })

  test("preserves unexpected staging filesystem errors", async () => {
    const archivePath = await createLocalAddonArchive({ extension: ".tar", gzip: false, wrapper: false })
    const stagingRoot = join(tmpRoot, "local-archive-blocked-staging")
    writeFileSync(stagingRoot, "not a directory")

    await expect(materializeLocalAddonArchive({ archivePath, stagingRoot })).rejects.toMatchObject({
      code: "ENOTDIR",
    })
  })

  test("rejects archives without a manifest or with multiple plugin roots", async () => {
    const missingRoot = mkdtempSync(join(tmpRoot, "local-archive-missing-source-"))
    mkdirSync(join(missingRoot, "package"), { recursive: true })
    writeFileSync(join(missingRoot, "package", "README.md"), "missing manifest")
    const missingArchive = join(tmpRoot, "missing-manifest.tar")
    await tar.c({ cwd: missingRoot, file: missingArchive }, ["package"])

    const multipleRoot = mkdtempSync(join(tmpRoot, "local-archive-multiple-source-"))
    writeManifest(join(multipleRoot, "first"), { name: "first", version: "1.0.0" })
    writeManifest(join(multipleRoot, "second"), { name: "second", version: "1.0.0" })
    const multipleArchive = join(tmpRoot, "multiple-roots.tar")
    await tar.c({ cwd: multipleRoot, file: multipleArchive }, ["first", "second"])

    await expect(
      materializeLocalAddonArchive({ archivePath: missingArchive, stagingRoot: join(tmpRoot, "missing-staging") }),
    ).rejects.toBeInstanceOf(LocalAddonArchiveError)
    await expect(
      materializeLocalAddonArchive({ archivePath: multipleArchive, stagingRoot: join(tmpRoot, "multiple-staging") }),
    ).rejects.toBeInstanceOf(LocalAddonArchiveError)
  })

  test("does not allow parent-directory archive entries to escape staging", async () => {
    const source = mkdtempSync(join(tmpRoot, "local-archive-traversal-source-"))
    const escapedSource = join(source, "..", "escaped.txt")
    writeFileSync(escapedSource, "escape attempt")
    const archivePath = join(tmpRoot, "traversal.tar")
    await tar.c({ cwd: source, file: archivePath, preservePaths: true }, ["../escaped.txt"])
    const stagingRoot = join(tmpRoot, "local-archive-traversal-staging")
    const escapedDestination = join(stagingRoot, "escaped.txt")

    await expect(materializeLocalAddonArchive({ archivePath, stagingRoot })).rejects.toBeInstanceOf(
      LocalAddonArchiveError,
    )
    expect(existsSync(escapedDestination)).toBe(false)
  })
})

describe("installAddonToCache", () => {
  test("rename sourcePath into <cache>/<market>/<addon>/<version>", async () => {
    const cacheRoot = join(tmpRoot, "cache-1")
    mkdirSync(cacheRoot, { recursive: true })
    const source = join(tmpRoot, "src-1")
    writeManifest(source, { name: "hello", version: "1.0.0" })

    const result = await installAddonToCache({
      sourcePath: source,
      addonId: { addonName: "hello", marketplaceName: "curated" },
      cacheRoot,
    })
    expect(result.installedPath).toBe(join(cacheRoot, "curated", "hello", "1.0.0"))
    expect(result.version).toBe("1.0.0")
    expect(existsSync(result.installedPath)).toBe(true)
    expect(JSON.parse(readFileSync(join(result.installedPath, ".codex-plugin/plugin.json"), "utf-8"))).toEqual({
      name: "hello",
      version: "1.0.0",
    })
  })

  test("uses namespace-aware cache path for registry addons", async () => {
    const cacheRoot = join(tmpRoot, "cache-registry-namespace")
    mkdirSync(cacheRoot, { recursive: true })
    const source = join(tmpRoot, "src-registry-namespace")
    writeManifest(source, { name: "hello", version: "1.0.0" })

    const result = await installAddonToCache({
      sourcePath: source,
      addonId: { addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" },
      cacheRoot,
    })
    expect(result.installedPath).toBe(join(cacheRoot, "wanlaicode", "alice", "hello", "1.0.0"))
    expect(result.version).toBe("1.0.0")
    expect(existsSync(result.installedPath)).toBe(true)
  })

  test("falls back to local version when manifest version is missing", async () => {
    const cacheRoot = join(tmpRoot, "cache-fallback")
    mkdirSync(cacheRoot, { recursive: true })
    const source = join(tmpRoot, "src-fallback")
    writeManifest(source, { name: "hello" })

    const result = await installAddonToCache({
      sourcePath: source,
      addonId: { addonName: "hello", marketplaceName: "curated" },
      cacheRoot,
    })
    expect(result.version).toBe("local")
    expect(result.installedPath.endsWith("/curated/hello/local")).toBe(true)
  })

  test("manifest missing name field throws AddonInstallError with a clear hint", async () => {
    const cacheRoot = join(tmpRoot, "cache-noname")
    mkdirSync(cacheRoot, { recursive: true })
    const source = join(tmpRoot, "src-noname")
    writeManifest(source, { version: "1.0.0" })

    await expect(
      installAddonToCache({
        sourcePath: source,
        addonId: { addonName: "expected", marketplaceName: "curated" },
        cacheRoot,
      }),
    ).rejects.toMatchObject({
      name: "AddonInstallError",
      message: expect.stringContaining(`missing the "name" field`),
    })
  })

  test("manifest name mismatch throws AddonManifestMismatchError", async () => {
    const cacheRoot = join(tmpRoot, "cache-mismatch")
    mkdirSync(cacheRoot, { recursive: true })
    const source = join(tmpRoot, "src-mismatch")
    writeManifest(source, { name: "actual", version: "1.0.0" })

    await expect(
      installAddonToCache({
        sourcePath: source,
        addonId: { addonName: "expected", marketplaceName: "curated" },
        cacheRoot,
      }),
    ).rejects.toBeInstanceOf(AddonManifestMismatchError)
  })

  test("invalid manifest version throws AddonInstallError", async () => {
    const cacheRoot = join(tmpRoot, "cache-badver")
    mkdirSync(cacheRoot, { recursive: true })
    const source = join(tmpRoot, "src-badver")
    writeManifest(source, { name: "hello", version: "bad version" })

    await expect(
      installAddonToCache({
        sourcePath: source,
        addonId: { addonName: "hello", marketplaceName: "curated" },
        cacheRoot,
      }),
    ).rejects.toBeInstanceOf(AddonInstallError)
  })

  test("overwrites existing version directory atomically", async () => {
    const cacheRoot = join(tmpRoot, "cache-overwrite")
    mkdirSync(cacheRoot, { recursive: true })

    const first = join(tmpRoot, "src-overwrite-1")
    writeManifest(first, { name: "hello", version: "1.0.0" })
    writeFileSync(join(first, "marker"), "first")
    const result1 = await installAddonToCache({
      sourcePath: first,
      addonId: { addonName: "hello", marketplaceName: "curated" },
      cacheRoot,
    })
    expect(readFileSync(join(result1.installedPath, "marker"), "utf-8")).toBe("first")

    const second = join(tmpRoot, "src-overwrite-2")
    writeManifest(second, { name: "hello", version: "1.0.0" })
    writeFileSync(join(second, "marker"), "second")
    const result2 = await installAddonToCache({
      sourcePath: second,
      addonId: { addonName: "hello", marketplaceName: "curated" },
      cacheRoot,
    })
    expect(result2.installedPath).toBe(result1.installedPath)
    expect(readFileSync(join(result2.installedPath, "marker"), "utf-8")).toBe("second")
  })

  test("surfaces backup-restore failure with the orphaned backup path", async () => {
    const cacheRoot = join(tmpRoot, "cache-restore-fail")
    mkdirSync(cacheRoot, { recursive: true })

    const first = join(tmpRoot, "src-restore-fail-1")
    writeManifest(first, { name: "hello", version: "1.0.0" })
    await installAddonToCache({
      sourcePath: first,
      addonId: { addonName: "hello", marketplaceName: "curated" },
      cacheRoot,
    })

    const second = join(tmpRoot, "src-restore-fail-2")
    writeManifest(second, { name: "hello", version: "1.0.0" })

    let call = 0
    const failingRename = async (from: string, to: string) => {
      call += 1
      // 1st: destination -> backup (succeed, real move)
      // 2nd: source -> destination (fail to trigger rollback)
      // 3rd: backup -> destination (fail to trigger surfaced error)
      if (call === 1) {
        const { rename } = await import("fs/promises")
        await rename(from, to)
        return
      }
      throw new Error(`synthetic rename failure (call ${call})`)
    }

    await expect(
      installAddonToCache({
        sourcePath: second,
        addonId: { addonName: "hello", marketplaceName: "curated" },
        cacheRoot,
        rename: failingRename as unknown as typeof import("fs/promises").rename,
      }),
    ).rejects.toMatchObject({
      name: "AddonInstallError",
      message: expect.stringContaining("backup left at:"),
    })
  })
})

describe("uninstallAddonFromCache", () => {
  test("removes <cache>/<market>/<addon> directory", async () => {
    const cacheRoot = join(tmpRoot, "uninstall-cache")
    const target = join(cacheRoot, "curated", "hello", "1.0.0")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "marker"), "x")
    expect(existsSync(target)).toBe(true)

    await uninstallAddonFromCache({
      addonId: { addonName: "hello", marketplaceName: "curated" },
      cacheRoot,
    })
    expect(existsSync(join(cacheRoot, "curated", "hello"))).toBe(false)
  })

  test("noop when target does not exist", async () => {
    const cacheRoot = join(tmpRoot, "uninstall-cache-noop")
    mkdirSync(cacheRoot, { recursive: true })
    await uninstallAddonFromCache({
      addonId: { addonName: "missing", marketplaceName: "curated" },
      cacheRoot,
    })
  })

  test("rejects invalid addon segments instead of silently returning", async () => {
    const cacheRoot = join(tmpRoot, "uninstall-cache-bad")
    mkdirSync(cacheRoot, { recursive: true })
    await expect(
      uninstallAddonFromCache({
        addonId: { addonName: "..", marketplaceName: "curated" },
        cacheRoot,
      }),
    ).rejects.toBeInstanceOf(AddonInstallError)
    await expect(
      uninstallAddonFromCache({
        addonId: { addonName: "hello", marketplaceName: "bad/segment" },
        cacheRoot,
      }),
    ).rejects.toBeInstanceOf(AddonInstallError)
  })
})

test("cloneGitSource writes files into the exact destination directory", async () => {
  const src = mkdtempSync(join(tmpRoot, "writes-src-"))
  mkdirSync(join(src, "topdir"), { recursive: true })
  writeFileSync(join(src, "topdir", "marker.txt"), "ok")
  const tarball = await buildTarballBytes(src)

  const dest = join(tmpRoot, "clone-dest")
  const { fetchImpl } = mockFetch({ archiveBytes: tarball, sha: "sha-dest" })
  await cloneGitSource({
    url: "https://github.com/owner/repo.git",
    destination: dest,
    fetchImpl,
  })
  expect(readFileSync(join(dest, "marker.txt"), "utf-8")).toBe("ok")
})
