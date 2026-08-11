import { describe, expect, test } from "bun:test"
import type { AddonAvailable, RegistryPluginOut } from "@opencode-ai/sdk/v2"
import {
  addonMentionKey,
  isAddonSupersededByInstalledRegistry,
  migrationSourceKeysForTarget,
  migrationTargetForAddon,
  registryAddonKey,
} from "./plugin-migration"

const registry = (namespace: string, slug = "demo") =>
  ({
    namespace,
    slug,
  }) as RegistryPluginOut

const addon = (input: Partial<AddonAvailable> & Pick<AddonAvailable, "key" | "marketplace_name">) =>
  ({
    key: input.key,
    name: input.name ?? "demo",
    marketplace_name: input.marketplace_name,
    registry_namespace: input.registry_namespace,
    installed: input.installed ?? true,
  }) as AddonAvailable

describe("plugin migration target resolution", () => {
  test("migrates old openai marketplace addons to the single matching namespaced registry plugin", () => {
    expect(
      migrationTargetForAddon({
        addon: addon({ key: "demo@openai-curated", marketplace_name: "openai-curated" }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set(),
      }),
    ).toEqual(registry("alice"))
  })

  test("does not migrate openai marketplace addons when registry has no matching slug", () => {
    expect(
      migrationTargetForAddon({
        addon: addon({ key: "demo@openai-curated", marketplace_name: "openai-curated" }),
        registryPlugins: [registry("alice", "other-demo")],
        installedRegistryKeys: new Set(),
      }),
    ).toBeUndefined()
  })

  test("migrates legacy registry addons without namespace to the namespaced registry plugin", () => {
    expect(
      migrationTargetForAddon({
        addon: addon({ key: "demo@wanlaicode", marketplace_name: "wanlaicode" }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set(),
      }),
    ).toEqual(registry("alice"))
  })

  test("migrates disabled but installed addons", () => {
    expect(
      migrationTargetForAddon({
        addon: addon({ key: "demo@wanlaicode", marketplace_name: "wanlaicode", disabled: true }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set(),
      }),
    ).toEqual(registry("alice"))
  })

  test("does not migrate when the namespaced registry target is already installed", () => {
    expect(
      migrationTargetForAddon({
        addon: addon({ key: "demo@wanlaicode", marketplace_name: "wanlaicode" }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set([registryAddonKey(registry("alice"))]),
      }),
    ).toBeUndefined()
  })

  test("does not guess when multiple namespaces publish the same slug", () => {
    expect(
      migrationTargetForAddon({
        addon: addon({ key: "demo@wanlaicode", marketplace_name: "wanlaicode" }),
        registryPlugins: [registry("alice"), registry("bob")],
        installedRegistryKeys: new Set(),
      }),
    ).toBeUndefined()
  })
})

describe("plugin migration dedupe", () => {
  test("hides old openai marketplace addon after its namespaced registry target is installed", () => {
    expect(
      isAddonSupersededByInstalledRegistry({
        addon: addon({ key: "demo@openai-plugins", marketplace_name: "openai-plugins" }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set([registryAddonKey(registry("alice"))]),
      }),
    ).toBe(true)
  })

  test("hides legacy registry addon without namespace after its namespaced target is installed", () => {
    expect(
      isAddonSupersededByInstalledRegistry({
        addon: addon({ key: "demo@wanlaicode", marketplace_name: "wanlaicode" }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set([registryAddonKey(registry("alice"))]),
      }),
    ).toBe(true)
  })

  test("keeps old addon visible before a namespaced target is installed so it can show migrate", () => {
    expect(
      isAddonSupersededByInstalledRegistry({
        addon: addon({ key: "demo@openai-plugins", marketplace_name: "openai-plugins" }),
        registryPlugins: [registry("alice")],
        installedRegistryKeys: new Set(),
      }),
    ).toBe(false)
  })
})

describe("plugin migration cleanup keys", () => {
  test("cleans both openai and legacy registry copies for the same namespaced target", () => {
    expect(
      migrationSourceKeysForTarget({
        target: registry("alice"),
        addons: [
          addon({ key: "demo@openai-curated", marketplace_name: "openai-curated" }),
          addon({ key: "demo@wanlaicode", marketplace_name: "wanlaicode" }),
          addon({ key: "other@openai-curated", marketplace_name: "openai-curated", name: "other" }),
          addon({ key: registryAddonKey(registry("alice")), marketplace_name: "wanlaicode" }),
        ],
        registryPlugins: [registry("alice")],
      }).sort(),
    ).toEqual(["demo@openai-curated", "demo@wanlaicode"])
  })
})

describe("plugin mention keys", () => {
  test("uses registry namespace when building mention key for registry addons", () => {
    expect(
      addonMentionKey(
        addon({
          key: "demo@wanlaicode",
          marketplace_name: "wanlaicode",
          registry_namespace: "alice",
        }),
      ),
    ).toBe("demo@wanlaicode/alice")
  })

  test("keeps non-registry addon mention key unchanged", () => {
    expect(addonMentionKey(addon({ key: "demo@openai-curated", marketplace_name: "openai-curated" }))).toBe(
      "demo@openai-curated",
    )
  })
})
