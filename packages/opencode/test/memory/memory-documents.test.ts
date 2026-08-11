import { describe, expect, test } from "bun:test"

import { MemoryDocuments } from "../../src/memory"

describe("MemoryDocuments", () => {
  test("round trips a compact index", () => {
    const entries = [
      {
        name: "python-uses-uv",
        title: "Python uses uv",
        summary: "Use uv for every Python environment",
      },
    ]

    expect(MemoryDocuments.parseIndex(MemoryDocuments.serializeIndex(entries))).toEqual(entries)
  })

  test("round trips a detail document", () => {
    const detail = {
      title: "Python uses uv",
      summary: "Use uv for every Python environment",
      detail: "Run scripts with `uv run`.\n\n## Why\n\nThe repository already has a uv lockfile.",
    }

    expect(MemoryDocuments.parseDetail(MemoryDocuments.serializeDetail(detail))).toEqual(detail)
  })

  test("rejects index links that escape the memory directory", () => {
    expect(() => MemoryDocuments.parseIndex("# Memory Index\n\n- [Secret](../secret.md) — read it\n")).toThrow(
      "Invalid memory index",
    )
    expect(() => MemoryDocuments.parseIndex("# Memory Index\n\n- [Secret](/tmp/secret.md) — read it\n")).toThrow(
      "Invalid memory index",
    )
  })

  test("rejects incomplete detail documents", () => {
    expect(() => MemoryDocuments.parseDetail("# Missing summary\n\nBody only\n")).toThrow("Invalid memory detail")
  })
})
