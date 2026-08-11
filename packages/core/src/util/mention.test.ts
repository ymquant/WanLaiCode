import { describe, expect, test } from "bun:test"
import {
  MENTION_SCHEMES,
  buildMentionLink,
  buildPluginMention,
  createMentionRegex,
  mentionKindForPath,
  parseMentionLinks,
  parsePluginMentionKeys,
} from "./mention"

describe("mentionKindForPath", () => {
  test("plugin:// → plugin", () => {
    expect(mentionKindForPath("plugin://hyperframes@openai-curated")).toBe("plugin")
  })
  test("未知前缀 → undefined", () => {
    expect(mentionKindForPath("https://example.com")).toBeUndefined()
    expect(mentionKindForPath("file:///x")).toBeUndefined()
  })
})

describe("buildMentionLink / buildPluginMention", () => {
  test("构造 plugin 链接,与旧内联模板字节级一致", () => {
    expect(buildPluginMention("hyperframes", "hyperframes@openai-curated")).toBe(
      "[@hyperframes](plugin://hyperframes@openai-curated)",
    )
    expect(buildMentionLink("plugin", "x", "x@m")).toBe("[@x](plugin://x@m)")
  })
})

describe("parseMentionLinks", () => {
  test("抽取单个链接 + 字段 + 位置", () => {
    const text = "前 [@hyperframes](plugin://hyperframes@openai-curated) 后"
    const links = parseMentionLinks(text)
    expect(links).toHaveLength(1)
    const l = links[0]!
    expect(l.kind).toBe("plugin")
    expect(l.sigil).toBe("@")
    expect(l.label).toBe("hyperframes")
    expect(l.id).toBe("hyperframes@openai-curated")
    expect(text.slice(l.start, l.end)).toBe("[@hyperframes](plugin://hyperframes@openai-curated)")
  })
  test("多个链接按出现顺序", () => {
    const links = parseMentionLinks("[@a](plugin://a@m) x [@b](plugin://b@m)")
    expect(links.map((l) => l.id)).toEqual(["a@m", "b@m"])
  })
  test("错 sigil([x] 而非 [@x])不命中", () => {
    expect(parseMentionLinks("[x](plugin://x@m)")).toEqual([])
  })
  test("裸 (plugin://x) 无 [@..] 前缀不命中(收紧)", () => {
    expect(parseMentionLinks("see (plugin://x@m) here")).toEqual([])
  })
  test("kinds 过滤", () => {
    expect(parseMentionLinks("[@a](plugin://a@m)", ["plugin"]).map((l) => l.id)).toEqual(["a@m"])
    expect(parseMentionLinks("[@a](plugin://a@m)", [])).toEqual([])
  })
  test("未注册 scheme(app://)不命中", () => {
    expect(parseMentionLinks("[@a](app://a)")).toEqual([])
  })
})

describe("parsePluginMentionKeys", () => {
  test("提取、保持顺序、去重", () => {
    expect(
      parsePluginMentionKeys("[@a](plugin://a@m) [@b](plugin://b@m) [@a](plugin://a@m)"),
    ).toEqual(["a@m", "b@m"])
  })
  test("保留 namespace-aware addon key 里的 slash", () => {
    expect(parsePluginMentionKeys("[@demo](plugin://demo@wanlaicode/alice)")).toEqual(["demo@wanlaicode/alice"])
  })
  test("无 mention → []", () => {
    expect(parsePluginMentionKeys("普通文本 没有插件")).toEqual([])
  })
  test("裸 (plugin://x) → [](收紧)", () => {
    expect(parsePluginMentionKeys("(plugin://x@m)")).toEqual([])
  })
  test("错 sigil → []", () => {
    expect(parsePluginMentionKeys("[x](plugin://x@m)")).toEqual([])
  })
  test("忽略非 plugin 链接", () => {
    expect(parsePluginMentionKeys("[x](https://example.com) [@a](plugin://a@m)")).toEqual(["a@m"])
  })
})

describe("MENTION_SCHEMES", () => {
  test("plugin 已登记", () => {
    expect(MENTION_SCHEMES.plugin).toEqual({ prefix: "plugin://", sigil: "@" })
  })
})

describe("createMentionRegex", () => {
  test("每次返回全局正则的新实例,lastIndex 归零", () => {
    const a = createMentionRegex()
    const b = createMentionRegex()
    expect(a).not.toBe(b)
    expect(a.global).toBe(true)
    expect(a.lastIndex).toBe(0)
  })
})
