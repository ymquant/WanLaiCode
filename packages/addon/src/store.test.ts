import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { activeAddonVersion, addonCacheRoot, addonRoot } from "./store"

let rootTmpDir: string

beforeAll(() => {
  rootTmpDir = mkdtempSync(join(tmpdir(), "addon-store-test-"))
})

afterAll(() => {
  rmSync(rootTmpDir, { recursive: true, force: true })
})

function versionsDir(name: string, versions: string[]) {
  const dir = join(rootTmpDir, name)
  for (const version of versions) {
    mkdirSync(join(dir, version), { recursive: true })
  }
  return dir
}

describe("store paths", () => {
  test("builds cache and addon roots", () => {
    expect(addonCacheRoot("/tmp/oc")).toBe("/tmp/oc/plugins/cache")
    expect(addonRoot("/tmp/oc/plugins/cache", "openai", "github", "local")).toBe(
      "/tmp/oc/plugins/cache/openai/github/local",
    )
  })
})

describe("activeAddonVersion", () => {
  test("prefers local over sorted versions", async () => {
    expect(await activeAddonVersion(versionsDir("prefers-local", ["0.1.0", "local", "9.9.9"]))).toBe("local")
  })

  test("returns the largest valid version by semver", async () => {
    expect(await activeAddonVersion(versionsDir("largest", ["0.1.0", "0.2.0", "1.0.0-beta"]))).toBe("1.0.0-beta")
  })

  test("orders versions numerically, not lexicographically", async () => {
    expect(await activeAddonVersion(versionsDir("semver-order", ["0.9.0", "0.10.0", "0.2.0"]))).toBe("0.10.0")
  })

  test("filters invalid version segments", async () => {
    expect(await activeAddonVersion(versionsDir("invalid", ["bad$version", "0.1.0", "bad version"]))).toBe("0.1.0")
  })

  test("returns undefined when no valid version exists", async () => {
    expect(await activeAddonVersion(versionsDir("empty", ["bad version"]))).toBeUndefined()
  })
})
