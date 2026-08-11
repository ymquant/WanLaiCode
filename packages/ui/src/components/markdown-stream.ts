import { marked, type Tokens } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live"
}

type StreamState = {
  text: string
  stable: Block[]
  tail: string
}

// 稳定块按有限大小合并，既避免每个段落占一个缓存项，也把段落完成时需要更新的 DOM 限制在小块内。
// 2 KiB 足以合并大量短段落，同时不会让长推理在块封口时重新挂载过大的稳定前缀。
const STABLE_CHUNK_SIZE = 2 * 1024

function refs(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

function appendStable(blocks: Block[], units: string[]) {
  return units.reduce((result, raw) => {
    if (!raw) return result

    const last = result.at(-1)
    if (last && last.raw.length + raw.length <= STABLE_CHUNK_SIZE) {
      return [...result.slice(0, -1), { raw: last.raw + raw, src: last.src + raw, mode: "full" as const }]
    }

    return [...result, { raw, src: raw, mode: "full" as const }]
  }, blocks)
}

function splitTail(text: string) {
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return { stable: [] as string[], tail: text, openCode: false }
  const last = tokens[tail]
  let offset = 0
  const stable = tokens.slice(0, tail).reduce((result, token) => {
    // marked 会规范化某些未完成 token 的 raw（例如把列表标记后的空格改成换行）。
    // token 长度只用于定位原始源码边界，缓存内容必须从 text 切片，不能把规范化 raw 拼回下一轮输入。
    const raw = text.slice(offset, offset + token.raw.length)
    offset += token.raw.length
    if (token.type === "space" && result.length > 0) {
      result[result.length - 1] += raw
      return result
    }
    result.push(raw)
    return result
  }, [] as string[])

  return {
    stable,
    // 尾块同样保留原始字节；下一次追加只允许在原文上继续词法分析，避免列表正文被永久污染。
    tail: text.slice(offset),
    openCode: !!last && last.type === "code" && open((last as Tokens.Code).raw),
  }
}

/**
 * 为单个 Markdown 实例保留稳定前缀，只重新词法分析仍可能被后续字符改变的尾块。
 * 这样长回复的每次 token 更新不再重复扫描、修复和解析整篇历史内容。
 */
export function createMarkdownStream() {
  let state: StreamState | undefined

  return (text: string, live: boolean) => {
    // 引用式链接和脚注会由尾部定义反向改变前文，不能拆块缓存。
    if (refs(text)) {
      state = undefined
      return [{ raw: text, src: live ? heal(text) : text, mode: live ? "live" : "full" }] satisfies Block[]
    }

    // 普通静态 Markdown 保持单块语义；只有经历过流式追加的实例才沿用增量块完成收尾。
    if (!live && (!state || !text.startsWith(state.text))) {
      state = undefined
      return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
    }

    const previous = state
    const appended = previous ? text.startsWith(previous.text) : false
    const source = previous && appended ? previous.tail + text.slice(previous.text.length) : text
    const split = splitTail(source)
    const stable = appendStable(previous && appended ? previous.stable : [], split.stable)

    if (!live) {
      state = undefined
      const completed = appendStable(stable, [split.tail])
      return completed.length > 0 ? completed : ([{ raw: text, src: text, mode: "full" }] satisfies Block[])
    }

    state = { text, stable, tail: split.tail }
    return [
      ...stable,
      {
        raw: split.tail,
        // 未闭合代码围栏交给 marked 直接处理，避免 remend 每次扫描整段代码并重复补围栏。
        src: split.openCode ? split.tail : heal(split.tail),
        mode: "live" as const,
      },
    ]
  }
}

export function stream(text: string, live: boolean) {
  return createMarkdownStream()(text, live)
}
