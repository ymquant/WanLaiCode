import { describe, test, expect } from "bun:test"
import { Hono } from "hono"
import { ErrorMiddleware } from "../../src/server/middleware"

describe("ErrorMiddleware", () => {
  test("unhandled error 不泄漏 stack / 文件路径，归到 INTERNAL_ERROR", async () => {
    const app = new Hono()
    app.onError(ErrorMiddleware)
    app.get("/boom", () => {
      const err = new Error("kaboom")
      err.stack = "Error: kaboom\n  at /Users/developer/app.asar/out/main/chunks/node-DO4OQJ46.js:1:1"
      throw err
    })

    const res = await app.request("/boom")
    expect(res.status).toBe(500)
    const body = await res.json()
    const text = JSON.stringify(body)
    expect(text).not.toContain("app.asar")
    expect(text).not.toContain(".js:")
    expect(text).not.toContain("kaboom")
    expect(body?.data?.reason).toBe("INTERNAL_ERROR")
  })
})
