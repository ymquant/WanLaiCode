import * as AddonLoader from "@opencode-ai/addon"
import * as prompts from "@clack/prompts"
import { Effect } from "effect"
import { Addon } from "@/addon"
import { AddonMarketplace } from "@/addon/marketplace"
import { cmd, type WithDoubleDash } from "../cmd"
import { effectCmd } from "../../effect-cmd"

export function renderMarketplaceSummary(marketplace: AddonLoader.Marketplace) {
  return [
    `${marketplace.name}`,
    marketplace.interface?.displayName ? `  Display Name: ${marketplace.interface.displayName}` : undefined,
    `  Manifest: ${marketplace.manifestPath}`,
    `  Plugins: ${marketplace.plugins.length}`,
    marketplace.unsupportedPlugins.length > 0
      ? `  Unsupported: ${marketplace.unsupportedPlugins.length}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
}

export function renderMarketplacePluginLine(plugin: AddonLoader.MarketplacePlugin) {
  const source = plugin.source
  if (source.type === "local") return `  ${plugin.name} — local: ${source.path}`
  if (source.type === "remote-tar") return `  ${plugin.name} — remote-tar: ${source.url}`
  const subdir = source.subdir ? ` (${source.subdir})` : ""
  const ref = source.ref ? ` @${source.ref}` : ""
  return `  ${plugin.name} — git: ${source.url}${subdir}${ref}`
}

export const AddonMarketplaceCommand = cmd({
  command: "marketplace",
  describe: "manage addon marketplaces",
  builder: (yargs) =>
    yargs
      .command(AddonMarketplaceListCommand)
      .command(AddonMarketplaceInfoCommand)
      .command(AddonMarketplaceAddCommand)
      .command(AddonMarketplaceUpgradeCommand)
      .command(AddonMarketplaceRemoveCommand)
      .demandCommand(),
  async handler() {},
})

export const AddonMarketplaceListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list configured addon marketplaces",
  handler: Effect.fn("Cli.addon.marketplace.list")(function* () {
    const addonSvc = yield* Addon.Service
    const marketplaces = yield* addonSvc.getMarketplaces()

    prompts.intro("Marketplaces")
    if (marketplaces.length === 0) {
      prompts.log.warn("No marketplaces configured")
      prompts.outro("Done")
      return
    }
    for (const marketplace of marketplaces) {
      prompts.log.info(renderMarketplaceSummary(marketplace))
    }
    prompts.outro(`${marketplaces.length} marketplace(s)`)
  }),
})

export const AddonMarketplaceInfoCommand = effectCmd({
  command: "info <name>",
  describe: "show plugins exposed by a marketplace",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "marketplace name",
    }),
  handler: Effect.fn("Cli.addon.marketplace.info")(function* (args: WithDoubleDash<{ name?: string }>) {
    const name = args.name ?? ""
    const addonSvc = yield* Addon.Service
    const marketplaces = yield* addonSvc.getMarketplaces()
    const marketplace = marketplaces.find((item) => item.name === name)

    if (!marketplace) {
      prompts.log.error(`Marketplace "${name}" not found`)
      return
    }

    prompts.intro(`Marketplace: ${marketplace.name}`)
    prompts.log.info(renderMarketplaceSummary(marketplace))

    if (marketplace.plugins.length > 0) {
      prompts.log.info("Plugins:")
      for (const plugin of marketplace.plugins) {
        prompts.log.info(renderMarketplacePluginLine(plugin))
      }
    }
    if (marketplace.unsupportedPlugins.length > 0) {
      prompts.log.warn("Unsupported plugin entries (skipped):")
      for (const entry of marketplace.unsupportedPlugins) {
        prompts.log.warn(`  ${entry.name ?? "<unnamed>"}: ${entry.reason}`)
      }
    }
    prompts.outro("")
  }),
})

export const AddonMarketplaceAddCommand = effectCmd({
  command: "add <source>",
  describe: "add an addon marketplace",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "marketplace source: owner/repo, git URL, file://, absolute path, or relative path",
      })
      .option("ref", {
        type: "string",
        describe: "git ref to checkout",
      })
      .option("sparse", {
        type: "string",
        array: true,
        describe: "sparse-checkout path; repeat for multiple paths",
      }),
  handler: Effect.fn("Cli.addon.marketplace.add")(function* (
    args: WithDoubleDash<{ source?: string; ref?: string; sparse?: string[] }>,
  ) {
    const source = args.source ?? ""
    const svc = yield* AddonMarketplace.Service
    const result = yield* svc.add(source, {
      ref: args.ref,
      sparsePaths: args.sparse,
    })

    prompts.intro("Marketplace added")
    prompts.log.success(`${result.name} -> ${result.root}`)
    prompts.outro("Done")
  }),
})

export const AddonMarketplaceUpgradeCommand = effectCmd({
  command: "upgrade [name]",
  describe: "upgrade addon marketplaces",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "marketplace name; omit to upgrade all git marketplaces",
    }),
  handler: Effect.fn("Cli.addon.marketplace.upgrade")(function* (args: WithDoubleDash<{ name?: string }>) {
    const svc = yield* AddonMarketplace.Service
    const results = yield* svc.upgrade(args.name)

    prompts.intro("Marketplace upgrade")
    if (results.length === 0) {
      prompts.log.warn(args.name ? `No git marketplace named "${args.name}"` : "No git marketplaces configured")
      prompts.outro("Done")
      return
    }
    for (const result of results) {
      prompts.log.info(
        result.changed
          ? `${result.name}: updated to ${result.revision ?? "<unknown>"}`
          : `${result.name}: already current`,
      )
    }
    prompts.outro(`${results.length} marketplace(s) checked`)
  }),
})

export const AddonMarketplaceRemoveCommand = effectCmd({
  command: "remove <name>",
  aliases: ["rm"],
  describe: "remove an addon marketplace",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "marketplace name",
    }),
  handler: Effect.fn("Cli.addon.marketplace.remove")(function* (args: WithDoubleDash<{ name?: string }>) {
    const name = args.name ?? ""
    const svc = yield* AddonMarketplace.Service
    yield* svc.remove(name)

    prompts.intro("Marketplace removed")
    prompts.log.success(name)
    prompts.outro("Done")
  }),
})
