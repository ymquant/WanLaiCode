import { describe, expect, test } from "bun:test"

describe("Plugin detail upload entry", () => {
  test("keeps manage upload entry and renders detail upload as an independent button", async () => {
    const detail = await Bun.file(new URL("./plugin-detail.tsx", import.meta.url)).text()
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(detail).toContain("sdk.client.registry.publish")
    expect(detail).toContain("useRegistryNamespaceGate")
    expect(detail).toContain("ensureRegistryNamespace")
    expect(detail).toContain('marketplace_name === "personal"')
    expect(detail).toContain("plugins.detail.upload.action")
    expect(detail).toContain("queryClient.invalidateQueries({ queryKey: [\"registry\", \"plugins\"], refetchType: \"all\" })")
    expect(detail).toContain('queryKey: ["registry", "plugin", target.namespace, target.slug, language.locale()]')
    expect(detail).toContain("queryClient.setQueryData([\"registry\", \"plugin\", target.namespace, target.slug, language.locale()], res.data)")
    expect(detail).toContain("DetailUploadButton")
    expect(detail).not.toContain("size-8 rounded-full border")
    expect(manage).toContain("sdk.client.registry.publish")
    expect(manage).toContain("useRegistryNamespaceGate")
    expect(manage).toContain("registry.myPlugins")
    expect(manage).toContain("DialogPublishedPlugins")
    expect(manage).not.toContain("PublishedSection")
    expect(manage).not.toContain('type ManageTab = "plugins" | "apps" | "mcps" | "skills" | "marketplace" | "published"')
    expect(manage).not.toContain('const TABS: ManageTab[] = ["plugins", "apps", "mcps", "skills", "marketplace", "published"]')
    expect(manage).toContain("plugins.detail.upload.action")
    expect(manage).toContain("onUpload")
  })

  test("renders registry version management on plugin detail", async () => {
    const detail = await Bun.file(new URL("./plugin-detail.tsx", import.meta.url)).text()
    const shared = await Bun.file(new URL("../components/registry-version-manager.tsx", import.meta.url)).text()

    expect(detail).toContain("RegistryManageVersionsButton")
    expect(detail).toContain("RegistryVersionsDialog")
    expect(shared).toContain("plugins.detail.versions.loading")
    expect(detail).toContain("personalRegistryTarget")
    expect(detail).toContain("registryMe.data.namespace, slug: info.name")
    expect(detail).toContain("const openVersionManager = async")
    expect(detail).toContain("sdk.client.registry.getPlugin")
    expect(detail).toContain("openingVersionManager")
    expect(detail).toContain("dialog.show")
    expect(detail).toContain("sdk.client.registry.deleteVersion")
    expect(shared).toContain("plugins.detail.versions.title")
    expect(shared).toContain("plugins.detail.versions.manage")
    expect(shared).toContain("plugins.detail.versions.delete")
    expect(shared).toContain("bg-[#E5484D] hover:bg-[#D93D42]")
    expect(shared).toContain('style={{ color: "#FFFFFF" }}')
    expect(detail).not.toContain('class="h-8 px-3 rounded-full bg-surface-base hover:bg-surface-base-hover text-13-medium')
  })

  test("renders published plugin version management in manage dialog", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()
    const shared = await Bun.file(new URL("../components/registry-version-manager.tsx", import.meta.url)).text()

    expect(manage).toContain("RegistryManageVersionsButton")
    expect(manage).toContain("RegistryVersionsDialog")
    expect(manage).toContain("openPublishedVersionManager")
    expect(manage).toContain("sdk.client.registry.getPlugin")
    expect(manage).toContain("sdk.client.registry.deleteVersion")
    expect(manage).toContain("dialog.push")
    expect(manage).toContain("plugins.detail.versions.openFailed")
    expect(shared).toContain("plugins.detail.versions.manage")
    expect(manage).not.toContain("plugins.published.delete.action")
    expect(manage).not.toContain("sdk.client.registry.deletePlugin")
  })

  test("explains registry namespace before creation", async () => {
    const namespaceDialog = await Bun.file(new URL("../components/dialog-registry-namespace.tsx", import.meta.url)).text()
    const fileInput = await Bun.file(new URL("../components/dialog-file-input.tsx", import.meta.url)).text()

    expect(namespaceDialog).toContain("plugins.namespace.dialog.description")
    expect(namespaceDialog).toContain("plugins.namespace.dialog.immutable")
    expect(namespaceDialog).toContain("description={")
    expect(namespaceDialog).toContain("transform={(value) => value.toLowerCase()}")
    expect(fileInput).toContain("description?:")
    expect(fileInput).toContain("transform?:")
    expect(fileInput).toContain("props.description")
  })

  test("shows namespace info tooltip in published plugins dialog", async () => {
    const manage = await Bun.file(new URL("./plugins-manage.tsx", import.meta.url)).text()

    expect(manage).toContain('import { Tooltip } from "@opencode-ai/ui/tooltip"')
    expect(manage).toContain('<Icon name="info-circle"')
    expect(manage).toContain("plugins.namespace.dialog.description")
    expect(manage).not.toContain("plugins.namespace.dialog.immutable")
    expect(manage).toContain("plugins.published.namespace")
  })

  test("shows namespace on registry and installed plugin details", async () => {
    const detail = await Bun.file(new URL("./plugin-detail.tsx", import.meta.url)).text()

    expect(detail).toContain("addonNamespaceFromKey")
    expect(detail).toContain("NamespaceLine")
    expect(detail).toContain('namespace={props.namespace}')
    expect(detail).toContain('namespace={addonNamespaceFromKey(props.info.key)}')
    expect(detail).toContain("plugins.detail.info.namespace")
  })
})
