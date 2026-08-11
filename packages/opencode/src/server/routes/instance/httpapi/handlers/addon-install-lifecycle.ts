import { addonKey, type LoadedAddon } from "@opencode-ai/addon"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"

const log = Log.create({ service: "addon.install.lifecycle" })

type VoidEffect = Effect.Effect<void>

export interface AddonInstallLifecycleServices {
  addon: {
    invalidate: () => VoidEffect
    getAddons: () => Effect.Effect<LoadedAddon[]>
  }
  skill: {
    invalidate: () => VoidEffect
  }
  command: {
    invalidate: () => VoidEffect
  }
  plugin: {
    invalidate: () => VoidEffect
  }
  mcp: {
    reconcile: () => VoidEffect
    hasStoredTokens: (name: string) => Effect.Effect<boolean>
    removeAuth: (name: string) => VoidEffect
    authenticate: (name: string) => Effect.Effect<unknown>
  }
  bus: {
    publishAddonChanged: () => VoidEffect
  }
}

export function refreshAddonCapabilities(services: AddonInstallLifecycleServices) {
  return Effect.gen(function* () {
    yield* services.addon.invalidate()
    yield* services.skill.invalidate()
    yield* services.command.invalidate()
    yield* services.plugin.invalidate()
    yield* services.mcp.reconcile()
    yield* services.bus.publishAddonChanged()
  })
}

export function autoAuthRemoteMcpServers(services: AddonInstallLifecycleServices, installedAddonKey: string) {
  return Effect.gen(function* () {
    const addons = yield* services.addon.getAddons().pipe(Effect.orElseSucceed(() => []))
    const installed = addons.find((addon) => addonKey(addon.addonId) === installedAddonKey)
    if (!installed?.mcpServers) return
    yield* Effect.forEach(
      Object.entries(installed.mcpServers),
      ([name, server]) =>
        Effect.gen(function* () {
          if (server.type !== "remote" || server.enabled === false) return
          const stored = yield* services.mcp.hasStoredTokens(name).pipe(Effect.orElseSucceed(() => false))
          if (stored) return
          yield* services.mcp.authenticate(name)
          yield* Effect.sync(() => log.info("auto-auth after install completed", { mcpName: name }))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("auto-auth after install failed", { mcpName: name, cause: String(cause) })),
          ),
        ),
      { concurrency: "unbounded" },
    )
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => log.warn("auto-auth scan failed", { cause: String(cause) }))))
}

export function uninstallAddonWithMcpAuthCleanup<A, E, R>(
  services: AddonInstallLifecycleServices,
  installedAddonKey: string,
  uninstall: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const addons = yield* services.addon.getAddons()
    const mcpNames = [
      ...new Set(
        addons
          .filter((addon) => addonKey(addon.addonId) === installedAddonKey)
          .flatMap((addon) =>
            Object.entries(addon.mcpServers ?? {})
              .filter(([, server]) => server.type === "remote")
              .map(([name]) => name),
          ),
      ),
    ]
    const outcome = yield* uninstall
    yield* Effect.forEach(mcpNames, (name) => services.mcp.removeAuth(name))
    return outcome
  })
}
