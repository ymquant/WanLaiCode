import { describe, expect, test } from "bun:test"

import { Memory, MemoryContext } from "../../src/memory"

function entry(input: Pick<Memory.Entry, "scope" | "name" | "title" | "summary">): Memory.Entry {
  return {
    id: Memory.MemoryID.ascending(),
    ...input,
  }
}

describe("MemoryContext", () => {
  test("ranks keyword relevance before project scope", () => {
    const selected = MemoryContext.select({
      entries: [
        entry({
          scope: "project",
          name: "package-workflow",
          title: "Package workflow",
          summary: "Use the package directory",
        }),
        entry({
          scope: "global",
          name: "run-package-tests",
          title: "Run package tests",
          summary: "Run package tests from the package directory",
        }),
      ],
      query: "run package tests",
      maxEntries: 2,
      maxChars: 500,
    })

    expect(selected.map((item) => item.name)).toEqual(["run-package-tests", "package-workflow"])
  })

  test("prefers project memory when relevance is tied", () => {
    const selected = MemoryContext.select({
      entries: [
        entry({ scope: "global", name: "global-tests", title: "Tests", summary: "Run focused tests" }),
        entry({ scope: "project", name: "project-tests", title: "Tests", summary: "Run focused tests" }),
      ],
      query: "focused tests",
      maxEntries: 2,
      maxChars: 500,
    })

    expect(selected.map((item) => item.name)).toEqual(["project-tests", "global-tests"])
  })

  test("keeps index entries within the character budget", () => {
    const selected = MemoryContext.select({
      entries: [
        entry({ scope: "project", name: "short", title: "Short", summary: "Useful memory" }),
        entry({ scope: "project", name: "long", title: "Long", summary: "x".repeat(300) }),
      ],
      query: "useful",
      maxEntries: 8,
      maxChars: 300,
    })

    expect(selected.map((item) => item.name)).toEqual(["short"])
    expect(MemoryContext.format(selected).length).toBeLessThanOrEqual(300)
  })

  test("formats summaries without detail content", () => {
    const block = MemoryContext.format([
      entry({
        scope: "project",
        name: "run-package-tests",
        title: "Run package tests",
        summary: "Run tests from the package directory",
      }),
    ])

    expect(block).toContain("<wanlaicode-memory-index>")
    expect(block).toContain("[project/run-package-tests]")
    expect(block).toContain("memory_read")
    expect(block).not.toContain("<wanlaicode-memory>")
  })
})
