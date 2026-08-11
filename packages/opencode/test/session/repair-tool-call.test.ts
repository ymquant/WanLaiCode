import { test, expect, describe } from "bun:test"
import {
  repairToolCall,
  isTruncatedToolInput,
  endsTruncated,
  truncationGuidance,
  describeToolInputError,
  errorMessageOf,
} from "../../src/session/repair-tool-call"

const TOOLS = { write: {}, edit: {}, read: {}, invalid: {} }

// 真实报错形态：参数 JSON 在 content 中途被输出 token 上限截断。
const TRUNCATED_RAW = '{"filePath": "/Users/developer/x.md", "content": "very long content that got cut off mid str'
const TRUNCATED_ERR =
  `Invalid input for tool write: JSON parsing failed: Text: ${TRUNCATED_RAW} ` +
  "Error message: Unterminated string in JSON at position 1234"

describe("endsTruncated (runtime-agnostic structural check)", () => {
  test("flags incomplete JSON prefixes (truncation)", () => {
    expect(endsTruncated(TRUNCATED_RAW)).toBe(true) // ends inside an open string
    expect(endsTruncated('{"a":1')).toBe(true) // unbalanced brace
    expect(endsTruncated('{"a":1,')).toBe(true)
    expect(endsTruncated('{"a":')).toBe(true)
    expect(endsTruncated("{")).toBe(true)
    expect(endsTruncated('{"fil')).toBe(true) // open key string
    expect(endsTruncated('[{"a":1},')).toBe(true)
  })

  test("does NOT flag complete-but-malformed JSON (genuine syntax errors)", () => {
    expect(endsTruncated("{a:1}")).toBe(false) // unquoted key
    expect(endsTruncated('{"a":1 "b":2}')).toBe(false) // missing comma
    expect(endsTruncated("{'a':1}")).toBe(false) // single quotes
    expect(endsTruncated('{"a":1,}')).toBe(false) // trailing comma
    expect(endsTruncated("{}")).toBe(false)
  })

  test("escaped quotes inside strings don't fool the scanner", () => {
    expect(endsTruncated('{"a":"he said \\"hi\\""}')).toBe(false) // balanced, closed
    expect(endsTruncated('{"a":"he said \\"hi')).toBe(true) // still inside string
  })
})

describe("isTruncatedToolInput", () => {
  test("uses the raw input structurally when available (primary signal)", () => {
    expect(isTruncatedToolInput(TRUNCATED_RAW)).toBe(true)
    // genuine malformed input must NOT be treated as truncation even if the parser
    // message is ambiguous — this is the false-positive the structural check prevents.
    expect(isTruncatedToolInput("{a:1}", "Expected double-quoted property name in JSON")).toBe(false)
    expect(isTruncatedToolInput('{"a":1 "b":2}', "Expected ',' or '}' after property value in JSON")).toBe(false)
  })

  test("falls back to high-confidence message signatures when raw input is unavailable", () => {
    expect(isTruncatedToolInput(undefined, "Unterminated string in JSON at position 9")).toBe(true)
    expect(isTruncatedToolInput(undefined, "Unexpected end of JSON input")).toBe(true)
    expect(isTruncatedToolInput(undefined, "JSON Parse error: Unexpected EOF")).toBe(true)
    expect(isTruncatedToolInput(undefined, "some unrelated error")).toBe(false)
  })
})

describe("truncationGuidance", () => {
  test("is actionable, rejects the special-character misdirection, and references real tools only", () => {
    const g = truncationGuidance("write", "Unterminated string in JSON at position 1234")
    expect(g.toLowerCase()).toContain("truncated")
    expect(g.toLowerCase()).toContain("output token limit")
    expect(g.toLowerCase()).toContain("not caused by special characters")
    // references the real `edit` tool, not a non-existent `append` tool
    expect(g).toContain("`edit`")
    expect(g.toLowerCase()).not.toContain("append")
    expect(g).toContain("Unterminated string in JSON at position 1234") // keeps original error
  })
})

describe("repairToolCall", () => {
  test("case-fix: maps wrong-cased tool name to an existing lowercase tool, args untouched", () => {
    const r = repairToolCall({ toolCall: { toolName: "Write", input: '{"a":1}' }, error: new Error("x") }, TOOLS)
    expect(r.toolName).toBe("write")
    expect(r.input).toBe('{"a":1}')
  })

  test("truncated args -> invalid tool with actionable guidance (not the raw JSON error)", () => {
    const r = repairToolCall({ toolCall: { toolName: "write", input: TRUNCATED_RAW }, error: TRUNCATED_ERR }, TOOLS)
    expect(r.toolName).toBe("invalid")
    const payload = JSON.parse(r.input as string) as { tool: string; error: string }
    expect(payload.tool).toBe("write")
    expect(payload.error.toLowerCase()).toContain("truncated")
    expect(payload.error).toContain("`edit`")
    expect(payload.error.toLowerCase()).toContain("not caused by special characters")
  })

  test("complete-but-malformed args -> invalid tool carrying the original error (no truncation guidance)", () => {
    const err = "Expected double-quoted property name in JSON at position 1"
    const r = repairToolCall({ toolCall: { toolName: "write", input: "{a:1}" }, error: err }, TOOLS)
    expect(r.toolName).toBe("invalid")
    const payload = JSON.parse(r.input as string) as { tool: string; error: string }
    expect(payload.error).toBe(err)
    expect(payload.error.toLowerCase()).not.toContain("output token limit")
  })

  test("repaired invalid-tool input is always valid JSON with {tool,error}", () => {
    const r = repairToolCall({ toolCall: { toolName: "write", input: TRUNCATED_RAW }, error: TRUNCATED_ERR }, TOOLS)
    const parsed = JSON.parse(r.input as string)
    expect(parsed).toHaveProperty("tool")
    expect(parsed).toHaveProperty("error")
  })

  test("errorMessageOf handles Error, string, and {message}", () => {
    expect(errorMessageOf(new Error("boom"))).toBe("boom")
    expect(errorMessageOf("boom")).toBe("boom")
    expect(errorMessageOf({ message: "boom" })).toBe("boom")
  })

  test("describeToolInputError passes through non-truncation errors verbatim", () => {
    expect(describeToolInputError("write", "weird error", "{a:1}")).toBe("weird error")
  })
})
