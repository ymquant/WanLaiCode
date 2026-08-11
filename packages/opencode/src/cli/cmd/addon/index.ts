import * as AddonLoader from "@opencode-ai/addon"
import type { AddonId, CodexSkill } from "@opencode-ai/addon"
import * as prompts from "@clack/prompts"
import { Effect } from "effect"
import { Addon } from "@/addon"
import { Config } from "@/config/config"
import { cmd, type WithDoubleDash } from "../cmd"
import { CliError, effectCmd } from "../../effect-cmd"
import { AddonMarketplaceCommand } from "./marketplace"

function toCliError(error: unknown): CliError {
  return new CliError({ message: error instanceof Error ? error.message : String(error) })
}

const ADDON_INSTALL_KEY_DESCRIBE = "addon key in the form <addon-name>@<marketplace-name>"
const ADDON_LOOKUP_KEY_DESCRIBE =
  "addon key in the form <addon-name>@<marketplace-name> or <addon-name>@<marketplace-name>/<namespace>"

type AddonSummary = Pick<AddonLoader.LoadedAddon, "manifest" | "addonId"> &
  Partial<Pick<AddonLoader.LoadedAddon, "disabled" | "error" | "skills" | "mcpServers" | "hooks" | "unsupportedHookEvents">>

export function renderAddonSummary(addon: AddonSummary) {
  const features = [
    addon.mcpServers && Object.keys(addon.mcpServers).length > 0 ? `${Object.keys(addon.mcpServers).length} MCP servers` : undefined,
    addon.skills && addon.skills.length > 0 ? `${addon.skills.length} skills` : undefined,
    addon.hooks && Object.keys(addon.hooks).length > 0 ? `${Object.keys(addon.hooks).length} hooks` : undefined,
  ].filter((feature): feature is string => Boolean(feature))

  return [
    AddonLoader.addonKey(addon.addonId),
    addon.manifest.version ? `  Version: ${addon.manifest.version}` : undefined,
    addon.manifest.description ? `  Description: ${addon.manifest.description}` : undefined,
    addon.manifest.interfaceInfo?.displayName ? `  Display Name: ${addon.manifest.interfaceInfo.displayName}` : undefined,
    addon.disabled ? "  Status: disabled" : undefined,
    features.length > 0 ? `  Features: ${features.join(", ")}` : undefined,
    addon.error ? `  Error: ${addon.error}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

export function renderAddonList(addons: AddonSummary[]) {
  return addons.map(renderAddonSummary)
}

export function renderAddonSkillLine(addonId: AddonId, skill: CodexSkill) {
  return `${AddonLoader.addonSkillName(addonId, skill.name)} — ${skill.description}`
}

export const AddonCommand = cmd({
  command: "addon",
  describe: "manage addons",
  builder: (yargs) =>
    yargs
      .command(AddonListCommand)
      .command(AddonInfoCommand)
      .command(AddonPathsCommand)
      .command(AddonInstallCommand)
      .command(AddonUninstallCommand)
      .command(AddonMarketplaceCommand)
      .demandCommand(),
  async handler() {},
})

export const AddonListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list installed addons",
  builder: (yargs) =>
    yargs.option("addon-path", {
      type: "array",
      string: true,
      describe: "additional addon search path",
    }),
  handler: Effect.fn("Cli.addon.list")(function* (args: WithDoubleDash<{ addonPath?: string[] }>) {
    const addonSvc = yield* Addon.Service
    const cfgSvc = yield* Config.Service
    const cfg = yield* cfgSvc.get()
    const addonPaths = args.addonPath ?? []
    const paths = addonPaths.length ? [...(yield* addonSvc.getPaths()), ...addonPaths] : []
    const addons = addonPaths.length
      ? (yield* Effect.promise(() => AddonLoader.loadAddonsFromPaths(paths, { config: cfg }))).addons
      : yield* addonSvc.getAddons()

    prompts.intro("Addons")
    if (addons.length === 0) {
      prompts.log.warn("No addons installed")
      prompts.outro("Done")
      return
    }

    for (const addon of renderAddonList(addons)) {
      prompts.log.info(addon)
    }
    prompts.outro(`${addons.length} addon(s)`)
  }),
})

export const AddonInfoCommand = effectCmd({
  command: "info <name>",
  describe: "show addon manifest details",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "addon name or <plugin>@<market>",
    }),
  handler: Effect.fn("Cli.addon.info")(function* (args: WithDoubleDash<{ name?: string }>) {
    const name = args.name ?? ""
    const addonSvc = yield* Addon.Service
    const addons = yield* addonSvc.getAddons()
    const addon = addons.find((item) => {
      const id = AddonLoader.addonKey(item.addonId)
      return item.addonId.addonName === name || id === name
    })

    if (!addon) {
      prompts.log.error(`Addon "${name}" not found`)
      return
    }

    prompts.intro(`Addon: ${AddonLoader.addonKey(addon.addonId)}`)
    prompts.log.info(renderAddonSummary(addon))
    if (addon.mcpServers && Object.keys(addon.mcpServers).length > 0) {
      prompts.log.info("MCP Servers:")
      for (const [serverName, server] of Object.entries(addon.mcpServers)) {
        prompts.log.info(`  ${serverName}: ${server.type}`)
      }
    }
    if (addon.skills && addon.skills.length > 0) {
      prompts.log.info("Skills:")
      for (const skill of addon.skills) {
        prompts.log.info(`  ${renderAddonSkillLine(addon.addonId, skill)}`)
      }
    }
    if (addon.hooks && Object.keys(addon.hooks).length > 0) {
      prompts.log.info("Hooks:")
      for (const event of Object.keys(addon.hooks)) {
        prompts.log.info(`  ${event}`)
      }
    }
    if (addon.unsupportedHookEvents && addon.unsupportedHookEvents.length > 0) {
      prompts.log.warn("Unsupported hook events (skipped):")
      for (const event of addon.unsupportedHookEvents) {
        prompts.log.warn(`  ${event}`)
      }
    }
    prompts.outro("")
  }),
})

export const AddonPathsCommand = effectCmd({
  command: "paths",
  describe: "show addon search paths",
  handler: Effect.fn("Cli.addon.paths")(function* () {
    const addonSvc = yield* Addon.Service
    const paths = yield* addonSvc.getPaths()

    prompts.intro("Addon search paths")
    for (const item of paths) {
      prompts.log.info(item)
    }
    prompts.outro("")
  }),
})

export const AddonInstallCommand = effectCmd({
  command: "install <key>",
  describe: "install an addon from a configured marketplace",
  builder: (yargs) =>
    yargs.positional("key", {
      type: "string",
      describe: ADDON_INSTALL_KEY_DESCRIBE,
    }),
  handler: Effect.fn("Cli.addon.install")(function* (args: WithDoubleDash<{ key?: string }>) {
    const addonSvc = yield* Addon.Service
    const addonId = yield* Effect.try({
      try: () => AddonLoader.parseAddonKey(args.key ?? ""),
      catch: toCliError,
    })
    const outcome = yield* addonSvc
      .installAddon({
        addonName: addonId.addonName,
        marketplaceName: addonId.marketplaceName,
        registryNamespace: addonId.registryNamespace,
      })
      .pipe(Effect.mapError(toCliError))

    prompts.intro("Addon installed")
    prompts.log.success(`${outcome.key} @ ${outcome.version} -> ${outcome.installedPath}`)
    if (outcome.authPolicy === "ON_INSTALL") {
      prompts.log.warn("authentication policy: ON_INSTALL (not yet enforced)")
    }
    prompts.outro("Done")
  }),
})

export const AddonUninstallCommand = effectCmd({
  command: "uninstall <key>",
  aliases: ["remove", "rm"],
  describe: "uninstall an addon",
  builder: (yargs) =>
    yargs.positional("key", {
      type: "string",
      describe: ADDON_LOOKUP_KEY_DESCRIBE,
    }),
  handler: Effect.fn("Cli.addon.uninstall")(function* (args: WithDoubleDash<{ key?: string }>) {
    const addonSvc = yield* Addon.Service
    const outcome = yield* addonSvc.uninstallAddon(args.key ?? "").pipe(Effect.mapError(toCliError))

    prompts.intro("Addon uninstalled")
    prompts.log.success(outcome.key)
    prompts.outro("Done")
  }),
})
