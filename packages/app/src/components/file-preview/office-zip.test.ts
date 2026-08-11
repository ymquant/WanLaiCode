import { describe, expect, test } from "bun:test"
import JSZip from "jszip"
import { validateOfficeZip } from "./office-zip"

describe("validateOfficeZip budget guard", () => {
  test("rejects zip bombs with too many entries", async () => {
    const zip = new JSZip()
    for (let i = 0; i < 5_001; i++) {
      zip.file(`entry-${i}.txt`, "x")
    }
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(validateOfficeZip(bytes)).rejects.toThrow("too many entries")
  })

  test("rejects when total uncompressed size exceeds budget across multiple entries", async () => {
    const zip = new JSZip()
    const big = "x".repeat(30 * 1024 * 1024)
    zip.file("big.txt", big)
    zip.file("big2.txt", big)
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(validateOfficeZip(bytes)).rejects.toThrow("uncompressed size")
  })

  test("aborts mid-stream on a single oversized entry without fully buffering it", async () => {
    const zip = new JSZip()
    const huge = "x".repeat(60 * 1024 * 1024)
    zip.file("huge.txt", huge)
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(validateOfficeZip(bytes)).rejects.toThrow("uncompressed size")
  })

  test("passes a benign zip within budget", async () => {
    const zip = new JSZip()
    zip.file("a.txt", "hello")
    zip.file("b.txt", "world")
    const bytes = await zip.generateAsync({ type: "uint8array" })
    await expect(validateOfficeZip(bytes)).resolves.toBeDefined()
  })
})
