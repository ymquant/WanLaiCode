import { describe, expect, test } from "bun:test"

describe("WanlaiCode API key validation toast", () => {
  test("shows only the validation failure reason", async () => {
    const source = await Bun.file(new URL("./dialog-connect-provider.tsx", import.meta.url)).text()
    const block = source.slice(source.indexOf('title: language.t("provider.connect.apiKey.error.title")'))

    expect(block.slice(0, block.indexOf("})") + 2)).not.toContain("description")
  })

  test("refreshes provider state after WanlaiCode API key login", async () => {
    const source = await Bun.file(new URL("./dialog-connect-provider.tsx", import.meta.url)).text()
    const block = source.slice(source.indexOf("async function complete"), source.indexOf("function goBack"))

    expect(block).toContain('queryKey: ["bootstrap"]')
    expect(block).toContain('query.queryKey[1] === "providers"')
  })
})
