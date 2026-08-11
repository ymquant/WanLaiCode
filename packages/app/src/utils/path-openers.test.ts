import { describe, expect, test } from "bun:test"
import type { InstalledOpener, Platform } from "@/context/platform"
import { createPathOpenerItems } from "./path-openers"
import { clearDefaultEditorOpener, getDefaultEditorOpener, orderOpenersByDefaultEditor, setDefaultEditorOpener } from "./default-opener"

const editor = {
  id: "vscode",
  app: "Code.exe",
  name: "Visual Studio Code",
  kind: "editor",
} satisfies InstalledOpener

const terminal = {
  id: "powershell",
  app: "powershell.exe",
  name: "Windows PowerShell",
  kind: "terminal",
} satisfies InstalledOpener

const cursor = {
  id: "cursor",
  app: "Cursor",
  name: "Cursor",
  kind: "editor",
} satisfies InstalledOpener

const createPlatform = () => {
  const opened: { path: string; app?: string }[] = []
  const invoked: { opener: InstalledOpener; path: string }[] = []
  const revealed: string[] = []
  const platform = {
    platform: "desktop",
    os: "windows",
    openPath: async (path: string, app?: string) => {
      opened.push({ path, app })
    },
    invokeOpener: async (opener: InstalledOpener, path: string) => {
      invoked.push({ opener, path })
    },
    showItemInFolder: async (path: string) => {
      revealed.push(path)
    },
  } satisfies Pick<Platform, "platform" | "os" | "openPath" | "invokeOpener" | "showItemInFolder">
  return { platform, opened, invoked, revealed }
}

describe("createPathOpenerItems", () => {
  test("uses the selected file path for installed opener actions", async () => {
    const context = createPlatform()
    await createPathOpenerItems({
      path: "E:\\repo\\src\\index.ts",
      openers: [editor],
      platform: context.platform,
      t: (key) => key,
    })[0]?.onSelect()

    expect(context.invoked).toEqual([{ opener: editor, path: "E:\\repo\\src\\index.ts" }])
  })

  test("uses the same opener list for files while filtering terminal openers", () => {
    expect(
      createPathOpenerItems({
        path: "E:\\repo\\src\\index.ts",
        openers: [editor, terminal],
        platform: createPlatform().platform,
        t: (key) => key,
        includeTerminals: false,
      }).map((item) => item.label),
    ).toEqual(["session.header.open.app.vscode", "command.file.revealInFinder"])
  })

  test("does not add reveal item when platform cannot reveal in folder", () => {
    const context = createPlatform()
    const platform = { ...context.platform, showItemInFolder: undefined }
    expect(
      createPathOpenerItems({
        path: "E:\\repo\\src\\index.ts",
        openers: [editor],
        platform,
        t: (key) => key,
      }).map((item) => item.label),
    ).toEqual(["session.header.open.app.vscode"])
  })

  test("reveals the selected file itself from the fallback item", async () => {
    const context = createPlatform()
    await createPathOpenerItems({
      path: "E:\\repo\\src\\index.ts",
      openers: [],
      platform: context.platform,
      t: (key) => key,
    })[0]?.onSelect()

    expect(context.revealed).toEqual(["E:\\repo\\src\\index.ts"])
  })
})

describe("default editor opener", () => {
  test("uses stored editor preference before scanned order", () => {
    clearDefaultEditorOpener()
    setDefaultEditorOpener(editor)

    expect(getDefaultEditorOpener([cursor, editor])?.id).toBe("vscode")
    expect(orderOpenersByDefaultEditor([cursor, editor, terminal]).map((item) => item.id)).toEqual([
      "vscode",
      "cursor",
      "powershell",
    ])
  })

  test("falls back to Cursor when no preference has been stored", () => {
    clearDefaultEditorOpener()

    expect(getDefaultEditorOpener([editor, cursor])?.id).toBe("cursor")
  })
})
