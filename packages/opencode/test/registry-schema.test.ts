import { expect, test } from "bun:test"
import { Schema } from "effect"
import { RegistryPluginOut } from "../src/server/routes/instance/httpapi/groups/registry"

// 后端描述已统一为 short_description/long_description，无顶层 description 字段。
// 用真实形态 item（短/长描述、无 description）解码，防止 schema 再要求已移除的字段 → 列表 400。
test("RegistryPluginOut accepts real backend item (short/long, no description)", () => {
  const item = {
    namespace: "e2etest",
    slug: "hyperframes",
    locale: "zh-CN",
    default_locale: "en",
    available_locales: ["en", "zh-CN"],
    display_name: "HyperFrames",
    short_description: "Write HTML, render video",
    long_description: "Build videos from HTML…",
    logo_url: "/api/v1/plugins/e2etest/hyperframes/logo",
    category: "Design",
    latest_version: "0.1.4",
    download_count: 0,
    rating_avg: 0,
    rating_count: 0,
    comment_count: 0,
    created_at: "2026-06-23T05:59:34.004713Z",
    updated_at: "2026-06-23T08:39:42.766507Z",
    // NOTE: no `description` key — backend removed it.
  }
  expect(() => Schema.decodeUnknownSync(RegistryPluginOut)(item)).not.toThrow()
})
