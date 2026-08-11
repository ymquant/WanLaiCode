import { describe, expect, test } from "bun:test"

describe("QuickChatDock provider boundary", () => {
  test("mounts the model bridge inside LocalProvider and keeps the dock global", async () => {
    const directory = await Bun.file(new URL("./directory-layout.tsx", import.meta.url)).text()
    const layout = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()

    const scope = directory.match(/<LocalProvider>([\s\S]*?)<\/LocalProvider>/)?.[1]
    expect(scope).toBeDefined()
    expect(scope).toContain("<QuickChatModelBridge />")
    expect(directory).not.toContain("<QuickChatDock />")
    expect(layout).toContain("<QuickChatDock />")
  })

  test("depends on the bridge module instead of the dock implementation", async () => {
    const directory = await Bun.file(new URL("./directory-layout.tsx", import.meta.url)).text()

    expect(directory).toContain('from "@/components/quick-chat-model-bridge"')
    expect(directory).not.toContain("quick-chat-dock")
  })
})

describe("DirectoryDataProvider file links", () => {
  test("previews project files and preserves system opening for external paths", async () => {
    const source = await Bun.file(new URL("./directory-layout.tsx", import.meta.url)).text()

    expect(source).toContain('import { dispatchOpenLocalFile } from "@/utils/open-local-file"')
    expect(source).toContain("isPathInsideDirectory(abs, props.directory)")
    expect(source).toContain("dispatchOpenLocalFile(abs)")
    expect(source).toContain("platform.openPath?.(abs)")
    expect(source).not.toContain('import { useFile } from "@/context/file"')
    expect(source).not.toContain('import { useSessionKey } from "@/pages/session/session-layout"')
    expect(source).not.toContain("const openLocalPath = createOpenSessionFileTab({")
    expect(source).not.toContain("openLocalPath={(abs) => void platform.openPath?.(abs)}")
  })
})
