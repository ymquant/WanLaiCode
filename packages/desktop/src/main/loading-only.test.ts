import { describe, expect, test } from "bun:test"

describe("desktop loading-only test mode", () => {
  test("keeps the startup window on loading when explicitly enabled", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()

    expect(source).toContain('const LOADING_ONLY = process.env.WANLAICODE_LOADING_ONLY === "1"')
    expect(source).toContain('logger.log("loading-only test mode enabled, staying on loading window")')
    expect(source).toContain("if (LOADING_ONLY) {")
  })

  test("preloads the startup destination before closing the loading window", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()

    expect(source).toContain("let startupLoadingWindow: BrowserWindow | null = null")
    expect(source).toContain('createMainWindow(html, { showOnReady: false })')
    expect(source).toContain("waitForReadyToShow(win)")
    expect(source).toContain("previousLoadingWindow?.destroy()")
  })
})
