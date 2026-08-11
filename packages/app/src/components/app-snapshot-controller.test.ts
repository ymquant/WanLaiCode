import { describe, expect, test } from "bun:test"
import { appSnapshotDataUrl } from "./app-snapshot-data-url"

describe("app snapshot image encoding", () => {
  test("does not depend on FileReader", () => {
    const original = globalThis.FileReader
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {} })

    try {
      expect(appSnapshotDataUrl(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer)).toBe(
        "data:image/png;base64,iVBORw0KGgo=",
      )
    } finally {
      Object.defineProperty(globalThis, "FileReader", { configurable: true, value: original })
    }
  })

  test("encodes buffers larger than one argument chunk", () => {
    const bytes = new Uint8Array(0x8001)
    bytes[0] = 1
    bytes[0x8000] = 2

    const encoded = appSnapshotDataUrl(bytes.buffer).split(",")[1]
    const decoded = atob(encoded)
    expect(decoded.length).toBe(bytes.length)
    expect(decoded.charCodeAt(0)).toBe(1)
    expect(decoded.charCodeAt(0x8000)).toBe(2)
  })
})
