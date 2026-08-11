// 吞掉「下一次 click」—— 用于在关闭一个浮层(如 DropdownMenu)并触发某动作后,
// 拦掉浏览器在原指针位置补发的 ghost click,避免它冒泡到下层可点元素(如整张卡片/整行)
// 触发误导航。捕获阶段拦一次即移除;500ms 兜底清理(若 ghost click 未发生)。
export function swallowNextClick(): void {
  const handler = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    window.removeEventListener("click", handler, true)
  }
  window.addEventListener("click", handler, true)
  setTimeout(() => window.removeEventListener("click", handler, true), 500)
}
