// 浏览器风格 back/forward 历史追踪 reducer。
// 按 path 变化推断当前 navigation 是 forward / back / new push，并维护 stack + index。
// 设计选择：
//  - stack 只存 pathname，忽略 search/hash 变化 —— 否则 query string / hash tab 切换会污染 stack
//  - 设上限 MAX_NAV_HISTORY 防止长时间使用累积内存（超过则丢弃最旧 entry）
//  - 没有 replace 信号（router 不暴露），所以连续两次去同一 pathname 不创建新 entry（被 stack[index] === next 短路）

export type NavHistory = {
  stack: string[]
  index: number
}

export const MAX_NAV_HISTORY = 50

export const initialNavHistory = (): NavHistory => ({ stack: [], index: -1 })

/** 取一个完整 location 的 pathname 部分。前后缀斜杠归一，避免 / 和 // 算两个不同 entry。 */
export const normalizePath = (pathname: string): string => {
  const trimmed = pathname.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/**
 * 根据 path 变化更新 history。返回新的 NavHistory 对象。
 * 推断规则：
 *   - next === stack[index]            ：未变化，原样返回
 *   - next === stack[index + 1]        ：forward
 *   - next === stack[index - 1]        ：back
 *   - 否则                              ：新 push（截断 forward 部分），超上限时丢弃最旧 entry
 */
export function applyPath(prev: NavHistory, next: string): NavHistory {
  if (prev.index >= 0 && prev.stack[prev.index] === next) return prev
  if (prev.stack[prev.index + 1] === next) return { ...prev, index: prev.index + 1 }
  if (prev.index > 0 && prev.stack[prev.index - 1] === next) return { ...prev, index: prev.index - 1 }
  const truncated = [...prev.stack.slice(0, prev.index + 1), next]
  const overflow = truncated.length - MAX_NAV_HISTORY
  if (overflow > 0) {
    const stack = truncated.slice(overflow)
    return { stack, index: stack.length - 1 }
  }
  return { stack: truncated, index: truncated.length - 1 }
}

export const canGoBack = (state: NavHistory): boolean => state.index > 0

export const canGoForward = (state: NavHistory): boolean => state.index < state.stack.length - 1
