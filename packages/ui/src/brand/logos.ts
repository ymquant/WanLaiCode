// Brand-aware Logo 注册表：每个 brand 注册自己的 Mark / MarkGray / Splash / Logo
// solid-js 组件，logo.tsx router 按 getBrand().id 查这张表。未注册的 brand 由
// router 自动 fallback 到 MAIN_BRAND_ID 的 set，不会渲染崩。

import type { Component, ComponentProps } from "solid-js"
import { CodexLogo, CodexMark, CodexMarkGray, CodexSplash } from "./logo-codex"
import { WanlaiLogo, WanlaiMark, WanlaiMarkGray, WanlaiSplash } from "./logo-wanlai"

export interface BrandLogoSet {
  Mark: Component<{ class?: string }>
  MarkGray: Component<{ class?: string }>
  Splash: Component<Pick<ComponentProps<"svg">, "ref" | "class">>
  Logo: Component<{ class?: string }>
}

export const BRAND_LOGOS: Record<string, BrandLogoSet> = {
  wanlai: {
    Mark: WanlaiMark,
    MarkGray: WanlaiMarkGray,
    Splash: WanlaiSplash,
    Logo: WanlaiLogo,
  },
  codex: {
    Mark: CodexMark,
    MarkGray: CodexMarkGray,
    Splash: CodexSplash,
    Logo: CodexLogo,
  },
}
