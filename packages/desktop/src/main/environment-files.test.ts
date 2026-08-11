import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  assertHttpExternalUrl,
  assertSystemBrowserUrl,
  assertLocalPath,
  assertUserDirectoryPath,
  environmentProjectKey,
  environmentsRoot,
  resolveEnvironmentFilePath,
  resolveEnvironmentFilePathFromWorktree,
  resolveEnvironmentProjectDir,
  resolveEnvironmentProjectDirFromWorktree,
  tryResolveEnvironmentFilePathFromWorktree,
  tryResolveEnvironmentProjectDirFromWorktree,
} from "./environment-files"

describe("environment file paths", () => {
  // 使用当前平台的临时目录验证路径拼接，避免 macOS/Linux 把 Windows 盘符误判为相对路径。
  const root = environmentsRoot(join(os.tmpdir(), "ai.wanlaicode.desktop"))

  test("resolves project dir under environments root", () => {
    expect(resolveEnvironmentProjectDir(root, "my-project")).toBe(join(root, "my-project"))
  })

  test("rejects traversal in project name", () => {
    expect(() => resolveEnvironmentProjectDir(root, "..\\secrets")).toThrow("Invalid environment project")
    expect(() => resolveEnvironmentProjectDir(root, "..")).toThrow("Invalid environment project")
  })

  test("resolves toml file under project dir", () => {
    expect(resolveEnvironmentFilePath(root, "demo", "environment.toml")).toBe(
      join(root, "demo", "environment.toml"),
    )
  })

  test("rejects traversal in filename", () => {
    expect(() => resolveEnvironmentFilePath(root, "demo", "..\\..\\secrets.toml")).toThrow(
      "Invalid environment file",
    )
    expect(() => resolveEnvironmentFilePath(root, "demo", "notes.txt")).toThrow("Invalid environment file")
  })
})

describe("environment worktree keys", () => {
  test("uses stable hash keys per worktree", () => {
    const a = environmentProjectKey("C:\\Projects\\demo")
    const b = environmentProjectKey("D:\\Other\\demo")
    expect(a).not.toBe(b)
    expect(a).toHaveLength(16)
  })

  test("distinct keys when normalize would collapse paths", () => {
    expect(environmentProjectKey("/")).not.toBe(environmentProjectKey("//"))
  })

  test("resolves global worktree without throwing", () => {
    const root = environmentsRoot(join(os.tmpdir(), `global-worktree-${Date.now()}`))
    rmSync(root, { recursive: true, force: true })

    expect(() => resolveEnvironmentProjectDirFromWorktree(root, "/")).not.toThrow()
    expect(() => resolveEnvironmentProjectDirFromWorktree(root, "//")).not.toThrow()

    rmSync(root, { recursive: true, force: true })
  })

  test("migrates legacy empty-normalize hash directory", () => {
    const root = environmentsRoot(join(os.tmpdir(), `empty-key-migrate-${Date.now()}`))
    const worktree = "/"
    const key = environmentProjectKey(worktree)
    const legacyEmptyDir = resolveEnvironmentProjectDir(
      root,
      createHash("sha256").update("").digest("hex").slice(0, 16),
    )
    rmSync(root, { recursive: true, force: true })
    mkdirSync(legacyEmptyDir, { recursive: true })
    writeFileSync(join(legacyEmptyDir, "environment.toml"), "name = \"legacy-empty\"\n")

    const dir = resolveEnvironmentProjectDirFromWorktree(root, worktree)
    expect(dir).toBe(resolveEnvironmentProjectDir(root, key))
    expect(resolveEnvironmentFilePathFromWorktree(root, worktree, "environment.toml")).toContain("environment.toml")

    rmSync(root, { recursive: true, force: true })
  })

  test("does not migrate empty-normalize hash dir for unrelated worktrees", () => {
    const root = environmentsRoot(join(os.tmpdir(), `empty-key-no-steal-${Date.now()}`))
    const legacyEmptyDir = resolveEnvironmentProjectDir(
      root,
      createHash("sha256").update("").digest("hex").slice(0, 16),
    )
    rmSync(root, { recursive: true, force: true })
    mkdirSync(legacyEmptyDir, { recursive: true })

    const worktree = "C:/Projects/demo"
    const key = environmentProjectKey(worktree)
    const dir = resolveEnvironmentProjectDirFromWorktree(root, worktree)

    expect(dir).toBe(resolveEnvironmentProjectDir(root, key))
    expect(dir).not.toBe(legacyEmptyDir)

    rmSync(root, { recursive: true, force: true })
  })

  test("// does not steal legacy empty-normalize hash before canonical /", () => {
    const root = environmentsRoot(join(os.tmpdir(), `empty-key-slash-slash-${Date.now()}`))
    const legacyEmptyDir = resolveEnvironmentProjectDir(
      root,
      createHash("sha256").update("").digest("hex").slice(0, 16),
    )
    rmSync(root, { recursive: true, force: true })
    mkdirSync(legacyEmptyDir, { recursive: true })
    writeFileSync(join(legacyEmptyDir, "environment.toml"), "name = \"legacy-empty\"\n")

    const doubleSlashDir = resolveEnvironmentProjectDirFromWorktree(root, "//")
    expect(doubleSlashDir).toBe(resolveEnvironmentProjectDir(root, environmentProjectKey("//")))
    expect(existsSync(legacyEmptyDir)).toBe(true)

    const slashDir = resolveEnvironmentProjectDirFromWorktree(root, "/")
    expect(slashDir).toBe(resolveEnvironmentProjectDir(root, environmentProjectKey("/")))
    expect(resolveEnvironmentFilePathFromWorktree(root, "/", "environment.toml")).toContain("environment.toml")
    expect(existsSync(legacyEmptyDir)).toBe(false)

    rmSync(root, { recursive: true, force: true })
  })

  test("migrates legacy basename directory on first access", () => {
    const suffix = `migrate-test-${Date.now()}`
    const root = environmentsRoot(join(os.tmpdir(), suffix))
    const worktree = join("C:\\Projects", suffix)
    const key = environmentProjectKey(worktree)
    const legacyDir = resolveEnvironmentProjectDir(root, suffix)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, "environment.toml"), "name = \"legacy\"\n")

    const dir = resolveEnvironmentProjectDirFromWorktree(root, worktree)
    expect(dir).toBe(resolveEnvironmentProjectDir(root, key))
    expect(resolveEnvironmentFilePathFromWorktree(root, worktree, "environment.toml")).toContain("environment.toml")

    rmSync(root, { recursive: true, force: true })
  })

  test("skips legacy migration for worktrees with invalid basenames", () => {
    const root = environmentsRoot(join(os.tmpdir(), `invalid-legacy-${Date.now()}`))
    rmSync(root, { recursive: true, force: true })

    for (const worktree of ["/", "C:/foo/.", "C:/foo/..", "D:/"]) {
      const key = environmentProjectKey(worktree)
      expect(resolveEnvironmentProjectDirFromWorktree(root, worktree)).toBe(resolveEnvironmentProjectDir(root, key))
    }

    rmSync(root, { recursive: true, force: true })
  })

  test("tryResolve helpers reject invalid worktree without throwing", () => {
    const root = environmentsRoot(join(os.tmpdir(), `try-resolve-${Date.now()}`))
    expect(tryResolveEnvironmentProjectDirFromWorktree(root, "")).toBeUndefined()
    expect(tryResolveEnvironmentFilePathFromWorktree(root, "", "environment.toml")).toBeUndefined()
    expect(tryResolveEnvironmentFilePathFromWorktree(root, "C:\\Projects\\demo", "notes.txt")).toBeUndefined()
  })
})

describe("assertHttpExternalUrl", () => {
  test("allows http and https", () => {
    expect(assertHttpExternalUrl("https://example.com/path")).toBe("https://example.com/path")
    expect(assertHttpExternalUrl("http://localhost:8080")).toBe("http://localhost:8080/")
  })

  test("rejects other protocols", () => {
    expect(() => assertHttpExternalUrl("file:///etc/passwd")).toThrow("Only http(s) URLs can be opened")
    expect(() => assertHttpExternalUrl("javascript:alert(1)")).toThrow("Only http(s) URLs can be opened")
    expect(() => assertHttpExternalUrl("not-a-url")).toThrow("Invalid URL")
  })
})

describe("assertSystemBrowserUrl", () => {
  test("allows http and https", () => {
    expect(assertSystemBrowserUrl("https://example.com/path")).toBe("https://example.com/path")
    expect(assertSystemBrowserUrl("http://localhost:8080")).toBe("http://localhost:8080/")
  })

  test("allows local html file URLs", () => {
    expect(assertSystemBrowserUrl("file:///C:/workspace/report.html")).toBe("file:///C:/workspace/report.html")
    expect(assertSystemBrowserUrl("file:///C:/workspace/report.htm")).toBe("file:///C:/workspace/report.htm")
  })

  test("rejects non-html file URLs and other protocols", () => {
    expect(() => assertSystemBrowserUrl("file:///C:/workspace/readme.ts")).toThrow(
      "Only http(s) or local HTML file URLs can be opened",
    )
    expect(() => assertSystemBrowserUrl("file:///C:/workspace/archive.zip")).toThrow(
      "Only http(s) or local HTML file URLs can be opened",
    )
    expect(() => assertSystemBrowserUrl("file://server/share/report.html")).toThrow(
      "Only http(s) or local HTML file URLs can be opened",
    )
    expect(() => assertSystemBrowserUrl("javascript:alert(1)")).toThrow(
      "Only http(s) or local HTML file URLs can be opened",
    )
    expect(() => assertSystemBrowserUrl("not-a-url")).toThrow("Invalid URL")
  })

  // 回归：四斜杠 UNC 形式 `file:////server/share/report.html` 的 host 为空，
  // 能绕过 host 检查；某些运行时（如 bun）的 fileURLToPath 会返回 UNC 路径而非抛错，
  // 因此必须在解码后按网络路径前缀（`\\` 或 `//`）兜底拒绝。
  test("rejects four-slash UNC file URLs that bypass the host check", () => {
    expect(() => assertSystemBrowserUrl("file:////server/share/report.html")).toThrow(
      "Only http(s) or local HTML file URLs can be opened",
    )
    expect(() => assertSystemBrowserUrl("file:////server/share/report.htm")).toThrow(
      "Only http(s) or local HTML file URLs can be opened",
    )
  })
})

describe("assertLocalPath", () => {
  test("accepts normal paths", () => {
    expect(assertLocalPath("C:\\Users\\me\\Documents")).toBe("C:\\Users\\me\\Documents")
    expect(assertUserDirectoryPath("C:\\Users\\me\\Documents")).toBe("C:\\Users\\me\\Documents")
  })

  test("rejects control characters", () => {
    expect(() => assertLocalPath("bad\npath")).toThrow("Invalid path")
    expect(() => assertLocalPath("")).toThrow("Invalid path")
  })
})
