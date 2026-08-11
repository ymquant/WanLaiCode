import { Addon } from "@/addon"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { Command } from "@/command"
import { Plugin } from "@/plugin"
import { Bus } from "@/bus"
import * as AddonLoader from "@opencode-ai/addon"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { AddonRequestError } from "../groups/addon"
import {
  autoAuthRemoteMcpServers,
  refreshAddonCapabilities,
  type AddonInstallLifecycleServices,
  uninstallAddonWithMcpAuthCleanup,
} from "./addon-install-lifecycle"

const USER_ERRORS = new Set([
  AddonLoader.AddonNotFoundInMarketplaceError.name,
  AddonLoader.AddonInstallNotAvailableError.name,
  AddonLoader.InvalidAddonKeyError.name,
  AddonLoader.AddonManifestMismatchError.name,
  AddonLoader.AddonInstallError.name,
  AddonLoader.LocalAddonArchiveError.name,
  AddonLoader.MarketplaceParseError.name,
  Addon.MarketplaceNotConfiguredError.name,
  Addon.NamespacedMarketplaceInstallError.name,
  Addon.AddonNotFoundError.name,
  Addon.SkillNotFoundError.name,
  Addon.SkillAlreadyExistsError.name,
  Addon.InvalidSkillNameError.name,
])

function mapServiceError<A>(eff: Effect.Effect<A, Error>): Effect.Effect<A, AddonRequestError> {
  return eff.pipe(
    Effect.catch((err: Error) => {
      if (USER_ERRORS.has(err.name)) {
        return Effect.fail(new AddonRequestError({ error: err.message }))
      }
      return Effect.die(err)
    }),
  )
}

export const addonHandlers = HttpApiBuilder.group(InstanceHttpApi, "addon", (handlers) =>
  Effect.gen(function* () {
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
    const refreshCapabilities = () => refreshAddonCapabilities(lifecycleServices)

    const list = Effect.fn("AddonHttpApi.list")(function* () {
      const addons = yield* addonSvc.getAddons()
      return addons.map(Addon.toInfo)
    })

    const available = Effect.fn("AddonHttpApi.available")(function* (ctx: { query: { locale?: string } }) {
      return yield* addonSvc.getAvailableAddons(ctx.query.locale)
    })

    const get = Effect.fn("AddonHttpApi.get")(function* (ctx: { params: { key: string } }) {
      const addons = yield* addonSvc.getAddons()
      const addon = addons.find((item) => AddonLoader.addonKey(item.addonId) === ctx.params.key)
      if (!addon) return yield* new HttpApiError.NotFound()
      return Addon.toDetail(addon)
    })

    const install = Effect.fn("AddonHttpApi.install")(function* (ctx: { payload: Addon.InstallRequest }) {
      const addonId = yield* mapServiceError(
        Effect.try({
          try: () => AddonLoader.parseAddonKey(ctx.payload.addon_key),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
      )
      const outcome = yield* mapServiceError(
        addonSvc.installAddon({
          addonName: addonId.addonName,
          marketplaceName: addonId.marketplaceName,
          registryNamespace: addonId.registryNamespace,
        }),
      )
      yield* refreshCapabilities()
      yield* autoAuthRemoteMcpServers(lifecycleServices, outcome.key).pipe(Effect.forkDetach)
      return {
        key: outcome.key,
        version: outcome.version,
        installed_path: outcome.installedPath,
        auth_policy: outcome.authPolicy,
      } satisfies Addon.InstallOutcome
    })

    const installArchive = Effect.fn("AddonHttpApi.installArchive")(function* (ctx: {
      payload: Addon.LocalArchiveInstallRequest
    }) {
      const outcome = yield* mapServiceError(addonSvc.installLocalArchive(ctx.payload.archive_path))
      yield* refreshCapabilities()
      yield* autoAuthRemoteMcpServers(lifecycleServices, outcome.key).pipe(Effect.forkDetach)
      return {
        key: outcome.key,
        version: outcome.version,
        installed_path: outcome.installedPath,
        auth_policy: outcome.authPolicy,
      } satisfies Addon.InstallOutcome
    })

    const previewArchive = Effect.fn("AddonHttpApi.previewArchive")(function* (ctx: {
      payload: Addon.LocalArchivePreviewRequest
    }) {
      return yield* mapServiceError(addonSvc.previewLocalArchive(ctx.payload.archive_path, ctx.payload.locale))
    })

    const uninstall = Effect.fn("AddonHttpApi.uninstall")(function* (ctx: { payload: Addon.InstallRequest }) {
      const outcome = yield* mapServiceError(
        uninstallAddonWithMcpAuthCleanup(
          lifecycleServices,
          ctx.payload.addon_key,
          addonSvc.uninstallAddon(ctx.payload.addon_key),
        ),
      )
      yield* refreshCapabilities()
      return { key: outcome.key } satisfies Addon.UninstallOutcome
    })

    const skills = Effect.fn("AddonHttpApi.skills")(function* () {
      return yield* addonSvc.getSkillList()
    })

    const skillContent = Effect.fn("AddonHttpApi.skillContent")(function* (ctx: {
      query: { addon_key: string; name: string }
    }) {
      return yield* mapServiceError(addonSvc.getSkillContent(ctx.query.addon_key, ctx.query.name))
    })

    const toggle = Effect.fn("AddonHttpApi.toggle")(function* (ctx: { payload: Addon.ToggleRequest }) {
      yield* mapServiceError(addonSvc.setAddonEnabled(ctx.payload.addon_key, ctx.payload.enabled))
      yield* refreshCapabilities()
      return { ok: true }
    })

    const skillToggle = Effect.fn("AddonHttpApi.skillToggle")(function* (ctx: { payload: Addon.SkillToggleRequest }) {
      yield* mapServiceError(addonSvc.setSkillEnabled(ctx.payload.addon_key, ctx.payload.name, ctx.payload.enabled))
      yield* refreshCapabilities()
      return { ok: true }
    })

    const skillInstall = Effect.fn("AddonHttpApi.skillInstall")(function* (ctx: { payload: Addon.SkillInstallRequest }) {
      yield* mapServiceError(addonSvc.setSkillInstalled(ctx.payload.addon_key, ctx.payload.name, ctx.payload.installed))
      yield* refreshCapabilities()
      return { ok: true }
    })

    const skillCreate = Effect.fn("AddonHttpApi.skillCreate")(function* (ctx: { payload: Addon.SkillCreateRequest }) {
      return yield* mapServiceError(addonSvc.createLocalSkill(ctx.payload))
    })

    const refresh = Effect.fn("AddonHttpApi.refresh")(function* () {
      // 仅失效 addon 缓存,使下次 available/list 重扫磁盘(发现对话里 out-of-band 新建的插件)。
      // 刻意不走 refreshCapabilities():进页面无需重连 MCP / 重建 skill·command 注册表。
      yield* addonSvc.invalidate()
      return { ok: true }
    })

    return handlers
      .handle("list", list)
      .handle("available", available)
      .handle("refresh", refresh)
      .handle("skills", skills)
      .handle("skillContent", skillContent)
      .handle("toggle", toggle)
      .handle("skillToggle", skillToggle)
      .handle("skillInstall", skillInstall)
      .handle("skillCreate", skillCreate)
      .handle("get", get)
      .handle("install", install)
      .handle("installArchive", installArchive)
      .handle("previewArchive", previewArchive)
      .handle("uninstall", uninstall)
  }),
)
