import { describe, expect, test } from "bun:test"
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import {
  agentsQueryKeyMatches,
  directoryKey,
  isIgnorableReloadError,
  normalizeAgentList,
  normalizeProviderList,
  providerListWithFallback,
} from "./utils"

const agent = (name = "build") =>
  ({
    name,
    mode: "primary",
    permission: {},
    options: {},
  }) as Agent

describe("normalizeAgentList", () => {
  test("keeps array payloads", () => {
    expect(normalizeAgentList([agent("build"), agent("docs")])).toEqual([agent("build"), agent("docs")])
  })

  test("wraps a single agent payload", () => {
    expect(normalizeAgentList(agent("docs"))).toEqual([agent("docs")])
  })

  test("extracts agents from keyed objects", () => {
    expect(
      normalizeAgentList({
        build: agent("build"),
        docs: agent("docs"),
      }),
    ).toEqual([agent("build"), agent("docs")])
  })

  test("drops invalid payloads", () => {
    expect(normalizeAgentList({ name: "AbortError" })).toEqual([])
    expect(normalizeAgentList([{ name: "build" }, agent("docs")])).toEqual([agent("docs")])
  })
})

describe("normalizeProviderList", () => {
  test("preserves WanlaiCode connection state", () => {
    const input = {
      connected: ["wanlaicode"],
      default: {},
      all: [
        {
          id: "wanlaicode",
          name: "WanlaiCode",
          env: [],
          models: {
            active: { id: "active", name: "Active", status: "stable" },
            deprecated: { id: "deprecated", name: "Deprecated", status: "deprecated" },
          },
        },
      ],
    } as unknown as ProviderListResponse

    const output = normalizeProviderList(input)

    expect(output.connected).toEqual(["wanlaicode"])
    expect(Object.keys(output.all[0]!.models)).toEqual(["active"])
  })

  test("marks WanlaiCode connected when models are available but the connected list is stale", () => {
    const input = {
      connected: [],
      default: {},
      all: [
        {
          id: "wanlaicode",
          name: "WanlaiCode",
          env: [],
          models: {
            "gpt-5.5": { id: "gpt-5.5", name: "GPT 5.5", status: "stable" },
          },
        },
      ],
    } as unknown as ProviderListResponse

    const output = normalizeProviderList(input)

    expect(output.connected).toEqual(["wanlaicode"])
    expect(output.all[0]!.models["gpt-5.5"]).toBeDefined()
  })
})

describe("providerListWithFallback", () => {
  test("uses fresh provider models without reviving removed stale models", () => {
    const previous = {
      connected: ["wanlaicode"],
      default: {},
      all: [
        {
          id: "wanlaicode",
          name: "WanlaiCode",
          env: [],
          models: {
            "gpt-5.5": { id: "gpt-5.5", name: "GPT 5.5", status: "stable" },
            "gpt-image-2": { id: "gpt-image-2", name: "GPT Image 2", status: "stable" },
          },
        },
      ],
    } as unknown as ProviderListResponse
    const current = {
      connected: ["wanlaicode"],
      default: {},
      all: [
        {
          id: "wanlaicode",
          name: "WanlaiCode",
          env: [],
          models: {
            "gpt-5.5": { id: "gpt-5.5", name: "GPT 5.5", status: "stable" },
          },
        },
      ],
    } as unknown as ProviderListResponse

    expect(providerListWithFallback({ current, previous })).toBe(current)
  })

  test("keeps the previous provider list when the next response has no models", () => {
    const previous = {
      connected: ["wanlaicode"],
      default: {},
      all: [
        {
          id: "wanlaicode",
          name: "WanlaiCode",
          env: [],
          models: {
            "wanlai-chat": { id: "wanlai-chat", name: "Wanlai Chat", status: "stable" },
          },
        },
      ],
    } as unknown as ProviderListResponse
    const empty = { connected: [], default: {}, all: [] } as unknown as ProviderListResponse

    expect(providerListWithFallback({ current: empty, previous })).toBe(previous)
  })

  test("uses the global provider list when directory providers fail before a local cache exists", () => {
    const global = {
      connected: ["wanlaicode"],
      default: {},
      all: [
        {
          id: "wanlaicode",
          name: "WanlaiCode",
          env: [],
          models: {
            "wanlai-chat": { id: "wanlai-chat", name: "Wanlai Chat", status: "stable" },
          },
        },
      ],
    } as unknown as ProviderListResponse

    expect(providerListWithFallback({ current: undefined, global })).toBe(global)
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})

describe("isIgnorableReloadError", () => {
  test("ignores aborted and client-closed reload failures", () => {
    expect(isIgnorableReloadError(new DOMException("Aborted", "AbortError"))).toBe(true)
    expect(isIgnorableReloadError(Object.assign(new Error("closed"), { status: 499 }))).toBe(true)
    expect(isIgnorableReloadError(new Error("opencode server GET /provider → 499 unknown: (empty response body)"))).toBe(
      true,
    )
    expect(isIgnorableReloadError(new Error("Upstream said: request was aborted by policy"))).toBe(false)
    expect(isIgnorableReloadError(new Error("Invalid API key"))).toBe(false)
  })
})

describe("agentsQueryKeyMatches", () => {
  const key = directoryKey("C:\\Repos\\demo")

  test("matches raw Windows backslash and trailing-slash forms against normalized directory", () => {
    expect(agentsQueryKeyMatches(["C:\\Repos\\demo", "agents"], key)).toBe(true)
    expect(agentsQueryKeyMatches(["C:/Repos/demo/", "agents"], key)).toBe(true)
    expect(agentsQueryKeyMatches(["C:/Repos/demo", "agents"], key)).toBe(true)
  })

  test("rejects other directories, other query kinds and malformed keys", () => {
    expect(agentsQueryKeyMatches(["C:/Repos/other", "agents"], key)).toBe(false)
    expect(agentsQueryKeyMatches(["C:/Repos/demo", "providers"], key)).toBe(false)
    expect(agentsQueryKeyMatches([null, "agents"], key)).toBe(false)
    expect(agentsQueryKeyMatches(["C:/Repos/demo"], key)).toBe(false)
  })

  test("matches posix paths with trailing slash", () => {
    const posix = directoryKey("/Users/developer/project")
    expect(agentsQueryKeyMatches(["/Users/developer/project/", "agents"], posix)).toBe(true)
  })
})
