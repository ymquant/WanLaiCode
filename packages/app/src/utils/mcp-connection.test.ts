import { describe, expect, test } from "bun:test"
import type { McpStatus, OpencodeClient } from "@opencode-ai/sdk/v2"
import { authenticateMcp, toggleMcpConnection } from "./mcp-connection"

function mcpClient(next: McpStatus, authenticated: McpStatus = { status: "connected" }) {
  const events: string[] = []
  const client = {
    mcp: {
      connect: async () => {
        events.push("connect")
        return { data: true }
      },
      disconnect: async () => {
        events.push("disconnect")
        return { data: true }
      },
      status: async () => {
        events.push("status")
        return { data: { cloudflare: next } }
      },
      auth: {
        remove: async () => {
          events.push("remove-auth")
          return { data: { success: true } }
        },
        authenticate: async () => {
          events.push("authenticate")
          return { data: authenticated }
        },
      },
    },
  } as unknown as OpencodeClient
  return { client, events }
}

describe("toggleMcpConnection", () => {
  test("断开已连接的 MCP，不启动授权", async () => {
    const fixture = mcpClient({ status: "connected" })

    expect(await toggleMcpConnection(fixture.client, "cloudflare", "connected")).toEqual({ status: "disabled" })
    expect(fixture.events).toEqual(["disconnect"])
  })

  test("普通连接成功后不启动授权", async () => {
    const fixture = mcpClient({ status: "connected", supports_oauth: true })

    expect(await toggleMcpConnection(fixture.client, "cloudflare", "disabled")).toEqual({
      status: "connected",
      supports_oauth: true,
    })
    expect(fixture.events).toEqual(["connect", "status"])
  })

  test("连接后需要 OAuth 时自动启动授权", async () => {
    const fixture = mcpClient(
      { status: "needs_auth", supports_oauth: true },
      { status: "connected", supports_oauth: true },
    )

    expect(await toggleMcpConnection(fixture.client, "cloudflare", "disabled")).toEqual({
      status: "connected",
      supports_oauth: true,
    })
    expect(fixture.events).toEqual(["connect", "status", "authenticate"])
  })

  test("服务不支持 OAuth 时不启动授权", async () => {
    const fixture = mcpClient({ status: "needs_auth", supports_oauth: false })

    expect(await toggleMcpConnection(fixture.client, "cloudflare", "disabled")).toEqual({
      status: "needs_auth",
      supports_oauth: false,
    })
    expect(fixture.events).toEqual(["connect", "status"])
  })
})

describe("authenticateMcp", () => {
  test("首次授权直接启动 OAuth", async () => {
    const fixture = mcpClient({ status: "needs_auth", supports_oauth: true })

    await authenticateMcp(fixture.client, "cloudflare", false)

    expect(fixture.events).toEqual(["authenticate"])
  })

  test("重新授权先删除旧凭据再启动 OAuth", async () => {
    const fixture = mcpClient({ status: "connected", supports_oauth: true })

    await authenticateMcp(fixture.client, "cloudflare", true)

    expect(fixture.events).toEqual(["remove-auth", "authenticate"])
  })
})
