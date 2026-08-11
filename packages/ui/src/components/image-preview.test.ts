import { describe, expect, test } from "bun:test"

describe("ImagePreview", () => {
  test("keeps zoom state per image", async () => {
    const source = await Bun.file(new URL("./image-preview.tsx", import.meta.url)).text()

    expect(source).toContain('const [zooms, setZooms] = createStore<Record<string, number>>({})')
    expect(source).toContain('const zoomKey = () => current().src')
    expect(source).toContain('const zoom = () => zooms[zoomKey()] ?? 100')
    expect(source).toContain('setZooms(zoomKey(), next)')
    expect(source).toContain('setZoomText(String(zoom()))')
    expect(source).toContain('setFit(undefined)')
    expect(source).not.toContain('applyZoom(100)')
  })
})
