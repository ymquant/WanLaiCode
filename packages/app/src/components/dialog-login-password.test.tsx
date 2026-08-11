import { describe, expect, test } from "bun:test"

describe("WanlaiCode password login dialog", () => {
  test("calls generated user-center login endpoint and signals onSuccess", async () => {
    const source = await Bun.file(new URL("./dialog-login-password.tsx", import.meta.url)).text()

    expect(source).toContain("globalSDK.client.wanlaicodeUserCenter.login")
    expect(source).toContain("onSuccess")
    expect(source).toContain("email: form.email.trim()")
    expect(source).toContain("password: form.password")
    expect(source).not.toContain('new URL("/auth/login", current.http.url)')
  })
})
