import { describe, expect, test } from "bun:test"
import { consumeOpenFileRequest, requestOpenFile } from "./open-file-request"

describe("open file requests", () => {
  test("consumes each request only once", () => {
    requestOpenFile("b.pdf")
    const request = consumeOpenFileRequest()

    expect(request?.path).toBe("b.pdf")
    expect(consumeOpenFileRequest()).toBeUndefined()
  })
})
