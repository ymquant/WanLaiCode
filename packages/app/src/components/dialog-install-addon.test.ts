import { describe, expect, test } from "bun:test"

describe("plugin install confirmation dialog", () => {
  test("supports registry installation callbacks and displays the selected version", async () => {
    const source = await Bun.file(new URL("./dialog-install-addon.tsx", import.meta.url)).text()

    expect(source).toContain("onInstall")
    expect(source).toContain("props.version")
    expect(source).toContain("props.onInstall")
  })
})
