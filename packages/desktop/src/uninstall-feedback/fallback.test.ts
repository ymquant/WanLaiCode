import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeUninstallFeedbackFallback } from "./fallback"

describe("writeUninstallFeedbackFallback", () => {
  test("writes a json file with feedback content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uf-"))
    try {
      const file = await writeUninstallFeedbackFallback(
        dir,
        { content: "太卡了换工具", contact: "a@b.com", imageNames: ["s.png"] },
        "20260623T080000Z",
      )
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      expect(parsed.content).toBe("太卡了换工具")
      expect(parsed.contact).toBe("a@b.com")
      expect(parsed.imageNames).toEqual(["s.png"])
      expect(file).toContain("uninstall-feedback-20260623T080000Z.json")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
