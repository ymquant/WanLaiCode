import { describe, expect, test } from "bun:test"
import {
  PASTED_PREVIEW_MAX_CHARS,
  canPreviewPastedAttachment,
  closePastedAttachmentPreview,
  isPastedTextPath,
  isValidPastedJson,
  pastedAttachmentKind,
} from "./pasted-attachment"

describe("isPastedTextPath", () => {
  test("matches unix pasted-text paths", () => {
    expect(isPastedTextPath("/repo/.wanlaicode/pasted-text/Alice-20260101120000-abcd1234.json")).toBe(true)
    expect(isPastedTextPath("/repo/.wanlaicode/pasted-text/notes-20260101120000-abcd1234.txt")).toBe(true)
  })

  test("matches windows pasted-text paths", () => {
    expect(isPastedTextPath("D:\\repo\\.wanlaicode\\pasted-text\\Alice-20260101120000-abcd1234.json")).toBe(true)
    expect(isPastedTextPath("D:\\repo\\.wanlaicode\\pasted-text\\notes-20260101120000-abcd1234.txt")).toBe(true)
  })

  test("rejects unrelated paths", () => {
    expect(isPastedTextPath("/repo/src/data.json")).toBe(false)
    expect(isPastedTextPath("/repo/.wanlaicode/config.json")).toBe(false)
    expect(isPastedTextPath("/repo/.wanlaicode/pasted-text")).toBe(false)
    expect(isPastedTextPath("/repo/pasted-text/notes.txt")).toBe(false)
  })
})

describe("pastedAttachmentKind", () => {
  test("returns json or text only under pasted-text", () => {
    expect(pastedAttachmentKind("/repo/.wanlaicode/pasted-text/a.json")).toBe("json")
    expect(pastedAttachmentKind("/repo/.wanlaicode/pasted-text/a.txt")).toBe("text")
    expect(pastedAttachmentKind("C:\\repo\\.wanlaicode\\pasted-text\\a.JSON")).toBe("json")
    expect(pastedAttachmentKind("/repo/src/a.json")).toBeUndefined()
    expect(pastedAttachmentKind("/repo/.wanlaicode/pasted-text/a.md")).toBeUndefined()
  })
})

describe("canPreviewPastedAttachment", () => {
  test("allows content at or below the limit", () => {
    expect(canPreviewPastedAttachment(0)).toBe(true)
    expect(canPreviewPastedAttachment(PASTED_PREVIEW_MAX_CHARS)).toBe(true)
    expect(canPreviewPastedAttachment(PASTED_PREVIEW_MAX_CHARS + 1)).toBe(false)
  })
})

describe("isValidPastedJson", () => {
  test("accepts parseable json", () => {
    expect(isValidPastedJson('{"ok":true}')).toBe(true)
    expect(isValidPastedJson("[1,2]")).toBe(true)
  })

  test("rejects invalid json", () => {
    expect(isValidPastedJson("{ok:true}")).toBe(false)
    expect(isValidPastedJson("")).toBe(false)
  })
})

describe("closePastedAttachmentPreview", () => {
  test("closes without saving when the draft is clean", async () => {
    const calls: string[] = []
    await closePastedAttachmentPreview({
      dirty: false,
      onSave: async () => {
        calls.push("save")
        return true
      },
      onClose: () => {
        calls.push("close")
      },
    })
    expect(calls).toEqual(["close"])
  })

  test("attempts save then closes when dirty and save succeeds", async () => {
    const calls: string[] = []
    await closePastedAttachmentPreview({
      dirty: true,
      onSave: async () => {
        calls.push("save")
        return true
      },
      onClose: () => {
        calls.push("close")
      },
    })
    expect(calls).toEqual(["save", "close"])
  })

  test("still closes and discards when dirty save fails", async () => {
    const calls: string[] = []
    await closePastedAttachmentPreview({
      dirty: true,
      onSave: async () => {
        calls.push("save")
        return false
      },
      onClose: () => {
        calls.push("close")
      },
    })
    expect(calls).toEqual(["save", "close"])
  })
})
