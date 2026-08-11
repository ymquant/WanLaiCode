import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import * as Log from "@opencode-ai/core/util/log"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>
const secret = "mcp-management-real-secret"
const originalSecret = process.env.MCP_API_TEST_TOKEN
const originalAddonToken = process.env.MCP_ADDON_API_TOKEN
const originalAddonHeader = process.env.MCP_ADDON_API_HEADER

function globalConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME!, "wanlaicode")
}

async function clearGlobalConfig() {
  await rm(globalConfigDir(), { recursive: true, force: true })
  await mkdir(globalConfigDir(), { recursive: true })
}

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

beforeEach(async () => {
  await clearGlobalConfig()
  process.env.MCP_API_TEST_TOKEN = secret
  handler = ExperimentalHttpApiServer.webHandler({ cors: ["http://localhost"] }).handler
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  await clearGlobalConfig()
  if (originalSecret === undefined) delete process.env.MCP_API_TEST_TOKEN
  else process.env.MCP_API_TEST_TOKEN = originalSecret
  if (originalAddonToken === undefined) delete process.env.MCP_ADDON_API_TOKEN
  else process.env.MCP_ADDON_API_TOKEN = originalAddonToken
  if (originalAddonHeader === undefined) delete process.env.MCP_ADDON_API_HEADER
  else process.env.MCP_ADDON_API_HEADER = originalAddonHeader
})

describe("mcp management HttpApi", () => {
  for (const filename of ["wanlaicode.json", "wanlaicode.jsonc"]) {
    test(`manages a local server and preserves unrelated fields in ${filename}`, async () => {
      await using project = await tmpdir()
      const comment = filename.endsWith(".jsonc") ? "// keep this comment\n" : ""
      await writeFile(
        path.join(globalConfigDir(), filename),
        `${comment}${JSON.stringify(
          {
            model: "openai/gpt-4o",
            mcp: {
              demo: {
                type: "local",
                command: ["echo", "demo"],
                enabled: false,
              },
            },
          },
          null,
          2,
        )}\n`,
      )

      const listed = await request(McpPaths.manage, project.path)
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual([
        expect.objectContaining({
          name: "demo",
          source: "custom",
          editable: true,
          type: "local",
          enabled: false,
        }),
      ])

      const detail = await request(McpPaths.manageGet.replace(":name", "demo"), project.path)
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        name: "demo",
        config: {
          type: "local",
          command: "echo",
          args: ["demo"],
        },
      })

      const saved = await request(McpPaths.manageSave, project.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          original_name: "demo",
          name: "renamed",
          config: {
            type: "local",
            command: "echo",
            args: ["renamed"],
            environment: [],
            inherited_environment: [],
          },
        }),
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({ name: "renamed", enabled: false })

      const toggled = await request(McpPaths.manageToggle.replace(":name", "renamed"), project.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed", enabled: false }),
      })
      expect(toggled.status).toBe(200)
      expect(await toggled.json()).toEqual({ success: true })

      const removed = await request(McpPaths.manageGet.replace(":name", "renamed"), project.path, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ success: true })

      const source = await readFile(path.join(globalConfigDir(), filename), "utf8")
      expect(source).toContain('"model": "openai/gpt-4o"')
      expect(source).not.toContain('"demo"')
      expect(source).not.toContain('"renamed"')
      if (filename.endsWith(".jsonc")) expect(source.startsWith(comment)).toBe(true)
    })
  }

  test("returns environment references without leaking resolved secrets", async () => {
    await using project = await tmpdir()
    await writeFile(
      path.join(globalConfigDir(), "wanlaicode.jsonc"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer {env:MCP_API_TEST_TOKEN}" },
          },
        },
      }),
    )

    const response = await request(McpPaths.manageGet.replace(":name", "remote"), project.path)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("MCP_API_TEST_TOKEN")
    expect(body).not.toContain(secret)
  })

  test("returns addon environment header names from declarations without leaking resolved values", async () => {
    await using project = await tmpdir()
    const addonRoot = path.join(project.path, "addons", "secure", "local")
    await mkdir(path.join(addonRoot, ".codex-plugin"), { recursive: true })
    await writeFile(
      path.join(addonRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "secure", version: "0.1.0" }),
    )
    await writeFile(
      path.join(addonRoot, ".mcp.json"),
      JSON.stringify({
        protected: {
          url: "https://plugin.example.com/mcp",
          bearer_token_env_var: "MCP_ADDON_API_TOKEN",
          env_http_headers: { "X-Account": "MCP_ADDON_API_HEADER" },
        },
      }),
    )
    await writeFile(path.join(project.path, "wanlaicode.json"), JSON.stringify({ addon: { paths: [addonRoot] } }))
    process.env.MCP_ADDON_API_TOKEN = "resolved-addon-token-canary"
    process.env.MCP_ADDON_API_HEADER = "resolved-addon-header-canary"

    const response = await request(McpPaths.manageGet.replace(":name", "protected"), project.path)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("MCP_ADDON_API_TOKEN")
    expect(body).toContain("MCP_ADDON_API_HEADER")
    expect(body).not.toContain("resolved-addon-token-canary")
    expect(body).not.toContain("resolved-addon-header-canary")
  })

  test("renames and removes MCP definitions across all global JSON config sources", async () => {
    await using project = await tmpdir()
    const files = [
      ["config.json", { username: "low-source" }],
      ["wanlaicode.json", { shell: "middle-source" }],
      ["wanlaicode.jsonc", { model: "high/source" }],
    ] as const
    for (const [name, marker] of files) {
      await writeFile(
        path.join(globalConfigDir(), name),
        `${name.endsWith(".jsonc") ? "// keep multi-source comment\n" : ""}${JSON.stringify({
          ...marker,
          mcp: {
            shared: {
              type: "local",
              command: ["echo", name],
              enabled: false,
            },
          },
        })}`,
      )
    }

    const saved = await request(McpPaths.manageSave, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        original_name: "shared",
        name: "renamed",
        config: {
          type: "local",
          command: "echo",
          args: ["renamed"],
          environment: [],
          inherited_environment: [],
        },
      }),
    })
    expect(saved.status).toBe(200)
    expect((await request(McpPaths.manageGet.replace(":name", "shared"), project.path)).status).toBe(404)

    const removed = await request(McpPaths.manageGet.replace(":name", "renamed"), project.path, {
      method: "DELETE",
    })
    expect(removed.status).toBe(200)
    expect(await (await request(McpPaths.manage, project.path)).json()).toEqual([])

    for (const [name, marker] of files) {
      const source = await readFile(path.join(globalConfigDir(), name), "utf8")
      expect(source).not.toContain('"shared"')
      expect(source).not.toContain('"renamed"')
      expect(source).toContain(`"${Object.keys(marker)[0]}"`)
      if (name.endsWith(".jsonc")) expect(source.startsWith("// keep multi-source comment\n")).toBe(true)
    }
  })

  test("persists OAuth default, explicit false, and configured references without empty objects", async () => {
    await using project = await tmpdir()
    const file = path.join(globalConfigDir(), "wanlaicode.jsonc")
    await writeFile(file, "{}")
    const save = (name: string, oauth?: false | Record<string, unknown>) =>
      request(McpPaths.manageSave, project.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          config: {
            type: "remote",
            url: `https://mcp.example.com/${name}`,
            headers: [],
            environment_headers: [],
            ...(oauth === undefined ? {} : { oauth }),
          },
        }),
      })

    expect((await save("automatic")).status).toBe(200)
    expect((await save("enabled-empty", { enabled: true })).status).toBe(200)
    expect((await save("disabled", false)).status).toBe(200)
    expect(
      (
        await save("configured", {
          enabled: true,
          client_id: "desktop",
          client_secret_env: "MCP_API_TEST_TOKEN",
        })
      ).status,
    ).toBe(200)

    const config = parseJsonc(await readFile(file, "utf8"))
    expect(config.mcp.automatic).not.toHaveProperty("oauth")
    expect(config.mcp["enabled-empty"]).not.toHaveProperty("oauth")
    expect(config.mcp.disabled.oauth).toBe(false)
    expect(config.mcp.configured.oauth).toEqual({
      clientId: "desktop",
      clientSecret: "{env:MCP_API_TEST_TOKEN}",
    })
  })

  test("maps management validation and lookup failures to stable responses", async () => {
    await using project = await tmpdir()
    await writeFile(path.join(globalConfigDir(), "wanlaicode.jsonc"), "{}")

    const missing = await request(McpPaths.manageGet.replace(":name", "missing"), project.path)
    expect(missing.status).toBe(404)

    const invalid = await request(McpPaths.manageSave, project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad name",
        config: {
          type: "local",
          command: "echo",
          args: [],
          environment: [],
          inherited_environment: [],
        },
      }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ code: "name_invalid", error: "MCP server name is invalid" })
  })

  test("rejects a toggle whose body name does not match the request path", async () => {
    await using project = await tmpdir()
    const file = path.join(globalConfigDir(), "wanlaicode.jsonc")
    await writeFile(
      file,
      JSON.stringify({
        mcp: {
          first: {
            type: "local",
            command: ["echo", "first"],
            enabled: false,
          },
          second: {
            type: "local",
            command: ["echo", "second"],
            enabled: false,
          },
        },
      }),
    )

    const response = await request(McpPaths.manageToggle.replace(":name", "first"), project.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "second", enabled: true }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: "name_mismatch",
      error: "MCP server name does not match request path",
    })

    const config = parseJsonc(await readFile(file, "utf8"))
    expect(config.mcp.first.enabled).toBe(false)
    expect(config.mcp.second.enabled).toBe(false)
  })

  test("serializes concurrent create and rename conflicts under the config lock", async () => {
    await using project = await tmpdir()
    const file = path.join(globalConfigDir(), "wanlaicode.jsonc")
    await writeFile(file, "{}")
    const save = (name: string, command: string, original_name?: string) =>
      request(McpPaths.manageSave, project.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          original_name,
          config: {
            type: "local",
            command,
            args: [],
            environment: [],
            inherited_environment: [],
          },
        }),
      })

    const creates = await Promise.all([save("shared", "echo-one"), save("shared", "echo-two")])
    expect(creates.map((response) => response.status).sort()).toEqual([200, 400])

    expect((await save("source-a", "echo-a")).status).toBe(200)
    expect((await save("source-b", "echo-b")).status).toBe(200)
    const renames = await Promise.all([
      save("rename-target", "echo-a", "source-a"),
      save("rename-target", "echo-b", "source-b"),
    ])
    expect(renames.map((response) => response.status).sort()).toEqual([200, 400])

    const config = parseJsonc(await readFile(file, "utf8"))
    expect(config.mcp).toHaveProperty("shared")
    expect(config.mcp).toHaveProperty("rename-target")
    expect([config.mcp["source-a"], config.mcp["source-b"]].filter(Boolean)).toHaveLength(1)
  })

  test("keeps all five management routes and error semantics on the legacy Hono backend", async () => {
    await using project = await tmpdir()
    await writeFile(
      path.join(globalConfigDir(), "wanlaicode.jsonc"),
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer {env:MCP_API_TEST_TOKEN}" },
            enabled: false,
          },
        },
      }),
    )
    const app = Server.Legacy().app
    const legacyRequest = (route: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("x-opencode-directory", project.path)
      return app.request(route, { ...init, headers })
    }

    expect((await legacyRequest(McpPaths.manage)).status).toBe(200)
    const detail = await legacyRequest(McpPaths.manageGet.replace(":name", "remote"))
    expect(detail.status).toBe(200)
    const detailBody = await detail.text()
    expect(detailBody).toContain("MCP_API_TEST_TOKEN")
    expect(detailBody).not.toContain(secret)
    expect((await legacyRequest(McpPaths.manageGet.replace(":name", "missing"))).status).toBe(404)

    const invalid = await legacyRequest(McpPaths.manageSave, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad name",
        config: {
          type: "local",
          command: "echo",
          args: [],
          environment: [],
          inherited_environment: [],
        },
      }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ code: "name_invalid", error: "MCP server name is invalid" })

    const saved = await legacyRequest(McpPaths.manageSave, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "created",
        config: {
          type: "local",
          command: "echo",
          args: ["created"],
          environment: [],
          inherited_environment: [],
        },
      }),
    })
    expect(saved.status).toBe(200)
    const mismatchedToggle = await legacyRequest(McpPaths.manageToggle.replace(":name", "created"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "different", enabled: false }),
    })
    expect(mismatchedToggle.status).toBe(400)
    expect(await mismatchedToggle.json()).toEqual({
      code: "name_mismatch",
      error: "MCP server name does not match request path",
    })
    const toggled = await legacyRequest(McpPaths.manageToggle.replace(":name", "created"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "created", enabled: false }),
    })
    expect(toggled.status).toBe(200)
    const removed = await legacyRequest(McpPaths.manageGet.replace(":name", "created"), { method: "DELETE" })
    expect(removed.status).toBe(200)
  })
})
