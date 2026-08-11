import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const nativeTest = process.platform === "darwin" ? test : test.skip

describe("app snapshot native helper", () => {
  nativeTest("keeps text limits safe and selects the focused window across displays", () => {
    const output = join(tmpdir(), `app-snapshot-helper-test-${process.pid}`)
    const moduleCache = `${output}-modules`
    try {
      const compile = Bun.spawnSync([
        "xcrun",
        "clang",
        "-fobjc-arc",
        "-fmodules",
        `-fmodules-cache-path=${moduleCache}`,
        "-mmacosx-version-min=12.0",
        join(import.meta.dir, "../../native/app-snapshot-helper.test.m"),
        "-O",
        "-framework",
        "Cocoa",
        "-framework",
        "ApplicationServices",
        "-o",
        output,
      ])
      expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0)

      const run = Bun.spawnSync([output])
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
    } finally {
      rmSync(output, { force: true })
      rmSync(moduleCache, { force: true, recursive: true })
    }
  })
})
