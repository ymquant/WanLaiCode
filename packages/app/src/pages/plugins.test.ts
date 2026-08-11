import { describe, expect, test } from "bun:test"

describe("Plugins registry namespace identity", () => {
  test("renders namespace next to plugin name and uses namespaced registry keys", async () => {
    const source = await Bun.file(new URL("./plugins.tsx", import.meta.url)).text()

    expect(source).toContain("registryAddonKey")
    expect(source).toContain("addonNamespaceFromKey")
    expect(source).toContain('from "@/utils/plugin-migration"')
    expect(source).toContain("when={props.namespace}")
    expect(source).toContain('class="flex items-baseline gap-1.5 min-w-0"')
    expect(source).toContain('class="text-11-regular text-text-weak truncate shrink-0 max-w-32"')
  })

  test("supports dropping a local plugin archive onto the search page", async () => {
    const source = await Bun.file(new URL("./plugins.tsx", import.meta.url)).text()

    expect(source).toContain("resolveDroppedLocalPluginArchive")
    expect(source).toContain("installLocalArchive")
    expect(source).toContain("handleArchiveDrop")
    expect(source).toContain("onDrop={handleArchiveDrop}")
  })

  test("previews a dropped archive and asks for confirmation before installing", async () => {
    const source = await Bun.file(new URL("./plugins.tsx", import.meta.url)).text()

    expect(source).toContain("previewArchive")
    expect(source).toContain(
      "sdk.client.addon.previewArchive({\n        addonLocalArchivePreviewRequest: { archive_path: archivePath, locale: language.locale() },",
    )
    expect(source).toContain("DialogLocalPluginArchive")
    expect(source).toContain("onConfirm")
  })
})
