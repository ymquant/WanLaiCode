import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { SessionID } from "../../src/session/schema"
import {
  MemoryCreatePayload,
  MemoryListQuery,
  MemoryPaths,
  MemoryUpdatePayload,
} from "../../src/server/routes/instance/httpapi/groups/memory"

describe("memory HttpApi contract", () => {
  test("does not expose the app project ID in memory queries", () => {
    expect(Object.keys(MemoryListQuery.fields)).toEqual(["scope", "search", "limit"])
  })

  test("exposes separate index and detail endpoints", () => {
    expect(MemoryPaths.list).toBe("/memory")
    expect(MemoryPaths.get).toBe("/memory/:memoryID")
    expect(MemoryPaths.update).toBe("/memory/:memoryID")
  })

  test("requires session-backed processing for create and a complete document for update", () => {
    expect(
      Schema.decodeUnknownSync(MemoryCreatePayload)({
        scope: "project",
        content: "remember this",
        sessionID: "ses_123",
      }),
    ).toEqual({ scope: "project", content: "remember this", sessionID: SessionID.descending("ses_123") })
    expect(() => Schema.decodeUnknownSync(MemoryCreatePayload)({ scope: "project", content: "remember this" })).toThrow()
    expect(Schema.decodeUnknownSync(MemoryUpdatePayload)({ document: "# Title\n\n> Summary\n\nDetail\n" })).toEqual({
      document: "# Title\n\n> Summary\n\nDetail\n",
    })
  })

  test("keeps memory config global and guards processed creation", async () => {
    const handler = await Bun.file(
      new URL("../../src/server/routes/instance/httpapi/handlers/memory.ts", import.meta.url),
    ).text()

    expect(handler).toContain("config.getGlobal()")
    expect(handler).toContain("config.updateGlobal(")
    expect(handler).not.toContain("config.update(updated)")
    expect(handler).toContain('mode === "off" || mode === "read_only"')
  })
})
