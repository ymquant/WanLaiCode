// 提问面板可用高度：顶到会话滚动区的 sticky 头部下沿，底到输入 dock 下沿
export function measureQuestionHeight(root: HTMLElement) {
  const scroller = document.querySelector(".scroll-view__viewport")
  const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
  const top = head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
  if (!top) {
    root.style.removeProperty("--question-prompt-max-height")
    return
  }

  const dock = root.closest('[data-component="session-prompt-dock"]')
  if (!(dock instanceof HTMLElement)) return

  const dockBottom = dock.getBoundingClientRect().bottom
  const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
  const gap = 8
  const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
  root.style.setProperty("--question-prompt-max-height", `${max}px`)
}
