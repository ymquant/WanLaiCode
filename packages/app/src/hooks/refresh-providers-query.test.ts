import { describe, expect, test } from "bun:test"
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { resolveRefreshedProviderList } from "./refresh-providers-query"

const empty = {
  connected: [],
  default: {},
  all: [{ id: "p", name: "P", env: [], models: {} }],
} as unknown as ProviderListResponse

const withModels = {
  connected: ["p"],
  default: {},
  all: [{ id: "p", name: "P", env: [], models: { m: { id: "m", name: "M", status: "stable" } } }],
} as unknown as ProviderListResponse

describe("resolveRefreshedProviderList", () => {
  test("marks fresh when API response has models", () => {
    const result = resolveRefreshedProviderList({ next: withModels })
    expect(result.fresh).toBe(true)
    expect(result.data).toBe(withModels)
  })

  test("marks stale when API response is empty but cache has models", () => {
    const result = resolveRefreshedProviderList({ next: empty, previous: withModels })
    expect(result.fresh).toBe(false)
    expect(result.data).toBe(withModels)
  })

  test("marks fresh when API response is empty and no cache exists", () => {
    const result = resolveRefreshedProviderList({ next: empty })
    expect(result.fresh).toBe(true)
    expect(result.data).toBe(empty)
  })
})
