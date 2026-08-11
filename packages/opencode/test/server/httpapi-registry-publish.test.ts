import { expect, test } from "bun:test"
import type { LoadedAddon, Marketplace } from "@opencode-ai/addon"
import { resolvePublishPluginTarget } from "../../src/server/routes/instance/httpapi/handlers/registry"

test("resolvePublishPluginTarget falls back to uninstalled local marketplace plugin", () => {
  const target = resolvePublishPluginTarget({
    addonKey: "demo@personal",
    addons: [],
    marketplaces: [
      {
        name: "personal",
        root: "/tmp/personal",
        manifestPath: "/tmp/personal/.agents/plugins/marketplace.json",
        plugins: [
          {
            name: "demo",
            source: { type: "local", path: "/tmp/personal/demo" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          },
        ],
        unsupportedPlugins: [],
      },
    ] satisfies Marketplace[],
  })

  expect(target).toEqual({
    root: "/tmp/personal/demo",
    name: "demo",
    version: undefined,
  })
})

test("resolvePublishPluginTarget prefers local marketplace source over installed cache", () => {
  const target = resolvePublishPluginTarget({
    addonKey: "demo@personal",
    addons: [
      {
        root: "/tmp/cache/personal/demo/1.0.0",
        addonId: { addonName: "demo", marketplaceName: "personal" },
        manifest: { name: "demo", paths: {} },
        version: "1.0.0",
      },
    ] satisfies LoadedAddon[],
    marketplaces: [
      {
        name: "personal",
        root: "/tmp/personal",
        manifestPath: "/tmp/personal/.agents/plugins/marketplace.json",
        plugins: [
          {
            name: "demo",
            source: { type: "local", path: "/tmp/personal/demo" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          },
        ],
        unsupportedPlugins: [],
      },
    ] satisfies Marketplace[],
  })

  expect(target).toEqual({
    root: "/tmp/personal/demo",
    name: "demo",
    version: undefined,
  })
})

test("resolvePublishPluginTarget falls back to installed addon root without a local source", () => {
  const target = resolvePublishPluginTarget({
    addonKey: "demo@wanlaicode",
    addons: [
      {
        root: "/tmp/cache/wanlaicode/demo/1.0.0",
        addonId: { addonName: "demo", marketplaceName: "wanlaicode" },
        manifest: { name: "demo", paths: {} },
        version: "1.0.0",
      },
    ] satisfies LoadedAddon[],
    marketplaces: [
      {
        name: "wanlaicode",
        root: "/tmp/wanlaicode",
        manifestPath: "/tmp/wanlaicode/.agents/plugins/marketplace.json",
        plugins: [
          {
            name: "demo",
            source: { type: "git", url: "https://github.com/example/demo.git" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          },
        ],
        unsupportedPlugins: [],
      },
    ] satisfies Marketplace[],
  })

  expect(target).toEqual({
    root: "/tmp/cache/wanlaicode/demo/1.0.0",
    name: "demo",
    version: "1.0.0",
  })
})

test("resolvePublishPluginTarget supports namespace-aware installed registry addon keys", () => {
  const target = resolvePublishPluginTarget({
    addonKey: "demo@wanlaicode/alice",
    addons: [
      {
        root: "/tmp/cache/wanlaicode/alice/demo/1.0.0",
        addonId: { addonName: "demo", marketplaceName: "wanlaicode", registryNamespace: "alice" },
        manifest: { name: "demo", paths: {} },
        version: "1.0.0",
      },
    ] satisfies LoadedAddon[],
    marketplaces: [],
  })

  expect(target).toEqual({
    root: "/tmp/cache/wanlaicode/alice/demo/1.0.0",
    name: "demo",
    version: "1.0.0",
  })
})

test("registry http api exposes delete version route", async () => {
  const group = await Bun.file(
    new URL("../../src/server/routes/instance/httpapi/groups/registry.ts", import.meta.url),
  ).text()
  const handler = await Bun.file(
    new URL("../../src/server/routes/instance/httpapi/handlers/registry.ts", import.meta.url),
  ).text()

  expect(group).toContain('version: "/registry/plugins/:namespace/:slug/versions/:version"')
  expect(group).toContain('HttpApiEndpoint.delete("deleteVersion"')
  expect(handler).toContain(".handle(\"deleteVersion\", deleteVersion)")
})
