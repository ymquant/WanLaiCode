import { describe, expect, test } from "bun:test"
import { isPrivateOrLoopbackHost, isPublicHttpUrl } from "./safe-http-url"

describe("safe-http-url", () => {
  test("isPrivateOrLoopbackHost blocks dotted and decimal ipv4 literals", () => {
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true)
    expect(isPrivateOrLoopbackHost("2130706433")).toBe(true)
    expect(isPrivateOrLoopbackHost("3232235521")).toBe(true)
    expect(isPrivateOrLoopbackHost("api.binance.com")).toBe(false)
  })

  test("isPrivateOrLoopbackHost blocks ipv4-mapped ipv6 addresses", () => {
    expect(isPrivateOrLoopbackHost("::ffff:7f00:1")).toBe(true)
    expect(isPrivateOrLoopbackHost("::ffff:127.0.0.1")).toBe(true)
    expect(isPrivateOrLoopbackHost("0:0:0:0:0:ffff:127.0.0.1")).toBe(true)
    expect(isPrivateOrLoopbackHost("::ffff:8efa:4ec4")).toBe(false)
  })

  test("isPublicHttpUrl allows public http(s) and blocks private hosts", () => {
    expect(isPublicHttpUrl("https://github.com/o/r/pull/1")).toBe(true)
    expect(isPublicHttpUrl("http://2130706433/")).toBe(false)
    expect(isPublicHttpUrl("http://[::ffff:7f00:1]/")).toBe(false)
    expect(isPublicHttpUrl("javascript:alert(1)")).toBe(false)
  })
})
