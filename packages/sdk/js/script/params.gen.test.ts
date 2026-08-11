import { describe, expect, test } from "bun:test"
import { buildClientParams } from "./params.gen.js"

describe("buildClientParams", () => {
  test("keeps empty mapped body objects for optional POST payloads", () => {
    const params = buildClientParams([{ vcsPushInput: {} }], [
      {
        args: [{ key: "vcsPushInput", map: "body" }],
      },
    ])
    expect(params.body).toEqual({})
  })

  test("drops unmapped empty body objects", () => {
    const params = buildClientParams([{ directory: "/tmp" }], [
      {
        args: [{ in: "query", key: "directory" }],
      },
    ])
    expect(params.body).toBeUndefined()
  })
})
