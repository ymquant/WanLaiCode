// Brand-aware Logo router：按 getBrand().id 查 BRAND_LOGOS 注册表选 wanlai/codex/...
// 的 SVG 组件。未注册的 brand 自动 fallback 到 MAIN_BRAND_ID 的 set，避免渲染崩。
// 4 个 export 签名维持原样，consumer 不变。

import type { ComponentProps } from "solid-js"
import { getBrand, MAIN_BRAND_ID } from "@opencode-ai/brand"
import { BRAND_LOGOS, type BrandLogoSet } from "../brand/logos"

function pickLogoSet(): BrandLogoSet {
  return BRAND_LOGOS[getBrand().id] ?? BRAND_LOGOS[MAIN_BRAND_ID]
}

export const Mark = (props: { class?: string }) => {
  const Impl = pickLogoSet().Mark
  return <Impl {...props} />
}

export const MarkGray = (props: { class?: string }) => {
  const Impl = pickLogoSet().MarkGray
  return <Impl {...props} />
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  const Impl = pickLogoSet().Splash
  return <Impl {...props} />
}

export const Logo = (props: { class?: string }) => {
  const Impl = pickLogoSet().Logo
  return <Impl {...props} />
}
