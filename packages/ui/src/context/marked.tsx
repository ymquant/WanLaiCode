import { marked } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import katex from "katex"
import hljs from "highlight.js"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { getSharedHighlighter, registerCustomTheme, type ThemeRegistrationResolved } from "@pierre/diffs"
import { createSimpleContext } from "./helper"

const SHIKI_FALLBACK_THEME = "OpenCodeMarkdownFallback"

registerCustomTheme(SHIKI_FALLBACK_THEME, () =>
  Promise.resolve({
    name: SHIKI_FALLBACK_THEME,
    colors: {
      "editor.background": "transparent",
      "editor.foreground": "var(--syntax-base)",
    },
    tokenColors: [
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syntax-comment)" } },
      { scope: ["keyword", "storage"], settings: { foreground: "var(--syntax-keyword)" } },
      { scope: ["string", "punctuation.definition.string"], settings: { foreground: "var(--syntax-string)" } },
      { scope: ["constant.numeric"], settings: { foreground: "var(--syntax-number)" } },
      { scope: ["constant", "variable.language"], settings: { foreground: "var(--syntax-constant)" } },
      { scope: ["entity.name.function", "support.function"], settings: { foreground: "var(--syntax-function)" } },
      { scope: ["entity.name.tag"], settings: { foreground: "var(--syntax-tag)" } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--syntax-attribute)" } },
      { scope: ["entity.name.type", "support.type", "storage.type"], settings: { foreground: "var(--syntax-type)" } },
      { scope: ["variable", "meta.object-literal.key"], settings: { foreground: "var(--syntax-variable)" } },
      { scope: ["string.regexp"], settings: { foreground: "var(--syntax-regexp)" } },
    ],
  } as unknown as ThemeRegistrationResolved),
)

const LANGUAGE_ALIASES: Record<string, string> = {
  "c-sharp": "csharp",
  cu: "cpp",
  cuh: "cpp",
  cppm: "cpp",
  cxxm: "cpp",
  docker: "dockerfile",
  golang: "go",
  html: "xml",
  ixx: "cpp",
  nginxconf: "nginx",
  ps1: "powershell",
  python3: "python",
  shell: "bash",
  shellscript: "bash",
  svg: "xml",
  text: "plaintext",
  ts: "typescript",
  txt: "plaintext",
  vue: "xml",
  yml: "yaml",
  zsh: "bash",
}

export function isHttpMarkdownHref(href: string) {
  return /^https?:\/\//i.test(href)
}

export function isLocalMarkdownHref(href: string) {
  if (/^file:\/\//i.test(href)) return true
  if (/^[A-Za-z]:[\\/]/.test(href)) return true
  if (href.startsWith("/") && !href.startsWith("//")) return true
  return false
}

export function localMarkdownHrefDisplay(href: string) {
  if (!href.toLowerCase().startsWith("file://")) return href
  try {
    const decoded = decodeURIComponent(new URL(href).pathname)
    if (/^\/[A-Za-z]:[\/]/.test(decoded)) return decoded.slice(1)
    return decoded
  } catch {
    const decoded = href.replace(/^file:\/\//i, "")
    if (/^\/[A-Za-z]:[\/]/.test(decoded)) return decoded.slice(1)
    return decoded
  }
}

// 对 markdown 做仅作用于「非代码区」的文本变换,跳过代码块与行内代码,
// 避免误伤代码里的反斜杠、美元符。
const CODE_REGION_REGEX = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/g

function mapOutsideCode(markdown: string, transform: (text: string) => string): string {
  return markdown
    .split(CODE_REGION_REGEX)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join("")
}

// 把 LaTeX 风格定界符 \(...\) \[...\] 转成 KaTeX 扩展认识的 $...$ / $$...$$。
export function convertLatexDelimiters(markdown: string): string {
  return mapOutsideCode(markdown, (text) =>
    text.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => `$$${math}$$`).replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => `$${math}$`),
  )
}

// 把货币写法转义为 \$,避免 $5 ... $10 被 KaTeX 当成行内公式。判定为货币需同时满足:
// - 前面是词边界(不是字母/数字/`}`/`]`/`)`/`$`)——避免破坏 $$ 定界符或 $x$5 的闭合 $;
// - 紧跟数字(可带千分位/小数);
// - 数字后不是数学符号/字母/反斜杠——保留 $5x$、$2^n$ 这类以数字开头的真公式。
export function escapeCurrencyDollars(markdown: string): string {
  return mapOutsideCode(markdown, (text) =>
    text.replace(/(?<![\w}\])$])\$(?=\d)(\d[\d,]*(?:\.\d+)?)(?![\d.,^_={}\\+\-*/a-zA-Z])/g, "\\$$$1"),
  )
}

function renderMathInText(text: string): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: $...$
  const inlineMathRegex = /(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `$${math}$`
    }
  })

  return result
}

function renderMathExpressions(html: string): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part)
    })
    .join("")
}

function decodeCodeEntities(code: string) {
  return code
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

const MAX_HIGHLIGHT_BYTES = 512 * 1024
const MAX_HIGHLIGHT_LINES = 10_000
const MAX_HIGHLIGHT_LINE_BYTES = 4 * 1024
const textEncoder = new TextEncoder()

export function codeBlockLanguage(info?: string) {
  const requested = info?.trim().split(/[,\s]/, 1)[0]?.toLowerCase() || "plaintext"
  return {
    requested,
    normalized: LANGUAGE_ALIASES[requested] || requested,
  }
}

export function exceedsHighlightLimits(code: string) {
  if (textEncoder.encode(code).byteLength > MAX_HIGHLIGHT_BYTES) return true
  const lines = code.split("\n")
  return (
    lines.length > MAX_HIGHLIGHT_LINES ||
    lines.some((line) => textEncoder.encode(line).byteLength > MAX_HIGHLIGHT_LINE_BYTES)
  )
}

function plaintextCodeBlock(code: string, language: string) {
  const html = hljs.highlight(code, { language: "plaintext" }).value
  return `<pre class="hljs" data-language="${language}"><code>${html}</code></pre>`
}

export async function highlightCode(code: string, language?: string) {
  const { requested, normalized } = codeBlockLanguage(language)
  if (exceedsHighlightLimits(code)) return plaintextCodeBlock(code, requested)

  if (hljs.getLanguage(normalized)) {
    const html = hljs.highlight(code, { language: normalized }).value
    return `<pre class="hljs" data-language="${requested}"><code>${html}</code></pre>`
  }

  if (normalized in bundledLanguages) {
    const highlighter = await getSharedHighlighter({
      themes: [SHIKI_FALLBACK_THEME],
      langs: [],
      preferredHighlighter: "shiki-wasm",
    })
    if (!highlighter.getLoadedLanguages().includes(normalized)) {
      await highlighter.loadLanguage(normalized as BundledLanguage)
    }
    return highlighter
      .codeToHtml(code, { lang: normalized, theme: SHIKI_FALLBACK_THEME, tabindex: false })
      .replace("<pre", `<pre data-language="${requested}"`)
  }

  return plaintextCodeBlock(code, requested)
}

export async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  let result = html
  for (const [fullMatch, language, escapedCode] of matches) {
    const highlighted = await highlightCode(decodeCodeEntities(escapedCode), language)
    result = result.replace(fullMatch, () => highlighted)
  }
  return result
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

export type MarkedParser = {
  parse(markdown: string): string | Promise<string>
}

let jsMarkedParser: MarkedParser | undefined

function createJsMarkedParser(): MarkedParser {
  if (jsMarkedParser) return jsMarkedParser

  jsMarkedParser = marked.use(
    {
      hooks: {
        preprocess(markdown) {
          return convertLatexDelimiters(escapeCurrencyDollars(markdown))
        },
      },
      renderer: {
        link({ href, title, text }) {
          const titleAttr = title ? ` title="${title}"` : ""
          if (isHttpMarkdownHref(href)) {
            return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
          }
          if (isLocalMarkdownHref(href)) {
            const localHref = localMarkdownHrefDisplay(href)
            return `<a${titleAttr} data-href="${localHref}" class="markdown-pending-file-link">${text}</a>`
          }
          return `<a href="${href}"${titleAttr}>${text}</a>`
        },
      },
    },
    markedKatex({
      throwOnError: false,
      nonStandard: true,
    }),
    markedShiki({
      async highlight(code, lang) {
        return highlightCode(code, lang)
      },
    }),
  )

  return jsMarkedParser
}

export function createMarked(props: { nativeParser?: NativeMarkdownParser } = {}): MarkedParser {
  if (props.nativeParser) {
    const nativeParser = props.nativeParser
    return {
      async parse(markdown: string): Promise<string> {
        const html = await nativeParser(markdown)
        const withMath = renderMathExpressions(html)
        return highlightCodeBlocks(withMath)
      },
    }
  }

  return createJsMarkedParser()
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => createMarked(props),
})
