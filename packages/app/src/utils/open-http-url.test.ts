import { describe, expect, test } from "bun:test"
import { openHttpUrl } from "./open-http-url"

describe("openHttpUrl", () => {
  test("opens valid http(s) URLs", () => {
    const opened: string[] = []
    openHttpUrl("https://github.com/o/r/pull/1", (url) => opened.push(url))
    expect(opened).toEqual(["https://github.com/o/r/pull/1"])
  })

  test("rejects non-http schemes", () => {
    const opened: string[] = []
    openHttpUrl("javascript:alert(1)", (url) => opened.push(url))
    openHttpUrl("file:///etc/passwd", (url) => opened.push(url))
    expect(opened).toEqual([])
  })

  test("rejects private and loopback hosts", () => {
    const opened: string[] = []
    openHttpUrl("http://127.0.0.1:4096", (url) => opened.push(url))
    openHttpUrl("http://2130706433/", (url) => opened.push(url))
    openHttpUrl("http://[::ffff:7f00:1]/", (url) => opened.push(url))
    expect(opened).toEqual([])
  })
})
