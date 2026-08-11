import { describe, expect, test } from "bun:test"
import { createRegistryClient, RegistryError } from "../src/registry/client"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("registry client", () => {
  test("listPlugins 解开成功信封并带 Bearer + locale", async () => {
    let captured: { url: string; auth: string | null } | undefined
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      token: "tok123",
      fetchImpl: async (input, init) => {
        captured = {
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
        }
        return jsonResponse({
          code: 0,
          message: "ok",
          data: { items: [{ namespace: "alice", slug: "demo" }], total: 1 },
        })
      },
    })
    const page = await client.listPlugins({ q: "demo", page: 1, locale: "zh-CN" })
    expect(captured!.url).toContain("/api/v1/plugins")
    expect(captured!.url).toContain("q=demo")
    expect(captured!.url).toContain("locale=zh-CN")
    expect(captured!.auth).toBe("Bearer tok123")
    expect(page.items[0]!.slug).toBe("demo")
  })

  test("非成功 code 抛 RegistryError 带 code/message", async () => {
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      fetchImpl: async () => jsonResponse({ code: 1001, message: "namespace taken", data: null }, 409),
    })
    await expect(client.me()).rejects.toMatchObject({ name: "RegistryError", code: 1001, status: 409 })
  })

  test("匿名请求不带 Authorization 头", async () => {
    let auth: string | null = "unset"
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      fetchImpl: async (_i, init) => {
        auth = new Headers(init?.headers).get("authorization")
        return jsonResponse({ code: 0, message: "ok", data: { items: [], total: 0 } })
      },
    })
    await client.listPlugins({})
    expect(auth).toBeNull()
  })

  test("postComment 请求体字段名为 content 而非 body", async () => {
    let parsed: unknown
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      token: "tok",
      fetchImpl: async (_i, init) => {
        parsed = JSON.parse(init?.body as string)
        return jsonResponse({
          code: 0,
          message: "ok",
          data: { id: "c1", author_uuid: "u1", username: "alice", content: "hi", created_at: "", updated_at: "" },
        })
      },
    })
    await client.postComment("alice", "demo", "hi")
    expect(parsed).toEqual({ content: "hi" })
  })

  test("putRating 请求体字段名为 rating 而非 value", async () => {
    let parsed: unknown
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      token: "tok",
      fetchImpl: async (_i, init) => {
        parsed = JSON.parse(init?.body as string)
        return jsonResponse({
          code: 0,
          message: "ok",
          data: { rating: 5, created_at: "", updated_at: "" },
        })
      },
    })
    await client.putRating("alice", "demo", 5)
    expect(parsed).toEqual({ rating: 5 })
  })

  test("createNamespace posts name with Bearer token", async () => {
    let captured: { url: string; method: string | undefined; auth: string | null; body: unknown } | undefined
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      token: "tok",
      fetchImpl: async (input, init) => {
        captured = {
          url: String(input),
          method: init?.method,
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(init?.body as string),
        }
        return jsonResponse({ code: 0, message: "ok", data: { namespace: "alice" } }, 201)
      },
    })

    const result = await client.createNamespace("alice")

    expect(result).toEqual({ namespace: "alice" })
    expect(captured).toEqual({
      url: "http://host:8080/api/v1/namespaces",
      method: "POST",
      auth: "Bearer tok",
      body: { name: "alice" },
    })
  })

  test("publishPlugin sends multipart tarball with Bearer token", async () => {
    let captured: { url: string; auth: string | null; fileName: string; fileText: string } | undefined
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      token: "tok",
      fetchImpl: async (input, init) => {
        const form = await new Request(input, init).formData()
        const file = form.get("file")
        if (!(file instanceof File)) throw new Error("missing upload file")
        captured = {
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          fileName: file.name,
          fileText: await file.text(),
        }
        return jsonResponse({ code: 0, message: "ok", data: { namespace: "alice", slug: "demo", version: "1.0.0" } })
      },
    })

    await client.publishPlugin({
      namespace: "alice",
      slug: "demo",
      file: new Blob(["tarball-bytes"]),
      filename: "demo-1.0.0.tgz",
    })

    expect(captured).toEqual({
      url: "http://host:8080/api/v1/plugins/alice/demo/versions",
      auth: "Bearer tok",
      fileName: "demo-1.0.0.tgz",
      fileText: "tarball-bytes",
    })
  })

  test("deleteVersion sends DELETE to the version endpoint with Bearer token", async () => {
    let captured: { url: string; method: string | undefined; auth: string | null } | undefined
    const client = createRegistryClient({
      baseUrl: "http://host:8080",
      token: "tok",
      fetchImpl: async (input, init) => {
        captured = {
          url: String(input),
          method: init?.method,
          auth: new Headers(init?.headers).get("authorization"),
        }
        return jsonResponse({ code: 0, message: "ok", data: null })
      },
    })

    await client.deleteVersion("alice", "demo", "1.0.0")

    expect(captured).toEqual({
      url: "http://host:8080/api/v1/plugins/alice/demo/versions/1.0.0",
      method: "DELETE",
      auth: "Bearer tok",
    })
  })
})
