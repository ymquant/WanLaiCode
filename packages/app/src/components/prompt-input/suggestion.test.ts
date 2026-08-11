import { describe, expect, test } from "bun:test"
import { ghostSuggestion, isAcceptSuggestionKey } from "./suggestion"

const base = {
  suggestion: "run the tests",
  dirty: false,
  dismissed: false,
  working: false,
  mode: "normal" as const,
  popover: false,
  enabled: true,
  imageGeneration: false,
}

describe("ghostSuggestion", () => {
  test("shows suggestion when input is empty and idle", () => {
    expect(ghostSuggestion(base)).toBe("run the tests")
  })

  test("hidden when disabled by config", () => {
    expect(ghostSuggestion({ ...base, enabled: false })).toBeUndefined()
  })

  test("hidden when no suggestion or blank suggestion", () => {
    expect(ghostSuggestion({ ...base, suggestion: undefined })).toBeUndefined()
    expect(ghostSuggestion({ ...base, suggestion: "  " })).toBeUndefined()
  })

  test("hidden once user typed (dirty) or dismissed", () => {
    expect(ghostSuggestion({ ...base, dirty: true })).toBeUndefined()
    expect(ghostSuggestion({ ...base, dismissed: true })).toBeUndefined()
  })

  test("hidden when the caller suppresses suggestions", () => {
    expect(ghostSuggestion({ ...base, suppressed: true })).toBeUndefined()
  })

  test("hidden while assistant is working", () => {
    expect(ghostSuggestion({ ...base, working: true })).toBeUndefined()
  })

  test("hidden in shell mode or with popover open", () => {
    expect(ghostSuggestion({ ...base, mode: "shell" })).toBeUndefined()
    expect(ghostSuggestion({ ...base, popover: true })).toBeUndefined()
  })

  test("hidden when image generation model is active", () => {
    expect(ghostSuggestion({ ...base, imageGeneration: true })).toBeUndefined()
  })
})

describe("isAcceptSuggestionKey", () => {
  const key = (input: Partial<KeyboardEvent> & { key: string }) => ({
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...input,
  })

  test("accepts Tab and ArrowRight without modifiers", () => {
    expect(isAcceptSuggestionKey(key({ key: "Tab" }))).toBe(true)
    expect(isAcceptSuggestionKey(key({ key: "ArrowRight" }))).toBe(true)
  })

  test("rejects other keys", () => {
    expect(isAcceptSuggestionKey(key({ key: "Enter" }))).toBe(false)
    expect(isAcceptSuggestionKey(key({ key: "ArrowLeft" }))).toBe(false)
  })

  test("rejects any modifier combination", () => {
    expect(isAcceptSuggestionKey(key({ key: "Tab", shiftKey: true }))).toBe(false)
    expect(isAcceptSuggestionKey(key({ key: "Tab", altKey: true }))).toBe(false)
    expect(isAcceptSuggestionKey(key({ key: "ArrowRight", ctrlKey: true }))).toBe(false)
    expect(isAcceptSuggestionKey(key({ key: "ArrowRight", metaKey: true }))).toBe(false)
  })
})
