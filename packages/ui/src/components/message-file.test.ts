import { describe, expect, test } from "bun:test"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { attached, inline, kind } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("treats data URLs as attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
  })

  test("treats file attachments without source as attached", () => {
    expect(attached(file())).toBe(true)
  })

  test("treats file attachments with no text range as attached", () => {
    // File attachment with start === end (no text range) should be attached
    expect(
      attached(
        file({
          source: {
            type: "file",
            path: "/repo/app.ts",
            text: { value: "@app.ts", start: 0, end: 0 },
          },
        }),
      ),
    ).toBe(true)

    // File reference with start !== end (has text range) should NOT be attached
    expect(
      attached(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)
  })

  test("treats only non-attachment source ranges as inline references", () => {
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(true)

    expect(
      inline(
        file({
          url: "data:text/plain;base64,SGVsbG8=",
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)
  })

  test("separates image and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })
})
