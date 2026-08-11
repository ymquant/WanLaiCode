import { describe, expect, test } from "bun:test"

describe("automation editor dialog", () => {
  test("can create and select a blank project without leaving the editor", async () => {
    const source = await Bun.file(new URL("./editor-dialog.tsx", import.meta.url)).text()

    expect(source).toContain("getBlankProjectDefaults")
    expect(source).toContain("createBlankProject({ parent: defaults.parent, name: defaults.name })")
    expect(source).toContain("layout.projects.open(dir)")
    expect(source).toContain("server.projects.touch(dir)")
    expect(source).toContain("setDirectory(dir)")
  })

  test("shows model picker as a labeled pill instead of an icon-only button", async () => {
    const source = await Bun.file(new URL("./editor-dialog.tsx", import.meta.url)).text()
    const modelBlock = source.slice(source.indexOf("value={model()}"), source.indexOf("value={reasoning()}"))

    expect(modelBlock).toContain('placeholder={language.t("automation.detail.modelDefault")}')
    expect(modelBlock).toContain('triggerClass="cdx-pill cdx-model-pill"')
    expect(modelBlock).not.toContain("iconOnly")
  })
})
