export function collapseThinkingWithViewport(input: {
  viewport?: {
    scrollHeight: number
    clientHeight: number
    scrollTop: number
    getBoundingClientRect: () => Pick<DOMRect, "top" | "bottom">
  }
  content?: { getBoundingClientRect: () => Pick<DOMRect, "top" | "bottom"> }
  collapse: () => void
  schedule?: (callback: () => void) => void
  bottomThreshold?: number
}) {
  const viewport = input.viewport
  const content = input.content
  if (!viewport || !content) {
    input.collapse()
    return true
  }

  const viewportRect = viewport.getBoundingClientRect()
  const contentRect = content.getBoundingClientRect()
  const readingHistory =
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > (input.bottomThreshold ?? 10)
  const contentVisible = contentRect.bottom > viewportRect.top && contentRect.top < viewportRect.bottom

  // 用户正在阅读推理区时不自动移走眼前内容；完成态仍允许用户手动收起。
  if (readingHistory && contentVisible) return false

  const contentAboveViewport = readingHistory && contentRect.bottom <= viewportRect.top
  const beforeHeight = viewport.scrollHeight
  const beforeTop = viewport.scrollTop
  input.collapse()
  if (!contentAboveViewport) return true

  // 推理区位于视口上方时按真实塌陷高度补偿，避免浏览器锚定失效后把正在阅读的正文向上拽走。
  const compensate = () => {
    const removed = Math.max(0, beforeHeight - viewport.scrollHeight)
    if (!removed) return
    const compensatedTop = Math.max(0, beforeTop - removed)
    // rAF 前用户若主动滚动到第三个位置，保留该输入；浏览器自身锚定到目标位置时也不重复争抢滚动条。
    if (viewport.scrollTop !== beforeTop && viewport.scrollTop !== compensatedTop) return
    viewport.scrollTop = compensatedTop
  }
  if (input.schedule) input.schedule(compensate)
  else requestAnimationFrame(compensate)
  return true
}
