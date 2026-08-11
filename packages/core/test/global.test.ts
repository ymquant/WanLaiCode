import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global, resolveAppDir } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "wanlaicode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})

describe("resolveAppDir", () => {
  test("returns the wanlaicode dir under the given parent", () => {
    expect(resolveAppDir("/some/parent")).toBe(path.join("/some/parent", "wanlaicode"))
  })

  test("never touches a pre-existing opencode directory", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wanlaicode-collision-"))
    const opencodeDir = path.join(parent, "opencode")
    const marker = path.join(opencodeDir, "marker.txt")
    await fs.mkdir(opencodeDir, { recursive: true })
    await fs.writeFile(marker, "official opencode data")

    const resolved = resolveAppDir(parent)

    // wanlaicode must use its own dir...
    expect(resolved).toBe(path.join(parent, "wanlaicode"))
    // ...and the user's opencode install must remain untouched.
    expect((await fs.stat(opencodeDir)).isDirectory()).toBe(true)
    expect(await fs.readFile(marker, "utf8")).toBe("official opencode data")
    // no wanlaicode dir should be conjured by renaming opencode away.
    await expect(fs.access(path.join(parent, "wanlaicode"))).rejects.toThrow()

    await fs.rm(parent, { recursive: true, force: true })
  })
})
