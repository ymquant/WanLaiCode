import { describe, expect, test } from "bun:test"
import { formatServerError } from "@/utils/server-errors"
import { createEmptyMcpDraft } from "./mcp-editor-form"
import { MCP_DRAFT_ERROR_KEYS, saveMcpDraft } from "./mcp-editor-actions"

describe("MCP editor save actions", () => {
  test("does not build or submit a payload when field validation fails", async () => {
    const draft = createEmptyMcpDraft("remote")
    draft.name = "demo"
    draft.url = "https://mcp.example.com/mcp"
    draft.headers = [{ key: "Authorization", value: "Bearer plaintext" }]
    const calls: unknown[] = []

    const result = await saveMcpDraft(draft, undefined, async (input) => {
      calls.push(input)
    })

    expect(result.errors).toEqual({
      "headers.0.key": "authorization_conflict",
    })
    expect(calls).toEqual([])
  })

  test("lets backend save errors bubble for formatServerError instead of treating them as field codes", async () => {
    const draft = createEmptyMcpDraft("local")
    draft.name = "demo"
    draft.command = "npx"
    const errors = [
      { code: "key_duplicate", error: "MCP configuration keys must be unique" },
      { code: "row_incomplete", error: "MCP configuration row is incomplete" },
    ]

    await Promise.all(
      errors.map(async (backendError) => {
        await expect(
          saveMcpDraft(draft, undefined, async () => {
            throw backendError
          }),
        ).rejects.toBe(backendError)
        expect(formatServerError(backendError)).toBe(backendError.error)
      }),
    )
  })

  test("maps every stable draft error to an i18n message key", () => {
    expect(MCP_DRAFT_ERROR_KEYS).toEqual({
      name_required: "mcp.editor.error.name_required",
      name_invalid: "mcp.editor.error.name_invalid",
      command_required: "mcp.editor.error.command_required",
      url_invalid: "mcp.editor.error.url_invalid",
      env_invalid: "mcp.editor.error.env_invalid",
      key_required: "mcp.editor.error.key_required",
      value_required: "mcp.editor.error.value_required",
      duplicate_key: "mcp.editor.error.duplicate_key",
      authorization_conflict: "mcp.editor.error.authorization_conflict",
      redirect_uri_invalid: "mcp.editor.error.redirect_uri_invalid",
      timeout_invalid: "mcp.editor.error.timeout_invalid",
    })
  })
})
