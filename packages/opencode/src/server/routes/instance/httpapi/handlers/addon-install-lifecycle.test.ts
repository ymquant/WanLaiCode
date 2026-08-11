import { describe, expect, test } from "bun:test"
import type { LoadedAddon } from "@opencode-ai/addon"
import { Effect } from "effect"
import {
  autoAuthRemoteMcpServers,
  refreshAddonCapabilities,
  type AddonInstallLifecycleServices,
  uninstallAddonWithMcpAuthCleanup,
} from "./addon-install-lifecycle"

function services(input?: { addons?: LoadedAddon[]; storedTokens?: string[]; authenticationFailures?: string[] }) {
  const events: string[] = []
  const storedTokens = new Set(input?.storedTokens)
  const authenticationFailures = new Set(input?.authenticationFailures)
  const result: AddonInstallLifecycleServices = {
    addon: {
      invalidate: () => Effect.sync(() => events.push("addon.invalidate")),
      getAddons: () => Effect.succeed(input?.addons ?? []),
    },
    skill: {
      invalidate: () => Effect.sync(() => events.push("skill.invalidate")),
    },
    command: {
      invalidate: () => Effect.sync(() => events.push("command.invalidate")),
    },
    plugin: {
      invalidate: () => Effect.sync(() => events.push("plugin.invalidate")),
    },
    mcp: {
      reconcile: () => Effect.sync(() => events.push("mcp.reconcile")),
      hasStoredTokens: (name) => Effect.succeed(storedTokens.has(name)),
      removeAuth: (name) => Effect.sync(() => events.push(`mcp.removeAuth:${name}`)),
      authenticate: (name) => {
        events.push(`mcp.authenticate:${name}`)
        if (authenticationFailures.has(name)) return Effect.die(new Error(`${name} failed`))
        return Effect.succeed({ status: "connected" as const })
      },
    },
    bus: {
      publishAddonChanged: () => Effect.sync(() => events.push("bus.addon.changed")),
    },
  }
  return { events, services: result }
}

function installedAddon() {
  return {
    addonId: {
      addonName: "cloudflare",
      marketplaceName: "wanlaicode",
      registryNamespace: "openai",
    },
    mcpServers: {
      "cloudflare-api": { type: "remote", url: "https://cloudflare.example/mcp" },
      authorized: { type: "remote", url: "https://authorized.example/mcp" },
      broken: { type: "remote", url: "https://broken.example/mcp" },
      disabled: { type: "remote", url: "https://disabled.example/mcp", enabled: false },
      local: { type: "local", command: ["node", "server.js"] },
    },
  } as unknown as LoadedAddon
}

describe("addon install lifecycle", () => {
  test("refreshes every live addon capability before publishing the change", async () => {
    const fixture = services()

    await Effect.runPromise(refreshAddonCapabilities(fixture.services))

    expect(fixture.events).toEqual([
      "addon.invalidate",
      "skill.invalidate",
      "command.invalidate",
      "plugin.invalidate",
      "mcp.reconcile",
      "bus.addon.changed",
    ])
  })

  test("authenticates only unapproved enabled remote MCP servers from the installed addon", async () => {
    const fixture = services({
      addons: [installedAddon()],
      storedTokens: ["authorized"],
      authenticationFailures: ["broken"],
    })

    await Effect.runPromise(autoAuthRemoteMcpServers(fixture.services, "cloudflare@wanlaicode/openai"))

    expect(fixture.events.filter((event) => event.startsWith("mcp.authenticate:")).sort()).toEqual([
      "mcp.authenticate:broken",
      "mcp.authenticate:cloudflare-api",
    ])
  })

  test("does not authenticate MCP servers belonging to another addon", async () => {
    const fixture = services({
      addons: [installedAddon()],
    })

    await Effect.runPromise(autoAuthRemoteMcpServers(fixture.services, "another@wanlaicode/openai"))

    expect(fixture.events).toEqual([])
  })

  test("removes every remote MCP authorization after the addon uninstalls", async () => {
    const fixture = services({
      addons: [installedAddon()],
    })

    const outcome = await Effect.runPromise(
      uninstallAddonWithMcpAuthCleanup(
        fixture.services,
        "cloudflare@wanlaicode/openai",
        Effect.sync(() => {
          fixture.events.push("addon.uninstall")
          return { key: "cloudflare@wanlaicode/openai" }
        }),
      ),
    )

    expect(outcome).toEqual({ key: "cloudflare@wanlaicode/openai" })
    expect(fixture.events).toEqual([
      "addon.uninstall",
      "mcp.removeAuth:cloudflare-api",
      "mcp.removeAuth:authorized",
      "mcp.removeAuth:broken",
      "mcp.removeAuth:disabled",
    ])
  })

  test("keeps MCP authorization when addon uninstall fails", async () => {
    const fixture = services({
      addons: [installedAddon()],
    })

    await expect(
      Effect.runPromise(
        uninstallAddonWithMcpAuthCleanup(
          fixture.services,
          "cloudflare@wanlaicode/openai",
          Effect.fail(new Error("uninstall failed")),
        ),
      ),
    ).rejects.toThrow("uninstall failed")

    expect(fixture.events).toEqual([])
  })
})
