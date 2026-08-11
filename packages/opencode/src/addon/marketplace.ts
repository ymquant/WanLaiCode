import * as AddonLoader from "@opencode-ai/addon"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { Context, Effect, Layer, Option } from "effect"
import { cp, mkdir, rename, rm } from "fs/promises"
import path from "path"
import { Addon } from "."
import { invalidateAddonCapabilities } from "./capability-invalidation"
import { marketplaceInstallRoot } from "./paths"

export interface AddOptions {
  ref?: string
  sparsePaths?: string[]
}

export interface AddResult {
  name: string
  root: string
}

export interface UpgradeResult {
  name: string
  changed: boolean
  revision?: string
}

export interface Interface {
  readonly add: (source: string, options?: AddOptions) => Effect.Effect<AddResult, never, Config.Service | Addon.Service>
  readonly upgrade: (name?: string) => Effect.Effect<UpgradeResult[], never, Config.Service | Addon.Service>
  readonly remove: (name: string) => Effect.Effect<void, never, Config.Service | Addon.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AddonMarketplace") {}

function stagingRoot() {
  return path.join(Global.Path.data, "marketplaces", ".staging")
}

async function freshStagingDir() {
  const dir = path.join(stagingRoot(), crypto.randomUUID())
  await mkdir(dir, { recursive: true })
  return dir
}

async function readMarketplaceName(root: string) {
  const manifestPath = AddonLoader.findMarketplaceManifestPath(root)
  if (!manifestPath) throw new AddonLoader.MarketplaceAddError("marketplace manifest not found after install")
  return (await AddonLoader.loadMarketplace(manifestPath)).name
}

interface MarketplaceDeps {
  rename?: typeof rename
  updateGlobal?: (patch: Config.Info) => Promise<void>
}

async function replaceDirectory(input: {
  source: string
  destination: string
  rename: typeof rename
  afterReplace: () => Promise<void>
}) {
  const backup = `${input.destination}.backup-${crypto.randomUUID()}`
  let backedUp = false
  await mkdir(path.dirname(input.destination), { recursive: true })
  await input.rename(input.destination, backup)
    .then(() => {
      backedUp = true
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
  })
  try {
    await input.rename(input.source, input.destination)
    await input.afterReplace()
    if (backedUp) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(input.destination, { recursive: true, force: true }).catch(() => undefined)
    if (backedUp) await input.rename(backup, input.destination).catch(() => undefined)
    throw error
  }
}

async function removeDirectoryAfter(input: { destination: string; rename: typeof rename; afterRemove: () => Promise<void> }) {
  const backup = `${input.destination}.removed-${crypto.randomUUID()}`
  let backedUp = false
  await input.rename(input.destination, backup)
    .then(() => {
      backedUp = true
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  try {
    await input.afterRemove()
    if (backedUp) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (backedUp) await input.rename(backup, input.destination).catch(() => undefined)
    throw error
  }
}

function marketplacePatch(
  name: string,
  cfg: AddonLoader.ParsedMarketplaceSource,
  root: string,
  options: AddOptions | undefined,
  revision: string | undefined,
) {
  if (cfg.type === "local") {
    return {
      marketplaces: {
        [name]: {
          source_type: "local" as const,
          source: root,
          last_updated: new Date().toISOString(),
        },
      },
    }
  }
  return {
    marketplaces: {
      [name]: {
        source_type: "git" as const,
        source: cfg.url,
        ref: options?.ref ?? cfg.ref,
        sparse_paths: options?.sparsePaths?.length ? options.sparsePaths : undefined,
        last_revision: revision,
        last_updated: new Date().toISOString(),
      },
    },
  }
}

export function layerWithDeps(deps: MarketplaceDeps = {}) {
  const renameFile = deps.rename ?? rename
  return Layer.effect(
    Service,
    Effect.sync(() => {
      const invalidate = Effect.fn("AddonMarketplace.invalidate")(function* () {
        const config = yield* Config.Service
        yield* config.invalidate()
        if (Option.isSome(yield* Effect.serviceOption(Addon.Service))) yield* invalidateAddonCapabilities()
      })

      const add = Effect.fn("AddonMarketplace.add")(function* (source: string, options: AddOptions = {}) {
        const config = yield* Config.Service
        const updateGlobal = deps.updateGlobal ?? ((patch: Config.Info) =>
          Effect.runPromise(config.updateGlobal(patch)).then(() => {}))
        return yield* Effect.promise(() =>
          Flock.withLock("marketplace-install", async () => {
            const parsed = AddonLoader.parseMarketplaceSource(source, {
              ref: options.ref,
              cwd: process.cwd(),
              homeDir: Global.Path.home,
            })
            const staging = await freshStagingDir()
            try {
              if (parsed.type === "local") {
                await AddonLoader.ensureLocalSourceIsDirectory(parsed.path)
                await cp(parsed.path, staging, { recursive: true })
              } else {
                await AddonLoader.cloneGitSource({
                  url: parsed.url,
                  ref: parsed.ref,
                  sparsePaths: options.sparsePaths,
                  destination: staging,
                })
              }
              const name = await readMarketplaceName(staging)
              const root = marketplaceInstallRoot(name)
              const revision = parsed.type === "git" ? await AddonLoader.gitRevParseHead(staging) : undefined
              await replaceDirectory({
                source: staging,
                destination: root,
                rename: renameFile,
                afterReplace: () => updateGlobal(marketplacePatch(name, parsed, root, options, revision)),
              })
              return { name, root }
            } finally {
              await rm(staging, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        ).pipe(Effect.tap(() => invalidate()))
      })

      const upgradeOne = Effect.fn("AddonMarketplace.upgradeOne")(function* (
        name: string,
        mp: NonNullable<Config.Info["marketplaces"]>[string],
      ) {
        const config = yield* Config.Service
        if (mp.source_type !== "git" || !mp.source) return { name, changed: false }
        const root = marketplaceInstallRoot(name)
        yield* Effect.promise(() =>
          Flock.withLock("marketplace-install", async () => {
            await AddonLoader.fetchAndCheckout({
              cwd: root,
              url: mp.source!,
              ref: mp.ref,
              sparsePaths: mp.sparse_paths,
            })
          }),
        )
        const revision = yield* Effect.promise(() => AddonLoader.gitRevParseHead(root))
        if (revision === mp.last_revision) return { name, changed: false, revision }
        yield* config.updateGlobal({
          marketplaces: {
            [name]: {
              ...mp,
              last_revision: revision,
              last_updated: new Date().toISOString(),
            },
          },
        })
        yield* invalidate()
        return { name, changed: true, revision }
      })

      const upgrade = Effect.fn("AddonMarketplace.upgrade")(function* (name?: string) {
        const config = yield* Config.Service
        const cfg = yield* config.getGlobal()
        const entries = Object.entries(cfg.marketplaces ?? {}).filter(
          ([key, mp]) => (!name || key === name) && mp.source_type === "git",
        )
        return yield* Effect.forEach(entries, ([key, mp]) => upgradeOne(key, mp), { concurrency: 1 })
      })

      const removeMarketplace = Effect.fn("AddonMarketplace.remove")(function* (name: string) {
        const config = yield* Config.Service
        const updateGlobal = deps.updateGlobal ?? ((patch: Config.Info) =>
          Effect.runPromise(config.updateGlobal(patch)).then(() => {}))
        yield* Effect.promise(() =>
          Flock.withLock("marketplace-install", async () => {
            await removeDirectoryAfter({
              destination: marketplaceInstallRoot(name),
              rename: renameFile,
              afterRemove: () =>
                updateGlobal({
                  marketplaces: {
                    [name]: undefined,
                  },
                } as unknown as Config.Info),
            })
          }),
        )
        yield* invalidate()
      })

      return Service.of({ add, upgrade, remove: removeMarketplace })
    }),
  )
}

export const layer = layerWithDeps()

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Addon.defaultLayer))

export * as AddonMarketplace from "./marketplace"
