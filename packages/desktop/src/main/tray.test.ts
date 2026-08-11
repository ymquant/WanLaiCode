import { describe, expect, test } from "bun:test"

describe("desktop tray", () => {
  test("passes tray GUID only on Windows", async () => {
    const source = await Bun.file(new URL("./tray.ts", import.meta.url)).text()

    expect(source).toContain('const guid = process.platform === "win32" ? TRAY_GUID[CHANNEL] : undefined')
    expect(source).toContain("return guid ? new Tray(trayImage, guid) : new Tray(trayImage)")
    expect(source).not.toContain("new Tray(image.isEmpty() ? nativeImage.createEmpty() : image, guid)")
  })
})
