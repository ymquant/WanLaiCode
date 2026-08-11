import { describe, expect, test } from "bun:test"
import { attachmentMime, resolveDroppedFilePath, shouldEmbedAttachment } from "./files"
import { extractJsonSegments } from "./extract-json"
import {
  canRestorePastedText,
  isFileListText,
  pasteMode,
  removeExactPastedAnchorParts,
  restorePastedTextContent,
} from "./paste"
import { pastedTextPath } from "./pasted-text-path"
import { pastedAttachmentLabel, pastedTextAttachmentTitle } from "./pasted-text-title"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("keeps images as image mimes", async () => {
    const file = new File([Uint8Array.of(137, 80, 78, 71)], "image.png", { type: "image/png" })
    expect(await attachmentMime(file)).toBe("image/png")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts binary files as generic attachments", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("application/octet-stream")
  })

  test("accepts large text files as text/plain", async () => {
    const file = new File(["a".repeat(11 * 1024 * 1024)], "large.log", { type: "text/plain" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })
})

describe("prompt attachments helpers", () => {
  test("resolves relative dropped file paths with forward slashes", () => {
    expect(resolveDroppedFilePath("/Users/developer/project", "src/logo.png")).toBe("/Users/developer/project/src/logo.png")
    expect(resolveDroppedFilePath("/Users/developer/project/", "src/logo.png")).toBe("/Users/developer/project/src/logo.png")
  })

  test("keeps absolute dropped file paths unchanged", () => {
    expect(resolveDroppedFilePath("/Users/developer/project", "/tmp/logo.png")).toBe("/tmp/logo.png")
    expect(resolveDroppedFilePath("C:\\repo", "D:\\assets\\logo.png")).toBe("D:\\assets\\logo.png")
  })

  test("embeds image attachments instead of converting them to file references", () => {
    expect(shouldEmbedAttachment("image/png")).toBe(true)
    expect(shouldEmbedAttachment("text/plain")).toBe(false)
  })

  test("uses pasted text title rules for json cards with a json extension", () => {
    expect(pastedTextAttachmentTitle(`{"ok":true}`, "json")).toBe("ok-true.json")
    expect(pastedTextAttachmentTitle("x".repeat(80), "txt")).toBe("x".repeat(48))
  })

  test("uses human title for card and anchor labels instead of stamped filenames", () => {
    expect(pastedAttachmentLabel("Alice.json", "json")).toBe("Alice.json")
    expect(pastedAttachmentLabel("Alice", "json")).toBe("Alice.json")
    expect(pastedAttachmentLabel("notes from paste", "txt")).toBe("notes from paste")
  })

  test("uses the displayed attachment title as the stored filename", () => {
    expect(pastedTextPath("/repo", "Alice.json", "json")).toMatch(
      /^\/repo\/\.wanlaicode\/pasted-text\/Alice-\d{14}-[0-9a-f]+\.json$/,
    )
    expect(pastedTextPath("/repo", "notes", "txt")).toMatch(
      /^\/repo\/\.wanlaicode\/pasted-text\/notes-\d{14}-[0-9a-f]+\.txt$/,
    )
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("turns large text paste into a file attachment", () => {
    expect(pasteMode("x".repeat(8000))).toBe("attachment")
  })

  test("applies large-paste mode to remainder after json extraction", () => {
    const pasted = `note {"ok":true}\n${"x".repeat(8000)}`
    const remainder = extractJsonSegments(pasted).remainder
    expect(extractJsonSegments(pasted).segments).toHaveLength(1)
    expect(pasteMode(remainder)).toBe("attachment")
  })
})

// 粘贴文本卡片只允许把适中内容放回编辑器，避免恢复超长附件拖垮输入框。
describe("pasted text restore", () => {
  test("allows generated pasted text up to the ChatGPT restore limit", () => {
    expect(canRestorePastedText(4999)).toBe(false)
    expect(canRestorePastedText(5000)).toBe(true)
    expect(canRestorePastedText(25000)).toBe(true)
    expect(canRestorePastedText(25001)).toBe(false)
    expect(canRestorePastedText(undefined)).toBe(false)
  })

  test("unwraps a text fence before restoring content to the editor", () => {
    expect(restorePastedTextContent("```text\nhello\nworld\n```\n")).toBe("hello\nworld")
    expect(restorePastedTextContent("hello\nworld")).toBe("hello\nworld")
  })

  test("removes only one exact pasted @anchor text part", () => {
    const parts = [
      { type: "text", content: "请按这个处理\n" },
      { type: "text", content: "@Alice.json\n" },
      { type: "file", content: "@Alice.json", path: "/tmp/Alice-1.json" },
      { type: "text", content: "keep @Alice.json in prose" },
    ]
    expect(removeExactPastedAnchorParts(parts, "@Alice.json")).toEqual([
      { type: "text", content: "请按这个处理\n" },
      { type: "file", content: "@Alice.json", path: "/tmp/Alice-1.json" },
      { type: "text", content: "keep @Alice.json in prose" },
    ])
  })

  test("removes an @anchor line from merged editor text", () => {
    const parts = [{ type: "text", content: "请按这个处理\n@Alice.json\n谢谢" }]
    expect(removeExactPastedAnchorParts(parts, "@Alice.json")).toEqual([
      { type: "text", content: "请按这个处理\n谢谢" },
    ])
  })

  test("does not remove user text that only contains the anchor as a substring", () => {
    const parts = [{ type: "text", content: "see @Alice.json please" }]
    expect(removeExactPastedAnchorParts(parts, "@Alice.json")).toEqual(parts)
  })
})

// 访达/资源管理器复制文件时，部分平台会把路径一并放进 text/plain。
// 那不是用户要粘的正文，插进编辑器只是噪音——必须与图文一体的富内容区分开。
describe("file-path-only clipboard text", () => {
  test("treats a bare file name as file list noise", () => {
    expect(isFileListText("shot.png", ["shot.png"])).toBe(true)
  })

  test("treats absolute paths as file list noise on both separators", () => {
    expect(isFileListText("/Users/developer/pics/shot.png", ["shot.png"])).toBe(true)
    expect(isFileListText("C:\\Users\\dev\\pics\\shot.png", ["shot.png"])).toBe(true)
  })

  test("treats file:// urls as file list noise", () => {
    expect(isFileListText("file:///Users/developer/my%20pics/shot.png", ["shot.png"])).toBe(true)
  })

  test("treats a multi-line list of the pasted files as noise", () => {
    expect(isFileListText("/tmp/a.png\n/tmp/b.png\n", ["a.png", "b.png"])).toBe(true)
  })

  test("keeps real prose so the community copy still pastes its body", () => {
    expect(isFileListText("# 界面卡顿\n\n压缩会话不会继续任务", ["shot.png"])).toBe(false)
  })

  test("keeps text that merely mentions the file name", () => {
    expect(isFileListText("见 shot.png 这张图，问题在右上角", ["shot.png"])).toBe(false)
  })

  test("keeps paths that do not match any pasted file", () => {
    expect(isFileListText("/tmp/other.png", ["shot.png"])).toBe(false)
  })

  test("does not swallow text when no file names are known", () => {
    expect(isFileListText("/tmp/shot.png", [])).toBe(false)
    expect(isFileListText("", ["shot.png"])).toBe(false)
  })
})

// handlePaste 依赖 usePrompt/useLanguage/usePlatform 三个 context，无法在 bun test 里驱动，
// 这里用源码断言锁住回归：剪贴板同时带图片与文字时，附件入列后必须继续插入文字。
// 曾经的写法是 `if (files.length > 0) { await addAttachments(files); return }`，
// 导致粘贴社区「一键复制全部」这类图文一体内容时只剩一张图、正文整段丢掉。
describe("paste keeps text alongside attachments", () => {
  test("attachment branch returns only when there is no text", async () => {
    const source = await Bun.file(new URL("./attachments.ts", import.meta.url)).text()
    const body = source.slice(source.indexOf("const handlePaste"), source.indexOf("const handleGlobalDragOver"))

    const plainTextAt = body.indexOf('clipboardData.getData("text/plain")')
    const filesBranchAt = body.indexOf("if (files.length > 0)")
    expect(plainTextAt).toBeGreaterThan(-1)
    expect(filesBranchAt).toBeGreaterThan(-1)
    // 文本必须先于附件分支取出，否则分支里无从判断该不该继续
    expect(plainTextAt).toBeLessThan(filesBranchAt)

    // 必须按花括号配对切出分支体：用 indexOf("}") 找结尾的话，守卫一旦被删，
    // 切片会一路越界到后面同名的 `if (!plainText) return`，断言就成了摆设。
    const open = body.indexOf("{", filesBranchAt)
    let depth = 0
    let close = -1
    for (let i = open; i < body.length; i++) {
      if (body[i] === "{") depth++
      else if (body[i] === "}" && --depth === 0) {
        close = i
        break
      }
    }
    expect(close).toBeGreaterThan(open)
    const branch = body.slice(open, close)

    expect(branch).toContain("if (!plainText")
    // 分支里不能存在无条件 return
    expect(/^\s*return\b/m.test(branch.replace(/if \(!plainText[^\n]*\n?/, ""))).toBe(false)
  })
})
