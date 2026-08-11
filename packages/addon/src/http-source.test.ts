import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import * as tar from "tar"
import {
  fetchHttpSource,
  getRemoteRevision,
  HttpSourceError,
  isImmutableRef,
  readLocalRevision,
  readLocalSidecar,
  refreshHttpSource,
  resolveHttpSource,
  REVISION_FILE,
  type FetchImpl,
} from "./http-source"

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "addon-http-source-test-"))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

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

interface MockFetchOptions {
  archiveBytes?: Uint8Array
  archiveContentEncoding?: string
  commitsStatus?: number
  commitsContentType?: string
  commitsBody?: string
  sha?: string | null
}

function mockFetch(options: MockFetchOptions = {}): { fetchImpl: FetchImpl; requests: string[] } {
  const requests: string[] = []
  const fetchImpl: FetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    requests.push(url)
    if (url.includes("/tarball") || url.includes("/archive/")) {
      if (!options.archiveBytes) return new Response("archive missing", { status: 404 })
      const headers: Record<string, string> = { "content-type": "application/gzip" }
      if (options.archiveContentEncoding) headers["content-encoding"] = options.archiveContentEncoding
      return new Response(options.archiveBytes as unknown as BodyInit, { status: 200, headers })
    }
    if (url.includes("/commits/") || url.includes("/repository/commits/")) {
      const status = options.commitsStatus ?? (options.sha == null ? 404 : 200)
      if (status !== 200) return new Response("nope", { status })
      const ct = options.commitsContentType ?? "application/json"
      const body = options.commitsBody ?? JSON.stringify({ sha: options.sha, id: options.sha })
      return new Response(body, { status, headers: { "content-type": ct } })
    }
    return new Response("unhandled", { status: 404 })
  }
  return { fetchImpl, requests }
}

describe("isImmutableRef", () => {
  test("SHA / tag / vN.N return true", () => {
    expect(isImmutableRef("abc1234")).toBe(true)
    expect(isImmutableRef("abc1234567890abcdef1234567890abcdef12345")).toBe(true)
    expect(isImmutableRef("refs/tags/v1.0.0")).toBe(true)
    expect(isImmutableRef("v1.0.0")).toBe(true)
    expect(isImmutableRef("1.2")).toBe(true)
  })

  test("branch names and undefined return false", () => {
    expect(isImmutableRef(undefined)).toBe(false)
    expect(isImmutableRef("main")).toBe(false)
    expect(isImmutableRef("release/v1")).toBe(false)
    expect(isImmutableRef("feature-x")).toBe(false)
  })
})

describe("sidecar JSON / SHA-only 兼容", () => {
  test("write + read JSON sidecar 带 sparsePaths", async () => {
    const dir = mkdtempSync(join(tmpRoot, "sidecar-json-"))
    const src = mkdtempSync(join(tmpRoot, "sidecar-json-src-"))
    mkdirSync(join(src, "owner-repo-deadbeef0123456"), { recursive: true })
    writeFileSync(join(src, "owner-repo-deadbeef0123456", "marker"), "x")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl } = mockFetch({ archiveBytes: tarball })
    await fetchHttpSource({
      url: "https://github.com/owner/repo",
      destination: dir,
      sparsePaths: ["plugins/a", "/plugins/b/"],
      fetchImpl,
    })
    const sidecar = await readLocalSidecar(dir)
    expect(sidecar.revision).toBe("deadbeef0123456")
    expect(sidecar.sparsePaths).toEqual(["plugins/a", "plugins/b"])
  })

  test("readLocalRevision 读老 SHA-only sidecar", async () => {
    const dir = mkdtempSync(join(tmpRoot, "sidecar-legacy-"))
    writeFileSync(join(dir, REVISION_FILE), "abc123\n")
    expect(await readLocalRevision(dir)).toBe("abc123")
    expect(await readLocalSidecar(dir)).toEqual({ revision: "abc123" })
  })

  test("无 sparsePaths 时 sidecar 退回纯 SHA 文本格式", async () => {
    const dir = mkdtempSync(join(tmpRoot, "sidecar-bare-"))
    const src = mkdtempSync(join(tmpRoot, "sidecar-bare-src-"))
    mkdirSync(join(src, "owner-repo-abc1234"), { recursive: true })
    writeFileSync(join(src, "owner-repo-abc1234", "marker"), "x")
    const tarball = await buildTarballBytes(src)
    const { fetchImpl } = mockFetch({ archiveBytes: tarball })
    await fetchHttpSource({
      url: "https://github.com/owner/repo",
      destination: dir,
      fetchImpl,
    })
    const raw = readFileSync(join(dir, REVISION_FILE), "utf-8")
    expect(raw).toBe("abc1234")
  })
})

describe("fetchHttpSource: 优先从 tarball 顶层解析 SHA", () => {
  test("GitHub tarball 顶层带 SHA → 不调 commits API", async () => {
    const dir = mkdtempSync(join(tmpRoot, "tarsha-"))
    const src = mkdtempSync(join(tmpRoot, "tarsha-src-"))
    mkdirSync(join(src, "openai-plugins-0123abc"), { recursive: true })
    writeFileSync(join(src, "openai-plugins-0123abc", "marker"), "ok")
    const tarball = await buildTarballBytes(src)

    // commits API 设为 404,只要 tarball 顶层能解析就不应该被调用。
    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: null })
    const result = await fetchHttpSource({
      url: "https://github.com/openai/plugins",
      destination: dir,
      fetchImpl,
    })
    expect(result.revision).toBe("0123abc")
    expect(requests.some((u) => u.includes("/commits/"))).toBe(false)
  })

  test("tarball 顶层非标准 → 回退到 commits API", async () => {
    const dir = mkdtempSync(join(tmpRoot, "fallback-"))
    const src = mkdtempSync(join(tmpRoot, "fallback-src-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "ok")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: "from-api-xyz" })
    const result = await fetchHttpSource({
      url: "https://github.com/owner/repo",
      destination: dir,
      fetchImpl,
    })
    expect(result.revision).toBe("from-api-xyz")
    expect(requests.some((u) => u.includes("/commits/"))).toBe(true)
  })
})

describe("getRemoteRevision: 反代 fallback + content-type sniff", () => {
  test("api.github.com 失败时尝试 ghfast.top 反代", async () => {
    const requests: string[] = []
    const fetchImpl: FetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      requests.push(url)
      if (url.startsWith("https://api.github.com/")) return new Response("blocked", { status: 503 })
      if (url.includes("ghfast.top")) {
        return new Response(JSON.stringify({ sha: "via-mirror" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("nope", { status: 404 })
    }
    const sha = await getRemoteRevision("https://github.com/owner/repo", "main", fetchImpl)
    expect(sha).toBe("via-mirror")
    expect(requests[0]?.startsWith("https://api.github.com/")).toBe(true)
    expect(requests[1]?.startsWith("https://ghfast.top/")).toBe(true)
  })

  test("HTTP 200 + HTML content-type 被识别并继续 fallback", async () => {
    const requests: string[] = []
    const fetchImpl: FetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
      requests.push(url)
      if (url.startsWith("https://api.github.com/")) {
        return new Response("<html>rate limited</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      if (url.includes("ghfast.top")) {
        return new Response(JSON.stringify({ sha: "ok-sha" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("nope", { status: 404 })
    }
    const sha = await getRemoteRevision("https://github.com/owner/repo", undefined, fetchImpl)
    expect(sha).toBe("ok-sha")
    // 第一个候选返回了 HTML 200,不应该被当成成功
    expect(requests.length).toBeGreaterThanOrEqual(2)
  })
})

describe("refreshHttpSource: isImmutableRef short-circuit", () => {
  test("ref=v1.2.3 + sidecar 存在 + 离线 → 直接返回本地 SHA", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "imm-cached-"))
    writeFileSync(join(cwd, REVISION_FILE), "pinned-sha")

    let called = false
    const fetchImpl: FetchImpl = async () => {
      called = true
      throw new Error("network down")
    }
    const result = await refreshHttpSource({
      cwd,
      url: "https://github.com/owner/repo",
      ref: "v1.2.3",
      fetchImpl,
    })
    expect(result).toEqual({ revision: "pinned-sha", changed: false })
    expect(called).toBe(false)
  })

  test("ref=v1.2.3 + 旧 sparsePaths != 新 sparsePaths → 强制重下", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "imm-resparse-"))
    writeFileSync(
      join(cwd, REVISION_FILE),
      JSON.stringify({ revision: "pinned", sparsePaths: ["plugins/a"] }),
    )
    const src = mkdtempSync(join(tmpRoot, "imm-resparse-src-"))
    mkdirSync(join(src, "owner-repo-cafe123"), { recursive: true })
    writeFileSync(join(src, "owner-repo-cafe123", "marker"), "fresh")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl } = mockFetch({ archiveBytes: tarball })
    const result = await refreshHttpSource({
      cwd,
      url: "https://github.com/owner/repo",
      ref: "v1.2.3",
      sparsePaths: ["plugins/a", "plugins/b"],
      fetchImpl,
    })
    expect(result.changed).toBe(true)
    const sidecar = await readLocalSidecar(cwd)
    expect(sidecar.sparsePaths).toEqual(["plugins/a", "plugins/b"])
  })
})

describe("refreshHttpSource: 浮动 ref + sparse_paths 变更触发重下", () => {
  test("SHA 一致但 sparse_paths 新增 → 重新解包", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "sparse-changed-"))
    writeFileSync(
      join(cwd, REVISION_FILE),
      JSON.stringify({ revision: "abcdef0", sparsePaths: ["plugins/keep"] }),
    )

    const src = mkdtempSync(join(tmpRoot, "sparse-changed-src-"))
    mkdirSync(join(src, "owner-repo-abcdef0"), { recursive: true })
    writeFileSync(join(src, "owner-repo-abcdef0", "marker"), "x")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl } = mockFetch({ archiveBytes: tarball, sha: "abcdef0" })
    const result = await refreshHttpSource({
      cwd,
      url: "https://github.com/owner/repo",
      ref: "main",
      sparsePaths: ["plugins/keep", "plugins/added"],
      fetchImpl,
    })
    expect(result.changed).toBe(true)
    const sidecar = await readLocalSidecar(cwd)
    expect(sidecar.sparsePaths).toEqual(["plugins/added", "plugins/keep"])
  })
})

describe("resolveHttpSource: 仅 GitHub + SSH 归一化", () => {
  test("https://github.com/owner/repo 正常 resolve", () => {
    const r = resolveHttpSource("https://github.com/openai/plugins")
    expect(r).not.toBeNull()
    expect(r?.archiveUrls[0]).toContain("api.github.com/repos/openai/plugins/tarball")
  })

  test("SSH URL git@github.com:owner/repo.git 归一化为 GitHub HTTPS", () => {
    const r = resolveHttpSource("git@github.com:openai/plugins.git")
    expect(r).not.toBeNull()
    expect(r?.archiveUrls[0]).toContain("api.github.com/repos/openai/plugins/tarball")
  })

  test("GitLab URL 不再被识别", () => {
    expect(resolveHttpSource("https://gitlab.com/foo/bar")).toBeNull()
  })

  test("fetchHttpSource 对 GitLab URL 抛 'only GitHub HTTP supported'", async () => {
    const dest = mkdtempSync(join(tmpRoot, "gl-reject-"))
    await expect(
      fetchHttpSource({
        url: "https://gitlab.com/foo/bar",
        destination: dest,
        fetchImpl: async () => new Response("", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(HttpSourceError)
  })
})

describe("fetchHttpSource: knownRevision 避免双调 commits API", () => {
  test("tarball 顶层非 SHA 形态但传了 knownRevision → 不调 commits API", async () => {
    const dest = mkdtempSync(join(tmpRoot, "known-rev-"))
    const src = mkdtempSync(join(tmpRoot, "known-rev-src-"))
    // 顶层用非 hex 形态,确保 tarball SHA 解析失败,会进入兜底分支。
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "x")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: null })
    const result = await fetchHttpSource({
      url: "https://github.com/owner/repo",
      destination: dest,
      knownRevision: "passed-in-sha",
      fetchImpl,
    })
    expect(result.revision).toBe("passed-in-sha")
    expect(requests.some((u) => u.includes("/commits/"))).toBe(false)
    const sidecar = await readLocalSidecar(dest)
    expect(sidecar.revision).toBe("passed-in-sha")
  })

  test("refreshHttpSource 走重下路径时 commits API 只被调一次", async () => {
    const cwd = mkdtempSync(join(tmpRoot, "single-commit-"))
    writeFileSync(
      join(cwd, REVISION_FILE),
      JSON.stringify({ revision: "old-sha", sparsePaths: [] }),
    )
    const src = mkdtempSync(join(tmpRoot, "single-commit-src-"))
    mkdirSync(join(src, "topdir"), { recursive: true })
    writeFileSync(join(src, "topdir", "marker"), "fresh")
    const tarball = await buildTarballBytes(src)

    const { fetchImpl, requests } = mockFetch({ archiveBytes: tarball, sha: "new-sha" })
    const result = await refreshHttpSource({
      cwd,
      url: "https://github.com/owner/repo",
      ref: "main",
      fetchImpl,
    })
    expect(result).toEqual({ revision: "new-sha", changed: true })
    const commitsCalls = requests.filter((u) => u.includes("/commits/")).length
    expect(commitsCalls).toBe(1)
  })
})

describe("fetchArchiveResponse: 非 OK 响应 cancel body", () => {
  test("前置候选 4xx 的 body 被 cancel,不留半读 socket", async () => {
    let cancelCount = 0
    const fetchImpl: FetchImpl = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString()
      if (url.startsWith("https://api.github.com/")) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("rate limit"))
            controller.close()
          },
          cancel() {
            cancelCount += 1
          },
        })
        return new Response(body, { status: 429, headers: { "content-type": "text/plain" } })
      }
      if (url.includes("ghfast.top")) {
        // 直接 200 + 空 body 让 archive fetch 成功结束
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "application/gzip" },
        })
      }
      return new Response("nope", { status: 404 })
    }

    const dest = mkdtempSync(join(tmpRoot, "drain-"))
    // 第二个 URL 200 但 body 不是合法 tarball → tar.extract 会抛,但 fetch 层已经
    // 走完它;我们只关心第一个 4xx 的 body 被 cancel 了。
    await fetchHttpSource({
      url: "https://github.com/owner/repo",
      destination: dest,
      fetchImpl,
    }).catch(() => undefined)

    expect(cancelCount).toBe(1)
  })
})
