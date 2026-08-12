import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const repository = resolve(import.meta.dir, "..")
const lockfile = resolve(repository, "opensource/public-template/bun.lock")

describe("公开 lockfile 安全依赖契约", () => {
  test("实际发版依赖与公开模板 lockfile 精确一致", async () => {
    const contents = await Bun.file(existsSync(lockfile) ? lockfile : resolve(repository, "bun.lock")).text()
    const dependencies = [
      ["packages/app/package.json", "pdfjs-dist"],
      ["packages/desktop/package.json", "electron"],
      ["packages/opencode/package.json", "undici"],
      ["packages/opencode/package.json", "ws"],
    ] as const

    for (const [path, name] of dependencies) {
      const manifest = await Bun.file(resolve(repository, path)).json()
      const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
      expect(version).toBeString()
      expect(contents).toContain(`"${name}": ["${name}@${version}"`)
    }
  })

  test("未使用的 opencode minimatch 不回流公开 lockfile", async () => {
    const contents = await Bun.file(existsSync(lockfile) ? lockfile : resolve(repository, "bun.lock")).text()
    expect(contents).not.toContain('"opencode/minimatch"')
  })
})
