import type { McpManagementSaveInput } from "@opencode-ai/sdk/v2"
import {
  draftToSaveInput,
  validateMcpDraft,
  type McpDraft,
  type McpDraftError,
  type McpDraftErrors,
} from "./mcp-editor-form"

export const MCP_DRAFT_ERROR_KEYS = {
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
} as const satisfies Record<McpDraftError, string>

export async function saveMcpDraft(
  draft: McpDraft,
  originalName: string | undefined,
  save: (input: McpManagementSaveInput) => Promise<unknown>,
): Promise<{ errors: McpDraftErrors }> {
  const errors = validateMcpDraft(draft)
  if (Object.keys(errors).length > 0) return { errors }
  await save(draftToSaveInput(draft, originalName))
  return { errors }
}
