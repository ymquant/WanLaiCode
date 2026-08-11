import { describe, expect, test } from "bun:test"
import { jsonAttachmentTitles, sanitizeTitlePart } from "./json-attachment-title"

describe("sanitizeTitlePart", () => {
  test("strips illegal filename characters and collapses whitespace", () => {
    expect(sanitizeTitlePart('  a/b:c*"  ')).toBe("a-b-c")
  })
})

describe("jsonAttachmentTitles", () => {
  test("prefers name/id/title fields for object summaries", () => {
    expect(jsonAttachmentTitles(['{"name":"Alice","age":1}', '{"id":"user-9"}'])).toEqual(["Alice.json", "user-9.json"])
  })

  test("uses key-value summaries for other preferred fields", () => {
    expect(jsonAttachmentTitles(['{"status":"ok"}', '{"city":"Beijing"}'])).toEqual([
      "status-ok.json",
      "city-Beijing.json",
    ])
  })

  test("falls back to JSON-N and dedupes colliding summaries", () => {
    expect(jsonAttachmentTitles(["{}", '{"name":"Alice"}', '{"name":"Alice"}', "[1,2]"])).toEqual([
      "JSON-1.json",
      "Alice.json",
      "Alice-2.json",
      "array-2.json",
    ])
  })

  test("falls back to JSON-N when parse fails", () => {
    expect(jsonAttachmentTitles(["{not-json}", '{"ok":true}'])).toEqual(["JSON-1.json", "ok-true.json"])
  })
})
