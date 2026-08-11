// SVG source: @lobehub/icons-static-svg (https://github.com/lobehub/lobe-icons), MIT-licensed.
// Inlined into solid components rather than imported as an asset so we can reuse the same
// gradient + glyph paths for Mark / MarkGray / Splash / Logo variants without bundler magic.
// Original viewBox 0 0 24 24；这里保留不变，由 consumer 给 svg 设宽高即可缩放。

import type { ComponentProps } from "solid-js"

// ─── Path constants ─────────────────────────────────────────────────────────
// 这两条 path 直接从 lobehub codex-color.svg 拷出来，仅微调（gradient id 改名）。

/** 白色圆角方形底（squircle，rx≈4.5 由 path 自带圆角描述） */
const CODEX_BG_PATH =
  "M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"

/** Codex 主形：一坨融合 blob + 内嵌 ">" 与 "_" 字符 */
const CODEX_GLYPH_PATH =
  "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"

/** 蓝紫渐变 def，4 个组件共享，id 用 codex-grad 避免与其他 svg 冲突 */
const CodexGradientDef = () => (
  <defs>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="codex-grad"
      x1="12"
      x2="12"
      y1="3"
      y2="21"
    >
      <stop stop-color="#B1A7FF" />
      <stop offset=".5" stop-color="#7A9DFF" />
      <stop offset="1" stop-color="#3941FF" />
    </linearGradient>
  </defs>
)

// ─── Components ─────────────────────────────────────────────────────────────

/** Mark：白色 squircle 背景 + 蓝紫渐变 codex glyph，对应 wanlai Mark 的黑底黄 W */
export const CodexMark = (props: { class?: string }) => (
  <svg
    data-component="logo-mark"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    shape-rendering="geometricPrecision"
  >
    <path data-slot="logo-mark-bg" d={CODEX_BG_PATH} fill="#fff" />
    <path data-slot="logo-mark-glyph" d={CODEX_GLYPH_PATH} fill="url(#codex-grad)" />
    <CodexGradientDef />
  </svg>
)

/** MarkGray：无背景，glyph 用 currentColor，跟 wanlai MarkGray 一致语义 */
export const CodexMarkGray = (props: { class?: string }) => (
  <svg
    data-component="logo-mark-gray"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    shape-rendering="geometricPrecision"
  >
    <path data-slot="logo-mark-glyph" d={CODEX_GLYPH_PATH} fill="currentColor" />
  </svg>
)

/** Splash：与 Mark 同形，viewBox 也是 24×24（path 是无单位的，宽高由 consumer 给出） */
export const CodexSplash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => (
  <svg
    ref={props.ref}
    data-component="logo-splash"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path data-slot="logo-bg" d={CODEX_BG_PATH} fill="#fff" />
    <path data-slot="logo-glyph" d={CODEX_GLYPH_PATH} fill="url(#codex-grad)" />
    <CodexGradientDef />
  </svg>
)

/**
 * Logo：mark 左 + wordmark "Codex（万来）" 右排。
 * viewBox 720×200 给出 ~3.6:1 横排比例，跟 wanlai Logo 视觉权重接近。
 * mark 占左 200×200 (用 g transform 缩放 24→200)；wordmark 用 system font 写 text。
 */
export const CodexLogo = (props: { class?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 720 200"
    fill="none"
    classList={{ [props.class ?? ""]: !!props.class }}
  >
    <g transform="scale(8.333)">
      {/* 24 * 8.333 ≈ 200 — mark 充满左 200×200 区域 */}
      <path data-slot="logo-mark-bg" d={CODEX_BG_PATH} fill="#fff" />
      <path data-slot="logo-mark-glyph" d={CODEX_GLYPH_PATH} fill="url(#codex-grad)" />
    </g>
    <text
      x="230"
      y="130"
      font-family="system-ui, -apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif"
      font-size="96"
      font-weight="600"
      fill="currentColor"
    >
      Codex（万来）
    </text>
    <CodexGradientDef />
  </svg>
)
