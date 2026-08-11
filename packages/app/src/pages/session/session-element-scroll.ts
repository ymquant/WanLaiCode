export const scrollSessionElement = (input: { root: HTMLElement; target: HTMLElement; behavior: ScrollBehavior }) => {
  const targetBox = input.target.getBoundingClientRect()
  const rootBox = input.root.getBoundingClientRect()
  const sticky = input.root.querySelector("[data-session-title]")
  const inset = sticky instanceof HTMLElement ? sticky.offsetHeight : 0
  // 目标顶边始终落在 sticky 标题下方；hash、Minimap 和命令面板都经由这一坐标计算。
  input.root.scrollTo({
    top: Math.max(0, targetBox.top - rootBox.top + input.root.scrollTop - inset),
    behavior: input.behavior,
  })
}
