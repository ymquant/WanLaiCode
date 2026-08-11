import type { McpStatus, OpencodeClient } from "@opencode-ai/sdk/v2"

export async function authenticateMcp(
  client: OpencodeClient,
  name: string,
  reauthenticate: boolean,
): Promise<McpStatus | undefined> {
  if (reauthenticate) await client.mcp.auth.remove({ name }, { throwOnError: true })
  return (await client.mcp.auth.authenticate({ name }, { throwOnError: true })).data
}

export async function toggleMcpConnection(
  client: OpencodeClient,
  name: string,
  currentStatus: McpStatus["status"] | undefined,
): Promise<McpStatus | undefined> {
  if (currentStatus === "connected") {
    await client.mcp.disconnect({ name })
    return { status: "disabled" }
  }

  await client.mcp.connect({ name })
  const status = (await client.mcp.status()).data?.[name]
  if (status?.status !== "needs_auth" || status.supports_oauth !== true) return status
  return (await authenticateMcp(client, name, false)) ?? status
}
