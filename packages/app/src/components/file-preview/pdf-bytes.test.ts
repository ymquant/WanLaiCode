import { describe, expect, test } from "bun:test"
import { decodePdfBase64 } from "./pdf-bytes"

describe("PDF base64 decoding", () => {
  test("uses the native decoder when available", () => {
    let calls = 0
    const bytes = decodePdfBase64("AQID", (value) => {
      calls++
      expect(value).toBe("AQID")
      return new Uint8Array([1, 2, 3])
    })

    expect(calls).toBe(1)
    expect([...bytes]).toEqual([1, 2, 3])
  })

  test("decodes with the compatibility path when native decoding is unavailable", () => {
    expect([...decodePdfBase64("AAECA/7/")] ).toEqual([0, 1, 2, 3, 254, 255])
  })
})
