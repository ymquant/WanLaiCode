import { Addon } from "@/addon"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

export class AddonRequestError extends Schema.ErrorClass<AddonRequestError>("AddonRequestError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export const AddonPaths = {
  list: "/addon",
  available: "/addon/available",
  refresh: "/addon/refresh",
  skills: "/addon/skills",
  skillContent: "/addon/skills/content",
  toggle: "/addon/toggle",
  skillToggle: "/addon/skills/toggle",
  skillInstall: "/addon/skills/install",
  skillCreate: "/addon/skills/create",
  get: "/addon/:key",
  install: "/addon/install",
  installArchive: "/addon/install/archive",
  previewArchive: "/addon/preview/archive",
  uninstall: "/addon/uninstall",
} as const

export const AddonApi = HttpApi.make("addon")
  .add(
    HttpApiGroup.make("addon")
      .add(
        HttpApiEndpoint.get("list", AddonPaths.list, {
          success: described(Schema.Array(Addon.Info), "Loaded addons"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.list",
            summary: "List addons",
            description: "List all loaded addons.",
          }),
        ),
        HttpApiEndpoint.get("available", AddonPaths.available, {
          query: Schema.Struct({ locale: Schema.optional(Schema.String) }),
          success: described(Schema.Array(Addon.Available), "Available marketplace addons"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.available",
            summary: "List available addons",
            description:
              "List all addons from configured marketplaces, including installed status. Use this for browse + install UIs.",
          }),
        ),
        HttpApiEndpoint.post("refresh", AddonPaths.refresh, {
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Addon caches invalidated"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.refresh",
            summary: "Refresh addon discovery",
            description:
              "Invalidate the cached addon snapshot so the next available/list re-scans local marketplaces. Use when local plugin files may have changed out-of-band (e.g. created via the plugin-creator skill).",
          }),
        ),
        HttpApiEndpoint.get("skills", AddonPaths.skills, {
          success: described(Schema.Array(Addon.SkillListItem), "Loaded skills across enabled addons"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.skills",
            summary: "List skills",
            description: "List all skills exposed by enabled addons, with per-skill enabled status.",
          }),
        ),
        HttpApiEndpoint.get("skillContent", AddonPaths.skillContent, {
          query: Schema.Struct({ addon_key: Schema.String, name: Schema.String }),
          success: described(Addon.SkillContent, "Skill markdown content"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.skillContent",
            summary: "Get skill content",
            description: "Read a single skill's SKILL.md content for detail views.",
          }),
        ),
        HttpApiEndpoint.post("toggle", AddonPaths.toggle, {
          payload: Addon.ToggleRequest,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Addon enabled state updated"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.toggle",
            summary: "Enable or disable an addon",
            description: "Persist an addon's enabled state to config and hot-reload the instance.",
          }),
        ),
        HttpApiEndpoint.post("skillToggle", AddonPaths.skillToggle, {
          payload: Addon.SkillToggleRequest,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Skill enabled state updated"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.skillToggle",
            summary: "Enable or disable a skill",
            description: "Persist a single skill's enabled state to config.",
          }),
        ),
        HttpApiEndpoint.post("skillInstall", AddonPaths.skillInstall, {
          payload: Addon.SkillInstallRequest,
          success: described(Schema.Struct({ ok: Schema.Boolean }), "Skill installed state updated"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.skillInstall",
            summary: "Install or uninstall a skill",
            description: "Persist a single skill's installed state separately from its enabled state.",
          }),
        ),
        HttpApiEndpoint.post("skillCreate", AddonPaths.skillCreate, {
          payload: Addon.SkillCreateRequest,
          success: described(Addon.SkillCreateOutcome, "Local skill created"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.skillCreate",
            summary: "Create a local skill",
            description: "Append a SKILL.md under <addon>/skills/<name>/ in an installed addon.",
          }),
        ),
        HttpApiEndpoint.post("install", AddonPaths.install, {
          payload: Addon.InstallRequest,
          success: described(Addon.InstallOutcome, "Addon installed"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.install",
            summary: "Install an addon",
            description: "Install an addon from a configured marketplace.",
          }),
        ),
        HttpApiEndpoint.post("installArchive", AddonPaths.installArchive, {
          payload: Addon.LocalArchiveInstallRequest,
          success: described(Addon.InstallOutcome, "Local addon archive installed"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.installArchive",
            summary: "Install a local addon archive",
            description: "Install a local .tar, .tar.gz, or .tgz addon package from an absolute path.",
          }),
        ),
        HttpApiEndpoint.post("previewArchive", AddonPaths.previewArchive, {
          payload: Addon.LocalArchivePreviewRequest,
          success: described(Addon.LocalArchivePreview, "Local addon archive preview"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.previewArchive",
            summary: "Preview a local addon archive",
            description: "Read local .tar, .tar.gz, or .tgz addon metadata without installing it.",
          }),
        ),
        HttpApiEndpoint.post("uninstall", AddonPaths.uninstall, {
          payload: Addon.InstallRequest,
          success: described(Addon.UninstallOutcome, "Addon uninstalled"),
          error: AddonRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.uninstall",
            summary: "Uninstall an addon",
            description: "Uninstall an addon and remove its config entry.",
          }),
        ),
        HttpApiEndpoint.get("get", AddonPaths.get, {
          params: { key: Schema.String },
          success: described(Addon.Detail, "Addon detail"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "addon.get",
            summary: "Get addon detail",
            description: "Get detail of a specific addon by key (<addon>@<marketplace>).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "addon",
          description: "Experimental HttpApi addon routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
