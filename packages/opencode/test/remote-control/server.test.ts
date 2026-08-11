import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RemoteControlPaths } from "@/server/routes/instance/httpapi/groups/remote-control"
import { ExperimentalHttpApiServer } from "@/server/routes/instance/httpapi/server"
import { Server } from "@/server/server"

const original = {
  password: Flag.WANLAICODE_SERVER_PASSWORD,
  username: Flag.WANLAICODE_SERVER_USERNAME,
}

function authorization(password: string) {
  return `Basic ${Buffer.from(`wanlaicode:${password}`).toString("base64")}`
}

function app(backend: "hono" | "httpapi", password: string) {
  Flag.WANLAICODE_SERVER_PASSWORD = password
  Flag.WANLAICODE_SERVER_USERNAME = "wanlaicode"
  if (backend === "hono") return Server.Legacy().app

  // Effect HttpApi 测试显式注入同一 sidecar 密码，确保两套服务后端执行一致的授权边界。
  const handler = HttpRouter.toWebHandler(
    ExperimentalHttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: password,
            OPENCODE_SERVER_USERNAME: "wanlaicode",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    fetch: (request: Request) => handler(request, ExperimentalHttpApiServer.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

afterEach(() => {
  Flag.WANLAICODE_SERVER_PASSWORD = original.password
  Flag.WANLAICODE_SERVER_USERNAME = original.username
})

describe("remote-control local management authorization", () => {
  for (const backend of ["hono", "httpapi"] as const) {
    test(`${backend} 要求本地 sidecar 凭证且不返回长期令牌`, async () => {
      const server = app(backend, "secret")
      const missing = await server.request(RemoteControlPaths.status)
      const authorized = await server.request(RemoteControlPaths.status, {
        headers: { authorization: authorization("secret") },
      })

      expect(missing.status).toBe(401)
      expect(authorized.status).toBe(200)
      const body = await authorized.text()
      expect(body).not.toContain("device_token")
      expect(body).not.toContain("softwareToken")
      expect(body).not.toContain("oauth")
    })
  }
})
