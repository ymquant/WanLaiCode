import { describe, expect, test } from "bun:test"
import { appSnapshotThumbnailSize, matchAppSnapshotSource } from "./app-snapshot-utils"

describe("app snapshots", () => {
  test("matches a desktop source by display id", () => {
    const sources = [
      { display_id: "77" },
      { display_id: "42" },
    ]

    expect(matchAppSnapshotSource(42, sources)).toBe(sources[1])
  })

  test("uses the only screen source when a platform omits its display id", () => {
    const sources = [{ display_id: "" }]

    expect(matchAppSnapshotSource(42, sources)).toBe(sources[0])
  })

  test("captures the full physical display resolution", () => {
    expect(appSnapshotThumbnailSize({ size: { width: 1512, height: 982 }, scaleFactor: 2 })).toEqual({
      width: 3024,
      height: 1964,
    })
    expect(appSnapshotThumbnailSize({ size: { width: 2560, height: 1440 }, scaleFactor: 1 })).toEqual({
      width: 2560,
      height: 1440,
    })
  })
})
