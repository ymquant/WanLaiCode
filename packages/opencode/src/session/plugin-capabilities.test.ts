import { describe, expect, test } from "bun:test"
import type { LoadedAddon } from "@opencode-ai/addon"
import { buildCapabilityText, parsePluginMentions, renderPluginCapabilities } from "./plugin-capabilities"

describe("parsePluginMentions", () => {
  test("无 mention 返回空", () => {
    expect(parsePluginMentions("普通文本 没有插件")).toEqual([])
  })

  test("提取单个 plugin mention 的 addonKey", () => {
    expect(parsePluginMentions("[@hyperframes](plugin://hyperframes@openai-curated) 干啥")).toEqual([
      "hyperframes@openai-curated",
    ])
  })

  test("多个 mention 按出现顺序、去重", () => {
    const text =
      "[@a](plugin://a@m) 和 [@b](plugin://b@m) 再 [@a](plugin://a@m)"
    expect(parsePluginMentions(text)).toEqual(["a@m", "b@m"])
  })

  test("忽略非 plugin:// 链接", () => {
    expect(parsePluginMentions("[x](https://example.com) [@a](plugin://a@m)")).toEqual(["a@m"])
  })

  test("裸 (plugin://x) 无 [@..] 前缀不再命中(收紧)", () => {
    expect(parsePluginMentions("see (plugin://a@m) here")).toEqual([])
  })

  test("错 sigil [x](plugin://...) 不命中", () => {
    expect(parsePluginMentions("[x](plugin://a@m)")).toEqual([])
  })
})

function makeAddon(
  over: Partial<Omit<LoadedAddon, "manifest">> & { manifest?: Partial<LoadedAddon["manifest"]> } = {},
): LoadedAddon {
  const { manifest, ...rest } = over
  return {
    root: "/tmp/x",
    addonId: { addonName: "hyperframes", marketplaceName: "openai-curated" },
    ...rest,
    manifest: { name: "hyperframes", paths: {}, ...manifest },
  } as LoadedAddon
}

describe("renderPluginCapabilities", () => {
  test("字段齐全：含 display name / 描述 / skill 前缀 / MCP / defaultPrompt", () => {
    const out = renderPluginCapabilities(
      makeAddon({
        skills: [{ name: "make-video" } as any],
        mcpServers: { hf: {} as any },
        manifest: {
          name: "hyperframes",
          paths: {},
          interfaceInfo: {
            displayName: "HyperFrames by HeyGen",
            longDescription: "Generate interactive frames.",
            defaultPrompt: ["做个开场动画", "加字幕"],
          },
        },
      }),
    )
    expect(out).toContain("Capabilities from the `HyperFrames by HeyGen` plugin:")
    expect(out).toContain("Generate interactive frames.")
    expect(out).toContain("Skills from this plugin are prefixed with `hyperframes:`.")
    expect(out).toContain("MCP servers this plugin provides: `hf`.")
    expect(out).toContain("Suggested prompts: 做个开场动画; 加字幕")
    expect(out).toContain("Use these plugin-associated capabilities")
  })

  test("displayName 缺省回退到 manifest.name", () => {
    const out = renderPluginCapabilities(makeAddon({ manifest: { name: "hyperframes", paths: {} } }))
    expect(out).toContain("Capabilities from the `hyperframes` plugin:")
  })

  test("无 skills / 无 MCP / 无 defaultPrompt：省略对应行，保留首尾身份行", () => {
    const out = renderPluginCapabilities(makeAddon({ manifest: { name: "hyperframes", paths: {} } }))
    expect(out).not.toContain("Skills from this plugin")
    expect(out).not.toContain("MCP servers this plugin provides")
    expect(out).not.toContain("Suggested prompts:")
    expect(out).toContain("Capabilities from the `hyperframes` plugin:")
    expect(out).toContain("Use these plugin-associated capabilities")
  })

  test("仅 skills：渲染 skills 行，省略 MCP / defaultPrompt 行", () => {
    const out = renderPluginCapabilities(
      makeAddon({ skills: [{ name: "make-video" } as any], manifest: { name: "hyperframes", paths: {} } }),
    )
    expect(out).toContain("Skills from this plugin are prefixed with `hyperframes:`.")
    expect(out).not.toContain("MCP servers this plugin provides")
    expect(out).not.toContain("Suggested prompts:")
  })

  test("registry skills use namespace-aware prefix", () => {
    const out = renderPluginCapabilities(
      makeAddon({
        addonId: { addonName: "hyperframes", marketplaceName: "wanlaicode", registryNamespace: "alice" },
        skills: [{ name: "make-video" } as any],
        manifest: { name: "hyperframes", paths: {} },
      }),
    )
    expect(out).toContain("Skills from this plugin are prefixed with `alice/hyperframes:`.")
  })

  test("始终包含「依赖缺失时询问用户是否代为安装」指引", () => {
    const minimal = renderPluginCapabilities(makeAddon({ manifest: { name: "hyperframes", paths: {} } }))
    expect(minimal).toContain("ask whether they would like you to install it")
    const full = renderPluginCapabilities(
      makeAddon({
        skills: [{ name: "make-video" } as any],
        manifest: { name: "hyperframes", paths: {} },
      }),
    )
    expect(full).toContain("ask whether they would like you to install it")
  })

  test("仅 MCP：渲染 MCP 行，省略 skills / defaultPrompt 行", () => {
    const out = renderPluginCapabilities(
      makeAddon({ mcpServers: { hf: {} as any }, manifest: { name: "hyperframes", paths: {} } }),
    )
    expect(out).toContain("MCP servers this plugin provides: `hf`.")
    expect(out).not.toContain("Skills from this plugin")
    expect(out).not.toContain("Suggested prompts:")
  })
})

describe("buildCapabilityText", () => {
  const addons = [
    makeAddon({
      addonId: { addonName: "hyperframes", marketplaceName: "openai-curated" },
      manifest: { name: "hyperframes", paths: {}, interfaceInfo: { displayName: "HyperFrames" } },
    }),
    makeAddon({
      addonId: { addonName: "browser", marketplaceName: "openai-curated" },
      disabled: true,
      manifest: { name: "browser", paths: {} },
    }),
  ]

  test("命中已启用插件：产出能力块", () => {
    const out = buildCapabilityText(["hyperframes@openai-curated"], addons)
    expect(out).toContain("Capabilities from the `HyperFrames` plugin:")
  })

  test("无 mention（空 keys）：返回 null", () => {
    expect(buildCapabilityText([], addons)).toBeNull()
  })

  test("被 @ 的插件 disabled：跳过、返回 null", () => {
    expect(buildCapabilityText(["browser@openai-curated"], addons)).toBeNull()
  })

  test("被 @ 的插件未安装：跳过、返回 null", () => {
    expect(buildCapabilityText(["ghost@openai-curated"], addons)).toBeNull()
  })

  test("命中多个插件：能力块按 \\n\\n 拼接", () => {
    const multi = [
      makeAddon({
        addonId: { addonName: "hyperframes", marketplaceName: "openai-curated" },
        manifest: { name: "hyperframes", paths: {}, interfaceInfo: { displayName: "HyperFrames" } },
      }),
      makeAddon({
        addonId: { addonName: "docs", marketplaceName: "openai-curated" },
        manifest: { name: "docs", paths: {}, interfaceInfo: { displayName: "Documents" } },
      }),
    ]
    const out = buildCapabilityText(["hyperframes@openai-curated", "docs@openai-curated"], multi)
    expect(out).toContain("Capabilities from the `HyperFrames` plugin:")
    expect(out).toContain("Capabilities from the `Documents` plugin:")
    expect(out).toContain("\n\n")
  })

  test("registry mention key can match the unique loaded addon when namespace shape differs", () => {
    const out = buildCapabilityText(
      ["remotion@wanlaicode"],
      [
        makeAddon({
          addonId: { addonName: "remotion", marketplaceName: "wanlaicode", registryNamespace: "wanlaicode" },
          manifest: { name: "remotion", paths: {}, interfaceInfo: { displayName: "Remotion" } },
        }),
      ],
    )
    expect(out).toContain("Capabilities from the `Remotion` plugin:")
  })

  test("registry mention key does not fallback-match ambiguous loaded addons", () => {
    const out = buildCapabilityText(
      ["remotion@wanlaicode"],
      [
        makeAddon({
          addonId: { addonName: "remotion", marketplaceName: "wanlaicode", registryNamespace: "alice" },
          manifest: { name: "remotion", paths: {}, interfaceInfo: { displayName: "Alice Remotion" } },
        }),
        makeAddon({
          addonId: { addonName: "remotion", marketplaceName: "wanlaicode", registryNamespace: "bob" },
          manifest: { name: "remotion", paths: {}, interfaceInfo: { displayName: "Bob Remotion" } },
        }),
      ],
    )
    expect(out).toBeNull()
  })
})
