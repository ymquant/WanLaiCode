const ANSI_ESCAPE = /\x1b\[([\d;]*)m/g

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function codesToClass(codes: number[]): string {
  const parts: string[] = []
  for (const c of codes) {
    switch (c) {
      case 0:
        return ""
      case 1:
        parts.push("ansi-bold")
        break
      case 2:
        parts.push("ansi-dim")
        break
      case 3:
        parts.push("ansi-italic")
        break
      case 4:
        parts.push("ansi-underline")
        break
      default:
        if (c >= 30 && c <= 37) parts.push(`ansi-fg-${c - 30}`)
        else if (c >= 40 && c <= 47) parts.push(`ansi-bg-${c - 40}`)
        else if (c >= 90 && c <= 97) parts.push(`ansi-fg-br-${c - 90}`)
        else if (c >= 100 && c <= 107) parts.push(`ansi-bg-br-${c - 100}`)
    }
  }
  return parts.join(" ")
}

function mergeState(current: number[], incoming: number[]): number[] {
  if (incoming.includes(0)) return []

  const set = new Set(current)
  for (const code of incoming) {
    const isFg = (code >= 30 && code <= 37) || (code >= 90 && code <= 97)
    const isBg = (code >= 40 && code <= 47) || (code >= 100 && code <= 107)

    if (isFg) {
      for (let c = 30; c <= 37; c++) set.delete(c)
      for (let c = 90; c <= 97; c++) set.delete(c)
    }
    if (isBg) {
      for (let c = 40; c <= 47; c++) set.delete(c)
      for (let c = 100; c <= 107; c++) set.delete(c)
    }
    set.add(code)
  }
  return [...set]
}

/**
 * Converts ANSI escape sequences to HTML with CSS class-based color spans.
 * Text content is HTML-escaped before wrapping.
 */
export function ansiToHtml(text: string): string {
  if (!text) return ""

  let result = ""
  let state: number[] = []
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = ANSI_ESCAPE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    if (before) {
      const escaped = escapeHtml(before)
      const cls = codesToClass(state)
      if (cls) {
        result += `<span class="${cls}">${escaped}</span>`
      } else {
        result += escaped
      }
    }

    const codes = match[1] ? match[1].split(";").map(Number) : [0]
    state = mergeState(state, codes)
    lastIndex = match.index + match[0].length
  }

  const remaining = text.slice(lastIndex)
  if (remaining) {
    const escaped = escapeHtml(remaining)
    const cls = codesToClass(state)
    if (cls) {
      result += `<span class="${cls}">${escaped}</span>`
    } else {
      result += escaped
    }
  }

  return result
}

const EXT_LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", pyx: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html",
  json: "json", jsonc: "jsonc", json5: "jsonc",
  md: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  xml: "xml", svg: "xml",
  sql: "sql",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", psd1: "powershell", psm1: "powershell",
  dockerfile: "dockerfile",
  vue: "vue", svelte: "svelte",
  c: "c", h: "c",
  cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  php: "php",
  lua: "lua",
  r: "r",
  dart: "dart",
  proto: "protobuf",
  graphql: "graphql", gql: "graphql",
  prisma: "prisma",
  ex: "elixir", exs: "elixir",
  erl: "erlang", hrl: "erlang",
  hs: "haskell",
  scala: "scala",
  env: "env",
  ini: "ini", cfg: "ini", conf: "ini",
  makefile: "make",
  cmake: "cmake",
  nix: "nix",
}

const FILE_LANG_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  "cmakelists.txt": "cmake",
  ".env": "env",
  ".gitignore": "gitignore",
  ".dockerignore": "dockerignore",
}

/** Derive Shiki language id from a file extension. Returns null if unknown. */
export function langFromFilePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/")
  const filename = normalized.split("/").pop()?.toLowerCase()
  if (!filename) return null
  if (FILE_LANG_MAP[filename]) return FILE_LANG_MAP[filename]
  if (filename.startsWith("dockerfile.")) return "dockerfile"
  if (filename.startsWith(".env.")) return "env"
  const ext = filename.split(".").pop()
  if (!ext) return null
  return EXT_LANG_MAP[ext] ?? null
}

/** Extract inner <code> content from Shiki codeToHtml output. */
export function extractCodeInner(html: string): string {
  const match = html.match(/<code[^>]*>([\s\S]*)<\/code>/)
  return match?.[1] ?? html
}
