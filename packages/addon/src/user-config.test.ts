import { describe, expect, test } from "bun:test"
import {
  addonEnabled,
  addonOverride,
  applyMcpOverrides,
  clearAddon,
  disabledSkillNames,
  addonKey,
  addonIdEquals,
  addonSkillName,
  addonSkillPrefix,
  InvalidAddonKeyError,
  isAddonEnabled,
  isSkillEnabled,
  parseAddonKey,
  setAddonEnabled,
  setMcpEnabled,
  setSkillEnabled,
} from "./user-config"

describe("addonEnabled", () => {
  test("enabled is true unless addon.enabled is explicitly false", () => {
    expect(addonEnabled({})).toBe(true)
    expect(addonEnabled({ addon: { enabled: true } })).toBe(true)
    expect(addonEnabled({ addon: { enabled: false } })).toBe(false)
  })
})

describe("addonOverride", () => {
  test("finds addon overrides by <addon>@<market>", () => {
    expect(
      addonOverride(
        {
          plugins: {
            "github@openai": { enabled: false },
          },
        },
        { addonName: "github", marketplaceName: "openai" },
      ),
    ).toEqual({ enabled: false })
  })
})

describe("isAddonEnabled", () => {
  test("enabled is false only when the addon override disables it", () => {
    expect(isAddonEnabled({}, { addonName: "github", marketplaceName: "openai" })).toBe(true)
    expect(
      isAddonEnabled(
        { plugins: { "github@openai": { enabled: true } } },
        { addonName: "github", marketplaceName: "openai" },
      ),
    ).toBe(true)
    expect(
      isAddonEnabled(
        { plugins: { "github@openai": { enabled: false } } },
        { addonName: "github", marketplaceName: "openai" },
      ),
    ).toBe(false)
  })
})

describe("parseAddonKey", () => {
  test("parses <addon>@<market>", () => {
    expect(parseAddonKey("hello@curated")).toEqual({
      addonName: "hello",
      marketplaceName: "curated",
    })
  })

  test("parses registry namespace suffix", () => {
    expect(addonKey({ addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" })).toBe(
      "hello@wanlaicode/alice",
    )
    expect(parseAddonKey("hello@wanlaicode/alice")).toEqual({
      addonName: "hello",
      marketplaceName: "wanlaicode",
      registryNamespace: "alice",
    })
  })

  test("compares registry namespace as part of addon identity", () => {
    expect(
      addonIdEquals(
        { addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" },
        { addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" },
      ),
    ).toBe(true)
    expect(
      addonIdEquals(
        { addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" },
        { addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "bob" },
      ),
    ).toBe(false)
  })

  test("builds namespace-aware addon skill names", () => {
    expect(addonSkillPrefix({ addonName: "hello", marketplaceName: "curated" })).toBe("hello")
    expect(addonSkillName({ addonName: "hello", marketplaceName: "curated" }, "write")).toBe("hello:write")
    expect(addonSkillPrefix({ addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" })).toBe(
      "alice/hello",
    )
    expect(addonSkillName({ addonName: "hello", marketplaceName: "wanlaicode", registryNamespace: "alice" }, "write")).toBe(
      "alice/hello:write",
    )
  })

  test("rejects missing @", () => {
    expect(() => parseAddonKey("hello")).toThrow(InvalidAddonKeyError)
  })

  test("rejects empty halves", () => {
    expect(() => parseAddonKey("@curated")).toThrow(InvalidAddonKeyError)
    expect(() => parseAddonKey("hello@")).toThrow(InvalidAddonKeyError)
  })

  test("rejects path-traversal and invalid characters in either half", () => {
    expect(() => parseAddonKey("..@curated")).toThrow(InvalidAddonKeyError)
    expect(() => parseAddonKey("hello@..")).toThrow(InvalidAddonKeyError)
    expect(() => parseAddonKey("hello/world@curated")).toThrow(InvalidAddonKeyError)
    expect(() => parseAddonKey("hello@curated/alice/bob")).toThrow(InvalidAddonKeyError)
    expect(() => parseAddonKey("hello@curated/..")).toThrow(InvalidAddonKeyError)
  })
})

describe("setAddonEnabled / clearAddon", () => {
  test("setAddonEnabled returns a deep-merge patch keeping other addons", () => {
    expect(setAddonEnabled({ addonName: "hello", marketplaceName: "curated" }, true)).toEqual({
      plugins: { "hello@curated": { enabled: true } },
    })
  })

  test("clearAddon emits a per-key delete patch", () => {
    expect(clearAddon({ addonName: "hello", marketplaceName: "curated" })).toEqual({
      plugins: { "hello@curated": undefined },
    })
  })
})

describe("disabledSkillNames / isSkillEnabled", () => {
  test("returns empty list when no override is set", () => {
    expect(disabledSkillNames({}, { addonName: "h", marketplaceName: "m" })).toEqual([])
    expect(isSkillEnabled({}, { addonName: "h", marketplaceName: "m" }, "x")).toBe(true)
  })

  test("respects disabled_skills override", () => {
    const cfg = {
      plugins: { "h@m": { disabled_skills: ["x"] } },
    }
    expect(disabledSkillNames(cfg, { addonName: "h", marketplaceName: "m" })).toEqual(["x"])
    expect(isSkillEnabled(cfg, { addonName: "h", marketplaceName: "m" }, "x")).toBe(false)
    expect(isSkillEnabled(cfg, { addonName: "h", marketplaceName: "m" }, "y")).toBe(true)
  })
})

describe("setSkillEnabled", () => {
  test("adds skill to disabled_skills when enabled=false", () => {
    expect(
      setSkillEnabled({ addonName: "h", marketplaceName: "m" }, "x", false),
    ).toEqual({
      plugins: { "h@m": { disabled_skills: ["x"] } },
    })
  })

  test("removes skill from existing disabled_skills when enabled=true", () => {
    expect(
      setSkillEnabled({ addonName: "h", marketplaceName: "m" }, "x", true, {
        disabled_skills: ["x", "y"],
      }),
    ).toEqual({
      plugins: { "h@m": { disabled_skills: ["y"] } },
    })
  })

  test("deduplicates when re-disabling an already-disabled skill", () => {
    expect(
      setSkillEnabled({ addonName: "h", marketplaceName: "m" }, "x", false, {
        disabled_skills: ["x"],
      }),
    ).toEqual({
      plugins: { "h@m": { disabled_skills: ["x"] } },
    })
  })
})

describe("setMcpEnabled", () => {
  test("returns a narrow deep-merge patch for one MCP", () => {
    expect(
      setMcpEnabled(
        { addonName: "demo", marketplaceName: "personal" },
        "search",
        false,
      ),
    ).toEqual({
      plugins: {
        "demo@personal": {
          mcp_servers: {
            search: { enabled: false },
          },
        },
      },
    })
  })
})

describe("applyMcpOverrides", () => {
  test("applies server enabled and tool approval overrides", () => {
    expect(
      applyMcpOverrides(
        {
          type: "local",
          command: ["node"],
          enabled_tools: ["search"],
          tools: {
            search: { approval: "prompt" },
          },
        } as {
          type: "local"
          command: string[]
          enabled?: boolean
          default_tools_approval_mode?: "auto" | "prompt" | "approve"
          enabled_tools: string[]
          disabled_tools?: string[]
          tools: Record<string, { approval?: "auto" | "prompt" | "approve" }>
        },
        {
          enabled: false,
          default_tools_approval_mode: "auto",
          enabled_tools: ["read"],
          disabled_tools: ["write"],
          tools: {
            search: { approval: "approve" },
            read: { approval: "prompt" },
          },
        },
      ),
    ).toEqual({
      type: "local",
      command: ["node"],
      enabled: false,
      default_tools_approval_mode: "auto",
      enabled_tools: ["read"],
      disabled_tools: ["write"],
      tools: {
        search: { approval: "approve" },
        read: { approval: "prompt" },
      },
    })
  })
})
