import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import * as tar from "tar"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { AddonPaths } from "../../src/server/routes/instance/httpapi/groups/addon"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI
const context = Context.empty() as Context.Context<unknown>

function globalConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME!, "wanlaicode")
}

function globalConfigFile() {
  return path.join(globalConfigDir(), "wanlaicode.jsonc")
}

async function writeGlobalConfig(content: Record<string, unknown>) {
  await mkdir(globalConfigDir(), { recursive: true })
  await writeFile(globalConfigFile(), JSON.stringify(content))
}

async function clearGlobalConfig() {
  await rm(globalConfigDir(), { recursive: true, force: true })
  await mkdir(globalConfigDir(), { recursive: true })
}

// Each test gets its own webHandler with a fresh Layer.MemoMap so the
// service-level Config cache (cachedGlobal) doesn't leak across tests.
let handler: ReturnType<typeof ExperimentalHttpApiServer.webHandler>["handler"]
function request(route: string, directory: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

async function writeMarketplace(
  root: string,
  options: {
    marketplaceName?: string
    addonName?: string
    installation?: "AVAILABLE" | "NOT_AVAILABLE"
    skill?: string
  } = {},
) {
  const marketplaceName = options.marketplaceName ?? "fixture-market"
  const addonName = options.addonName ?? "hello"
  const installation = options.installation ?? "AVAILABLE"

  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true })
  await writeFile(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: marketplaceName,
      plugins: [
        {
          name: addonName,
          source: `./${addonName}`,
          policy: { installation },
        },
      ],
    }),
  )
  await mkdir(path.join(root, addonName, ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(root, addonName, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: addonName,
      version: "0.1.0",
      description: "fixture addon",
      ...(options.skill ? { skills: "skills" } : {}),
    }),
  )
  if (options.skill) {
    await mkdir(path.join(root, addonName, "skills", options.skill), { recursive: true })
    await writeFile(
      path.join(root, addonName, "skills", options.skill, "SKILL.md"),
      `---\nname: ${options.skill}\ndescription: fixture addon skill\n---\n\n# ${options.skill}\n`,
    )
  }
}

beforeEach(async () => {
  await clearGlobalConfig()
  // Use a per-test handler so the service-level Config cache (cachedGlobal) doesn't leak across tests.
  handler = ExperimentalHttpApiServer.webHandler({ cors: ["http://localhost"] }).handler
})

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
  await clearGlobalConfig()
})

describe("addon HttpApi", () => {
  test("list returns empty when no addons configured", async () => {
    await using project = await tmpdir({ config: { formatter: false, lsp: false } })
    const response = await request(AddonPaths.list, project.path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test("install + list + get + uninstall round-trip", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

    await writeGlobalConfig({
      $schema: "https://opencode.ai/config.json",
      marketplaces: {
        "fixture-market": { source_type: "local", source: source.path },
      },
    })

    const installResp = await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market" }),
    })
    expect(installResp.status).toBe(200)
    const outcome = (await installResp.json()) as {
      key: string
      version: string
      installed_path: string
      auth_policy: string
    }
    expect(outcome.key).toBe("hello@fixture-market")
    expect(outcome.version).toBe("0.1.0")
    expect(outcome.auth_policy).toBe("ON_INSTALL")
    // path.join 用 OS 原生分隔符（Windows \、Unix /），避免硬编码 "/" 让 Windows 假阴。
    expect(outcome.installed_path.endsWith(path.join("fixture-market", "hello", "0.1.0"))).toBe(true)

    const listResp = await request(AddonPaths.list, project.path)
    expect(listResp.status).toBe(200)
    const list = (await listResp.json()) as Array<Record<string, unknown>>
    // The loader returns one entry per (addonId, root) so an installed addon
    // shows up both at its marketplace source path and at the cache path. Both
    // entries should describe the same addon — verify at least one matches.
    expect(list.length).toBeGreaterThanOrEqual(1)
    const hit = list.find((entry) => entry.key === "hello@fixture-market")
    expect(hit).toMatchObject({
      key: "hello@fixture-market",
      name: "hello",
      version: "0.1.0",
      description: "fixture addon",
      marketplace_name: "fixture-market",
      disabled: false,
      counts: { mcp_servers: 0, skills: 0, hooks: 0, unsupported_hooks: 0 },
    })

    const detailResp = await request(`/addon/${encodeURIComponent("hello@fixture-market")}`, project.path)
    expect(detailResp.status).toBe(200)
    const detail = (await detailResp.json()) as Record<string, unknown>
    expect(detail).toMatchObject({
      key: "hello@fixture-market",
      name: "hello",
      version: "0.1.0",
      mcp_servers: {},
      skills: [],
      hooks: [],
      unsupported_hook_events: [],
    })
    expect(typeof detail.root).toBe("string")

    const uninstallResp = await request(AddonPaths.uninstall, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market" }),
    })
    expect(uninstallResp.status).toBe(200)
    expect(await uninstallResp.json()).toEqual({ key: "hello@fixture-market" })

    const listAfter = await request(AddonPaths.list, project.path)
    expect(listAfter.status).toBe(200)
    const after = (await listAfter.json()) as Array<Record<string, unknown>>
    // After uninstall the cache entry is gone, but the marketplace source
    // entry may still appear (uninstall removes the cache + plugins config
    // entry, not the marketplace itself). Verify the count dropped.
    expect(after.length).toBeLessThan(list.length)
  })

  test("installArchive installs a local tar package as a personal plugin", async () => {
    await using project = await tmpdir()
    await using archive = await tmpdir({
      init: async (dir) => {
        await mkdir(path.join(dir, ".codex-plugin"), { recursive: true })
        await writeFile(
          path.join(dir, ".codex-plugin", "plugin.json"),
          JSON.stringify({ name: "archive-demo", version: "2.0.0" }),
        )
        await tar.c({ cwd: dir, file: path.join(dir, "archive-demo.tar") }, [".codex-plugin"])
      },
    })

    const response = await request(AddonPaths.installArchive, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archive_path: path.join(archive.path, "archive-demo.tar") }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      key: "archive-demo@personal",
      version: "2.0.0",
      auth_policy: "ON_USE",
    })

    const list = (await (await request(AddonPaths.list, project.path)).json()) as Array<Record<string, unknown>>
    expect(list.some((item) => item.key === "archive-demo@personal" && item.disabled === false)).toBe(true)

    await request(AddonPaths.uninstall, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "archive-demo@personal" }),
    })
  })

  test("previewArchive returns local plugin metadata without installing", async () => {
    await using project = await tmpdir()
    await using archive = await tmpdir({
      init: async (dir) => {
        await mkdir(path.join(dir, "package", ".codex-plugin"), { recursive: true })
        await writeFile(
          path.join(dir, "package", ".codex-plugin", "plugin.json"),
          JSON.stringify({
            name: "preview-http-demo",
            version: "3.0.0",
            description: "Manifest description",
            interface: {
              displayName: "Preview HTTP Demo",
              shortDescription: "Preview before install",
              developerName: "Acme",
              capabilities: ["network"],
              locales: {
                zh: {
                  displayName: "HTTP 预览演示",
                  shortDescription: "中文预览简介",
                },
              },
            },
          }),
        )
        await tar.c({ cwd: dir, file: path.join(dir, "preview-http-demo.tgz"), gzip: true }, ["package"])
      },
    })

    const response = await request(AddonPaths.previewArchive, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archive_path: path.join(archive.path, "preview-http-demo.tgz"), locale: "zh" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      key: "preview-http-demo@personal",
      name: "preview-http-demo",
      version: "3.0.0",
      display_name: "HTTP 预览演示",
      description: "中文预览简介",
      developer_name: "Acme",
      capabilities: ["network"],
      installation: "AVAILABLE",
      installed: false,
    })

    const list = (await (await request(AddonPaths.list, project.path)).json()) as Array<Record<string, unknown>>
    expect(list.some((item) => item.key === "preview-http-demo@personal")).toBe(false)
  })

  test("installArchive returns 400 for an unsupported local package", async () => {
    await using project = await tmpdir()
    await using archive = await tmpdir({
      init: (dir) => writeFile(path.join(dir, "archive-demo.zip"), "not a supported archive"),
    })

    const response = await request(AddonPaths.installArchive, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archive_path: path.join(archive.path, "archive-demo.zip") }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "local addon archive must use .tar, .tar.gz, or .tgz" })
  })

  test("toggle disables and re-enables an installed addon", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

    await writeGlobalConfig({
      $schema: "https://opencode.ai/config.json",
      marketplaces: {
        "fixture-market": { source_type: "local", source: source.path },
      },
    })

    const installResp = await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market" }),
    })
    expect(installResp.status).toBe(200)

    const findHit = async () => {
      const listResp = await request(AddonPaths.list, project.path)
      expect(listResp.status).toBe(200)
      const list = (await listResp.json()) as Array<Record<string, unknown>>
      return list.find((entry) => entry.key === "hello@fixture-market")
    }

    // available 列表带 disabled 字段,聊天框 @ 插件列表依赖它过滤禁用插件。
    const findAvailable = async () => {
      const resp = await request(AddonPaths.available, project.path)
      expect(resp.status).toBe(200)
      const list = (await resp.json()) as Array<Record<string, unknown>>
      return list.find((entry) => entry.key === "hello@fixture-market")
    }

    expect(await findHit()).toMatchObject({ disabled: false })

    const disableResp = await request(AddonPaths.toggle, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market", enabled: false }),
    })
    expect(disableResp.status).toBe(200)
    expect(await disableResp.json()).toEqual({ ok: true })
    expect(await findHit()).toMatchObject({ disabled: true })
    expect(await findAvailable()).toMatchObject({ installed: true, disabled: true })

    const enableResp = await request(AddonPaths.toggle, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market", enabled: true }),
    })
    expect(enableResp.status).toBe(200)
    expect(await enableResp.json()).toEqual({ ok: true })
    expect(await findHit()).toMatchObject({ disabled: false })
  })

  test("disabling an addon removes its skill from the command list live", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir({ init: (dir) => writeMarketplace(dir, { skill: "greet" }) })

    await writeGlobalConfig({
      $schema: "https://opencode.ai/config.json",
      marketplaces: {
        "fixture-market": { source_type: "local", source: source.path },
      },
    })

    await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market" }),
    })

    const commandNames = async () => {
      const resp = await request("/command", project.path)
      expect(resp.status).toBe(200)
      const list = (await resp.json()) as Array<{ name: string }>
      return list.map((c) => c.name)
    }

    // addon skills are namespaced <addon>:<skill> in the command list
    expect(await commandNames()).toContain("hello:greet")

    await request(AddonPaths.toggle, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market", enabled: false }),
    })
    // capability caches invalidated → command list no longer offers the skill
    expect(await commandNames()).not.toContain("hello:greet")

    await request(AddonPaths.toggle, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@fixture-market", enabled: true }),
    })
    expect(await commandNames()).toContain("hello:greet")
  })

  test("toggle returns 400 for unknown addon", async () => {
    await using project = await tmpdir({ config: { formatter: false, lsp: false } })
    const response = await request(AddonPaths.toggle, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "missing@fixture-market", enabled: false }),
    })
    expect(response.status).toBe(400)
  })

  test("get returns 404 for unknown addon", async () => {
    await using project = await tmpdir()
    const response = await request(`/addon/${encodeURIComponent("ghost@nowhere")}`, project.path)
    expect(response.status).toBe(404)
  })

  test("install returns 400 when marketplace is not configured", async () => {
    await using project = await tmpdir()
    const response = await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@missing" }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("missing")
  })

  test("install returns 400 when addon is not in the marketplace", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

    await writeGlobalConfig({
      $schema: "https://opencode.ai/config.json",
      marketplaces: {
        "fixture-market": { source_type: "local", source: source.path },
      },
    })

    const response = await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "absent-addon@fixture-market" }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain("absent-addon")
  })

  test("install returns 400 when policy disallows installation", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir({
      init: (dir) =>
        writeMarketplace(dir, {
          marketplaceName: "policy-market",
          installation: "NOT_AVAILABLE",
        }),
    })

    await writeGlobalConfig({
      $schema: "https://opencode.ai/config.json",
      marketplaces: {
        "policy-market": { source_type: "local", source: source.path },
      },
    })

    const response = await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "hello@policy-market" }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error.toLowerCase()).toContain("not available")
  })

  test("uninstall is a noop when the addon is not installed", async () => {
    await using project = await tmpdir()
    const response = await request(AddonPaths.uninstall, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "ghost@market" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ key: "ghost@market" })
  })

  test("install returns 400 for invalid addon key", async () => {
    await using project = await tmpdir()
    const response = await request(AddonPaths.install, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addon_key: "not-a-valid-key" }),
    })
    expect(response.status).toBe(400)
  })
})
