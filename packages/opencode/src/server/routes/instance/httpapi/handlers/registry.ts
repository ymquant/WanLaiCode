import { Addon } from "@/addon"
import { Service as RegistryService } from "@/addon/registry"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Skill } from "@/skill"
import type { LoadedAddon, Marketplace } from "@opencode-ai/addon"
import { addonKey, parseAddonKey, RegistryError } from "@opencode-ai/addon"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { RegistryRequestError, RegistryUnauthorizedError } from "../groups/registry"
import {
  autoAuthRemoteMcpServers,
  refreshAddonCapabilities,
  type AddonInstallLifecycleServices,
} from "./addon-install-lifecycle"

const log = Log.create({ service: "registry.http" })

function mapErr<A>(eff: Effect.Effect<A, Error>): Effect.Effect<A, RegistryRequestError | RegistryUnauthorizedError> {
  return eff.pipe(
    Effect.catch((err: Error) => {
      if (err instanceof RegistryError && err.status === 401)
        return Effect.fail(new RegistryUnauthorizedError({ error: err.message }))
      if (err instanceof RegistryError) return Effect.fail(new RegistryRequestError({ error: err.message }))
      return Effect.die(err)
    }),
  )
}

export function resolvePublishPluginTarget(input: {
  addonKey: string
  addons: LoadedAddon[]
  marketplaces: Marketplace[]
}): { root: string; name: string; version?: string } | undefined {
  const addonId = (() => {
    try {
      return parseAddonKey(input.addonKey)
    } catch {
      return undefined
    }
  })()
  if (addonId) {
    const marketplacePlugin = input.marketplaces
      .find((marketplace) => marketplace.name === addonId.marketplaceName)
      ?.plugins.find((plugin) => plugin.name === addonId.addonName)
    if (marketplacePlugin?.source.type === "local")
      return {
        root: marketplacePlugin.source.path,
        name: addonId.addonName,
      }
  }

  const installed = input.addons.find((item) => addonKey(item.addonId) === input.addonKey)
  if (installed) {
    return {
      root: installed.root,
      name: installed.addonId.addonName,
      version: installed.version,
    }
  }

  if (!addonId) return undefined
  return undefined
}

export const registryHandlers = HttpApiBuilder.group(InstanceHttpApi, "registry", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* RegistryService
    const addonSvc = yield* Addon.Service
    const mcpSvc = yield* MCP.Service
    const skillSvc = yield* Skill.Service
    const commandSvc = yield* Command.Service
    const pluginSvc = yield* Plugin.Service
    const bus = yield* Bus.Service
    const lifecycleServices = {
      addon: addonSvc,
      skill: skillSvc,
      command: commandSvc,
      plugin: pluginSvc,
      mcp: mcpSvc,
      bus: {
        publishAddonChanged: () => bus.publish(Addon.Event.Changed, {}),
      },
    } satisfies AddonInstallLifecycleServices

    const listPlugins = Effect.fn("RegistryHttpApi.listPlugins")(function* (ctx: {
      query: { q?: string; page?: number; per_page?: number; sort?: string; locale?: string }
    }) {
      return yield* mapErr(svc.listPlugins(ctx.query))
    })

    const getPlugin = Effect.fn("RegistryHttpApi.getPlugin")(function* (ctx: {
      params: { namespace: string; slug: string }
      query: { locale?: string }
    }) {
      return yield* mapErr(svc.getPlugin(ctx.params.namespace, ctx.params.slug, ctx.query.locale))
    })

    const deletePlugin = Effect.fn("RegistryHttpApi.deletePlugin")(function* (ctx: {
      params: { namespace: string; slug: string }
    }) {
      yield* mapErr(svc.deletePlugin(ctx.params.namespace, ctx.params.slug))
      return { ok: true }
    })

    const install = Effect.fn("RegistryHttpApi.install")(function* (ctx: {
      payload: { namespace: string; slug: string; version?: string }
    }) {
      const out = yield* mapErr(svc.install(ctx.payload))
      yield* refreshAddonCapabilities(lifecycleServices)
      yield* autoAuthRemoteMcpServers(lifecycleServices, out.key).pipe(Effect.forkDetach)
      return { key: out.key, version: out.version, installed_path: out.installedPath }
    })

    const publish = Effect.fn("RegistryHttpApi.publish")(function* (ctx: { payload: { addon_key: string } }) {
      yield* Effect.sync(() => log.warn("plugin publish request received", { addonKey: ctx.payload.addon_key }))
      const addons = yield* addonSvc.getAddons()
      const marketplaces = yield* addonSvc.getMarketplaces()
      const target = resolvePublishPluginTarget({ addonKey: ctx.payload.addon_key, addons, marketplaces })
      if (!target) return yield* new RegistryRequestError({ error: `addon not found: "${ctx.payload.addon_key}"` })
      yield* Effect.sync(() =>
        log.warn("plugin publish target resolved", {
          addonKey: ctx.payload.addon_key,
          root: target.root,
          name: target.name,
          version: target.version,
        }),
      )
      yield* mapErr(
        svc.publishLocalPlugin({
          root: target.root,
          name: target.name,
          version: target.version,
        }),
      )
      return { ok: true }
    })

    const me = Effect.fn("RegistryHttpApi.me")(function* () {
      return yield* mapErr(svc.me())
    })

    const createNamespace = Effect.fn("RegistryHttpApi.createNamespace")(function* (ctx: { payload: { name: string } }) {
      return yield* mapErr(svc.createNamespace(ctx.payload.name))
    })

    const myPlugins = Effect.fn("RegistryHttpApi.myPlugins")(function* (ctx: { query: { locale?: string } }) {
      return yield* mapErr(svc.myPlugins(ctx.query.locale))
    })

    const listComments = Effect.fn("RegistryHttpApi.listComments")(function* (ctx: {
      params: { namespace: string; slug: string }
      query: { page?: number }
    }) {
      return yield* mapErr(svc.listComments(ctx.params.namespace, ctx.params.slug, ctx.query.page))
    })

    const postComment = Effect.fn("RegistryHttpApi.postComment")(function* (ctx: {
      params: { namespace: string; slug: string }
      payload: { content: string }
    }) {
      return yield* mapErr(svc.postComment(ctx.params.namespace, ctx.params.slug, ctx.payload.content))
    })

    const deleteComment = Effect.fn("RegistryHttpApi.deleteComment")(function* (ctx: {
      params: { namespace: string; slug: string; publicId: string }
    }) {
      yield* mapErr(svc.deleteComment(ctx.params.namespace, ctx.params.slug, ctx.params.publicId))
      return { ok: true }
    })

    const getMyRating = Effect.fn("RegistryHttpApi.getMyRating")(function* (ctx: {
      params: { namespace: string; slug: string }
    }) {
      return yield* mapErr(svc.getMyRating(ctx.params.namespace, ctx.params.slug))
    })

    const putRating = Effect.fn("RegistryHttpApi.putRating")(function* (ctx: {
      params: { namespace: string; slug: string }
      payload: { rating: number }
    }) {
      return yield* mapErr(svc.putRating(ctx.params.namespace, ctx.params.slug, ctx.payload.rating))
    })

    const deleteRating = Effect.fn("RegistryHttpApi.deleteRating")(function* (ctx: {
      params: { namespace: string; slug: string }
    }) {
      yield* mapErr(svc.deleteRating(ctx.params.namespace, ctx.params.slug))
      return { ok: true }
    })

    const deleteVersion = Effect.fn("RegistryHttpApi.deleteVersion")(function* (ctx: {
      params: { namespace: string; slug: string; version: string }
    }) {
      yield* mapErr(svc.deleteVersion(ctx.params.namespace, ctx.params.slug, ctx.params.version))
      return { ok: true }
    })

    return handlers
      .handle("listPlugins", listPlugins)
      .handle("getPlugin", getPlugin)
      .handle("deletePlugin", deletePlugin)
      .handle("install", install)
      .handle("publish", publish)
      .handle("me", me)
      .handle("createNamespace", createNamespace)
      .handle("myPlugins", myPlugins)
      .handle("listComments", listComments)
      .handle("postComment", postComment)
      .handle("deleteComment", deleteComment)
      .handle("getMyRating", getMyRating)
      .handle("putRating", putRating)
      .handle("deleteRating", deleteRating)
      .handle("deleteVersion", deleteVersion)
  }),
)
