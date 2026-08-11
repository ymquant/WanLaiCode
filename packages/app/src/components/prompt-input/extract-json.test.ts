import { describe, expect, test } from "bun:test"
import { extractJsonSegments, isPureJsonPaste, pasteStrategy, remainderWithoutSegments, splitPasteSegments } from "./extract-json"

describe("extractJsonSegments", () => {
  test("extracts a single object from mixed text", () => {
    const result = extractJsonSegments(`请看 {"a":1} 谢谢`)
    expect(result.segments).toEqual([{ start: 3, end: 10, json: `{"a":1}` }])
    expect(result.remainder).toBe("请看  谢谢")
  })

  test("extracts multiple objects into separate segments", () => {
    const result = extractJsonSegments(`one {"a":1} two {"b":2} three`)
    expect(result.segments.map((segment) => segment.json)).toEqual([`{"a":1}`, `{"b":2}`])
    expect(result.remainder).toBe("one  two  three")
  })

  test("extracts only the outermost nested object", () => {
    const result = extractJsonSegments(`wrap {"a":{"b":1}} done`)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.json).toBe(`{"a":{"b":1}}`)
    expect(result.remainder).toBe("wrap  done")
  })

  test("extracts arrays", () => {
    const result = extractJsonSegments(`items [1,2,{"x":true}] end`)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.json).toBe(`[1,2,{"x":true}]`)
    expect(result.remainder).toBe("items  end")
  })

  test("ignores non-json braces", () => {
    const result = extractJsonSegments(`function(){ return 1 } and {not json}`)
    expect(result.segments).toEqual([])
    expect(result.remainder).toBe(`function(){ return 1 } and {not json}`)
  })

  test("skips extraction for large brace-heavy text without likely json", () => {
    const text = Array.from({ length: 5000 }, (_, index) => `function test${index}(){ return [${index}] }`).join("\n")
    const result = extractJsonSegments(text)
    expect(result.segments).toEqual([])
    expect(result.remainder).toBe(text)
  })

  test("still extracts obvious json from large text", () => {
    const text = `${"x".repeat(70_000)}\n{"ok":true}`
    const result = extractJsonSegments(text)
    expect(result.segments).toEqual([{ start: 70_001, end: text.length, json: `{"ok":true}` }])
  })

  test("treats pure json paste as a single attachment with empty remainder", () => {
    const json = `{\n  "ok": true\n}`
    const result = extractJsonSegments(json)
    expect(result.segments).toEqual([{ start: 0, end: json.length, json }])
    expect(result.remainder).toBe("")
  })

  test("does not split on braces inside strings", () => {
    const result = extractJsonSegments(`note {"msg":"has { brace }"} tail`)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.json).toBe(`{"msg":"has { brace }"}`)
    expect(result.remainder).toBe("note  tail")
  })

  test("ignores json primitives", () => {
    const result = extractJsonSegments(`value "hi" and 123 and true`)
    expect(result.segments).toEqual([])
    expect(result.remainder).toBe(`value "hi" and 123 and true`)
  })

  test("remainderWithoutSegments keeps unattached json in place", () => {
    const text = `one {"a":1} two {"b":2} three`
    const all = extractJsonSegments(text)
    expect(remainderWithoutSegments(text, [all.segments[0]!])).toBe(`one  two {"b":2} three`)
  })
})

describe("splitPasteSegments", () => {
  test("returns a single text segment when there is no json", () => {
    expect(splitPasteSegments("hello world")).toEqual([
      { type: "text", content: "hello world", rawContent: "hello world", start: 0, end: 11 },
    ])
  })

  test("returns a single json segment for pure json", () => {
    const json = `{"ok":true}`
    expect(splitPasteSegments(json)).toEqual([{ type: "json", content: json, start: 0, end: json.length }])
  })

  test("preserves interleaved json and text order", () => {
    const text = `intro {"a":1} mid {"b":2} tail`
    expect(splitPasteSegments(text).map((segment) => [segment.type, segment.content])).toEqual([
      ["text", "intro"],
      ["json", `{"a":1}`],
      ["text", "mid"],
      ["json", `{"b":2}`],
      ["text", "tail"],
    ])
  })

  test("keeps surrounding newlines on text rawContent while trimming content", () => {
    const text = `请按这个处理\n{"a":1}\n对比下面这个\n{"b":2}\n`
    const segments = splitPasteSegments(text)
    expect(segments.map((segment) => segment.type)).toEqual(["text", "json", "text", "json", "text"])
    expect(
      segments.flatMap((segment) => (segment.type === "text" ? [[segment.content, segment.rawContent]] : [])),
    ).toEqual([
      ["请按这个处理", "请按这个处理\n"],
      ["对比下面这个", "\n对比下面这个\n"],
      ["", "\n"],
    ])
  })

  test("keeps whitespace-only gaps between json segments as text", () => {
    const text = `{"a":1}   {"b":2}`
    const segments = splitPasteSegments(text)
    expect(segments.map((segment) => segment.type)).toEqual(["json", "text", "json"])
    expect(segments[1]).toEqual({ type: "text", content: "", rawContent: "   ", start: 7, end: 10 })
  })

  test("keeps long text segments intact for later pasteMode checks", () => {
    const long = "x".repeat(8000)
    const text = `{"a":1}\n${long}\n{"b":2}`
    const segments = splitPasteSegments(text)
    expect(segments.map((segment) => segment.type)).toEqual(["json", "text", "json"])
    expect(segments[1]?.type === "text" && segments[1].content).toBe(long)
    expect(segments[1]?.type === "text" && segments[1].rawContent).toBe(`\n${long}\n`)
  })
})

describe("pasteStrategy", () => {
  test("keeps short instruction plus single json on the default path", () => {
    const segments = splitPasteSegments(`请按这个处理\n{"a":1}`)
    expect(pasteStrategy(segments)).toEqual({ type: "default", segments })
  })

  test("treats multiple json segments with short text as mixed inline paste", () => {
    const segments = splitPasteSegments(`{"a":1}\n对比下面这个\n{"b":2}`)
    expect(pasteStrategy(segments)).toEqual({
      type: "mixed-json",
      segments,
      textMode: "inline",
    })
  })

  test("routes long mixed text to an attachment", () => {
    const notes = "x".repeat(8000)
    const segments = splitPasteSegments(`前置说明\n{"a":1}\n${notes}\n{"b":2}`)
    expect(pasteStrategy(segments)).toMatchObject({
      type: "mixed-json",
      textMode: "attachment",
    })
  })

  test("routes one json with long surrounding text to an attachment", () => {
    const notes = "x".repeat(8000)
    const segments = splitPasteSegments(`前置说明\n{"a":1}\n${notes}`)
    expect(pasteStrategy(segments)).toMatchObject({
      type: "mixed-json",
      textMode: "attachment",
    })
  })
})

describe("isPureJsonPaste", () => {
  test("accepts a single json object or array with only surrounding whitespace", () => {
    expect(isPureJsonPaste(`{"ok":true}`)).toBe(true)
    expect(isPureJsonPaste(`\n  {"name":"Alice"}  \n`)).toBe(true)
    expect(isPureJsonPaste(`[1,2,3]`)).toBe(true)
  })

  test("accepts large pure json pastes", () => {
    const json = `{"name":"Alice","payload":"${"x".repeat(8000)}"}`
    expect(isPureJsonPaste(json)).toBe(true)
  })

  test("rejects mixed text and json", () => {
    expect(isPureJsonPaste(`note {"ok":true}`)).toBe(false)
    expect(isPureJsonPaste(`{"a":1}\n{"b":2}`)).toBe(false)
  })
})
