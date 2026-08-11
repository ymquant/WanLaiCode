import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"
import { cloneRemoteTar } from "../src/installer"

async function makePluginTar(): Promise<Buffer> {
  const work = await mkdtemp(path.join(tmpdir(), "reg-src-"))
  await mkdir(path.join(work, ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(work, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  )
  const tarPath = path.join(work, "out.tar")
  // 实际 registry tar 带顶层 <ns>-<slug>/ 壳目录（strip 1）：这里包一层 wrapper/ 模拟。
  const wrapperDir = path.join(work, "wrapper")
  await mkdir(wrapperDir, { recursive: true })
  await mkdir(path.join(wrapperDir, ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(wrapperDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  )
  spawnSync("tar", ["-cf", tarPath, "-C", work, "wrapper"])
  return readFile(tarPath)
}

describe("cloneRemoteTar", () => {
  test("从 URL 下载 tar 解包出 .codex-plugin/plugin.json", async () => {
    const tarBuf = await makePluginTar()
    const dest = await mkdtemp(path.join(tmpdir(), "reg-dest-"))
    await cloneRemoteTar({
      url: "http://host/download",
      destination: dest,
      strip: 1,
      fetchImpl: async () => new Response(tarBuf, { status: 200 }),
    })
    const manifest = JSON.parse(await readFile(path.join(dest, ".codex-plugin", "plugin.json"), "utf-8"))
    expect(manifest.name).toBe("demo")
    await rm(dest, { recursive: true, force: true })
  })
})
