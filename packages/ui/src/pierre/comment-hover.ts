export type HoverCommentLine = {
  lineNumber: number
  side?: "additions" | "deletions"
}

export function createHoverCommentUtility(props: {
  label: string
  getHoveredLine: () => HoverCommentLine | undefined
  onSelect: (line: HoverCommentLine) => void
}) {
  if (typeof document === "undefined") return

  const button = document.createElement("button")
  button.type = "button"
  button.ariaLabel = props.label
  button.textContent = "+"
  button.style.width = "20px"
  button.style.height = "20px"
  button.style.display = "flex"
  button.style.alignItems = "center"
  button.style.justifyContent = "center"
  button.style.border = "none"
  button.style.borderRadius = "4px"
  button.style.background = "#4b525d"
  button.style.color = "var(--white)"
  button.style.boxShadow = "none"
  button.style.fontSize = "14px"
  button.style.lineHeight = "1"
  button.style.cursor = "pointer"

  const wrapper = document.createElement("div")
  wrapper.style.width = "var(--diffs-column-number-width)"
  wrapper.style.height = "var(--diffs-line-height, 24px)"
  wrapper.style.display = "flex"
  wrapper.style.alignItems = "center"
  wrapper.style.justifyContent = "flex-end"
  wrapper.appendChild(button)

  let line: HoverCommentLine | undefined

  const sync = () => {
    const next = props.getHoveredLine()
    if (!next) return
    line = next
  }

  const loop = () => {
    if (!button.isConnected) return
    sync()
    requestAnimationFrame(loop)
  }

  const open = () => {
    const next = props.getHoveredLine() ?? line
    if (!next) return
    props.onSelect(next)
  }

  requestAnimationFrame(loop)
  button.addEventListener("mouseenter", sync)
  button.addEventListener("mousemove", sync)
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    event.stopPropagation()
    sync()
  })
  button.addEventListener("mousedown", (event) => {
    event.preventDefault()
    event.stopPropagation()
    sync()
  })
  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    open()
  })

  return wrapper
}
