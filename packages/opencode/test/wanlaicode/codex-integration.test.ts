import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "fs/promises"
import os from "os"
import {
  codexIntegrationPaths,
  codexIntegrationStatus,
  installCodexIntegration,
  restoreCodexIntegration,
} from "../../src/server/routes/instance/httpapi/handlers/wanlaicode-user-center-integrations/codex"

const homes: string[] = []

async function testHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "wanlaicodex-codex-integration-"))
  homes.push(home)
  return home
}

async function read(pathname: string) {
  return readFile(pathname, "utf8").catch(() => "")
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe("WanlaiCode Codex integration", () => {
  test("creates Codex config and auth in an empty home", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)

    await installCodexIntegration({ home, apiKey: "sk-test", baseUrl: "https://api.wanlai.ai/v1" })

    expect(await codexIntegrationStatus(home)).toMatchObject({ installed: true, restorable: true })
    expect(await read(paths.config)).toContain("[model_providers.wanlai]")
    expect(await read(paths.config)).toContain("[model_providers.wanlai.auth]")
    // TOML 序列化时把 `\` 转义成 `\\`，Windows path 必须同样转义后再比较
    expect(await read(paths.config)).toContain(paths.tokenCommand.replace(/\\/g, "\\\\"))
    expect(JSON.parse(await read(paths.auth))).toMatchObject({ OPENAI_API_KEY: "sk-test" })
    expect(await read(paths.tokenCommand)).toContain("OPENAI_API_KEY")
  })

  test("repeated import replaces Wanlai provider without duplicates", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)

    await installCodexIntegration({ home, apiKey: "sk-first", baseUrl: "https://api.wanlai.ai/v1" })
    await installCodexIntegration({ home, apiKey: "sk-next", baseUrl: "https://api.wanlai.ai/v1" })

    const config = await read(paths.config)
    expect(config.match(/\[model_providers\.wanlai\]/g)?.length).toBe(1)
    expect(JSON.parse(await read(paths.auth))).toMatchObject({ OPENAI_API_KEY: "sk-next" })
  })

  test("token command reads the imported API key", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)

    await installCodexIntegration({ home, apiKey: 'sk-test"quoted', baseUrl: "https://api.wanlai.ai/v1" })

    // Windows 的 token command 是 .cmd 文件——需要 cmd.exe 包装、用 %USERPROFILE%
    // 找 auth；Unix 的 .sh 用 ${HOME}。trim 容忍 Windows 输出的 \r\n。
    const cmd = process.platform === "win32" ? ["cmd.exe", "/c", paths.tokenCommand] : [paths.tokenCommand]
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect((await new Response(proc.stdout).text()).trim()).toBe('sk-test"quoted')
    expect(await proc.exited).toBe(0)
  })

  test.skipIf(process.platform === "win32")("token command works without node or bun on PATH", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    const bin = path.join(home, "bin")

    await installCodexIntegration({ home, apiKey: 'sk-no-node"bun', baseUrl: "https://api.wanlai.ai/v1" })
    await mkdir(bin, { recursive: true })
    await symlink(Bun.which("awk") ?? "/usr/bin/awk", path.join(bin, "awk"))

    const proc = Bun.spawn([paths.tokenCommand], {
      env: { HOME: home, USERPROFILE: home, PATH: bin },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect((await new Response(proc.stdout).text()).trim()).toBe('sk-no-node"bun')
    expect((await new Response(proc.stderr).text()).trim()).toBe("")
    expect(await proc.exited).toBe(0)
  })

  test("creates a Windows token command", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home, "win32")

    await installCodexIntegration({ home, platform: "win32", apiKey: "sk-test", baseUrl: "https://api.wanlai.ai/v1" })

    expect(paths.tokenCommand.endsWith("wanlai-codex-token.cmd")).toBe(true)
    expect(await codexIntegrationStatus(home, "win32")).toMatchObject({ installed: true, restorable: true })
    expect(await read(paths.config)).toContain("wanlai-codex-token.cmd")
    expect(await read(paths.tokenCommand)).toContain("ConvertFrom-Json")
  })

  test("old OpenAI-auth import is restorable but not treated as installed", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.config,
      `model_provider = "wanlai"

[model_providers.wanlai]
name = "Wanlai"
base_url = "https://api.wanlai.ai/v1"
wire_api = "responses"
requires_openai_auth = true
`,
    )

    expect(await codexIntegrationStatus(home)).toMatchObject({ installed: false, restorable: true })
  })

  test("missing token command or API key is not treated as installed", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)

    await installCodexIntegration({ home, apiKey: "sk-test", baseUrl: "https://api.wanlai.ai/v1" })
    await rm(paths.tokenCommand, { force: true })
    expect(await codexIntegrationStatus(home)).toMatchObject({ installed: false, restorable: true })

    await installCodexIntegration({ home, apiKey: "sk-test", baseUrl: "https://api.wanlai.ai/v1" })
    await writeFile(paths.auth, JSON.stringify({}, null, 2) + "\n")
    expect(await codexIntegrationStatus(home)).toMatchObject({ installed: false, restorable: true })
  })

  test("orphan auth backup alone is not restorable", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(`${paths.auth}.wanlai.bak-20260101000000`, JSON.stringify({ OPENAI_API_KEY: "sk-openai" }))

    expect(await codexIntegrationStatus(home)).toMatchObject({ installed: false, restorable: false })
  })

  test("preserves unrelated Codex config while importing", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.config,
      `notify = true

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
`,
    )

    await installCodexIntegration({ home, apiKey: "sk-test", baseUrl: "https://api.wanlai.ai/v1" })

    const config = await read(paths.config)
    expect(config).toContain("notify = true")
    expect(config).toContain("[model_providers.openai]")
    expect(config).toContain("[model_providers.wanlai]")
  })

  test("restores from backup", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.config, 'model_provider = "openai"\n')
    await writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: "sk-openai" }, null, 2) + "\n")

    await installCodexIntegration({ home, apiKey: "sk-wanlai", baseUrl: "https://api.wanlai.ai/v1" })
    await installCodexIntegration({ home, apiKey: "sk-wanlai-next", baseUrl: "https://api.wanlai.ai/v1" })
    await restoreCodexIntegration(home)

    expect(await read(paths.config)).toBe('model_provider = "openai"\n')
    expect(JSON.parse(await read(paths.auth))).toMatchObject({ OPENAI_API_KEY: "sk-openai" })
    expect(await codexIntegrationStatus(home)).toMatchObject({ installed: false })
  })

  test("restore does not overwrite auth changed after import", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.config, 'model_provider = "openai"\n')
    await writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: "sk-openai" }, null, 2) + "\n")

    await installCodexIntegration({ home, apiKey: "sk-wanlai", baseUrl: "https://api.wanlai.ai/v1" })
    await writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: "sk-user-new" }, null, 2) + "\n")
    await restoreCodexIntegration(home)

    expect(JSON.parse(await read(paths.auth))).toMatchObject({ OPENAI_API_KEY: "sk-user-new" })
  })

  test("restore keeps auth changed before repeated import", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: "sk-openai" }, null, 2) + "\n")

    await installCodexIntegration({ home, apiKey: "sk-wanlai", baseUrl: "https://api.wanlai.ai/v1" })
    await writeFile(paths.auth, JSON.stringify({ OPENAI_API_KEY: "sk-user-new" }, null, 2) + "\n")
    await installCodexIntegration({ home, apiKey: "sk-wanlai-next", baseUrl: "https://api.wanlai.ai/v1" })
    await restoreCodexIntegration(home)

    expect(JSON.parse(await read(paths.auth))).toMatchObject({ OPENAI_API_KEY: "sk-user-new" })
  })

  test("restore removes managed auth key when there was no previous auth key", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)

    await installCodexIntegration({ home, apiKey: "sk-wanlai", baseUrl: "https://api.wanlai.ai/v1" })
    await restoreCodexIntegration(home)

    expect(await read(paths.auth)).toBe("")
  })

  test("restore without metadata uses the latest backup", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(`${paths.config}.wanlai.bak-20260101000000`, 'model_provider = "old"\n')
    await writeFile(`${paths.config}.wanlai.bak-20260102000000`, 'model_provider = "new"\n')
    await writeFile(
      paths.config,
      `# BEGIN WANLAICODE MANAGED TOPLEVEL
model_provider = "wanlai"
# END WANLAICODE MANAGED TOPLEVEL
`,
    )

    await restoreCodexIntegration(home)

    expect(await read(paths.config)).toBe('model_provider = "new"\n')
  })

  test("restore without backup removes only Wanlai config", async () => {
    const home = await testHome()
    const paths = codexIntegrationPaths(home)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.config,
      `# BEGIN WANLAICODE MANAGED TOPLEVEL
model_provider = "wanlai"
model = "gpt-5.2-codex"
model_reasoning_effort = "high"
disable_response_storage = true
# END WANLAICODE MANAGED TOPLEVEL

notify = true

# BEGIN WANLAICODE MANAGED PROVIDER
[model_providers.wanlai]
name = "Wanlai"
base_url = "https://api.wanlai.ai/v1"
wire_api = "responses"

[model_providers.wanlai.auth]
command = "/tmp/wanlai-codex-token.sh"
# END WANLAICODE MANAGED PROVIDER

[model_providers.openai]
name = "OpenAI"
`,
    )

    await restoreCodexIntegration(home)

    const config = await read(paths.config)
    expect(config).not.toContain('model_provider = "wanlai"')
    expect(config).not.toContain("[model_providers.wanlai]")
    expect(config).not.toContain("[model_providers.wanlai.auth]")
    expect(config).toContain("notify = true")
    expect(config).toContain("[model_providers.openai]")
  })
})
