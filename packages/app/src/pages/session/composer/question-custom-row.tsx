import { createEffect, type Component } from "solid-js"
import { shouldExitCustomRow } from "@/pages/session/composer/question-keyboard"
import { QuestionMarker } from "@/pages/session/composer/question-marker"

const resizeInput = (el: HTMLTextAreaElement) => {
  el.style.height = "0px"
  el.style.height = `${el.scrollHeight}px`
}

export const QuestionCustomRow: Component<{
  label: string
  value: string
  placeholder: string
  picked: boolean
  disabled: boolean
  ref?: (el: HTMLTextAreaElement) => void
  onOpen: VoidFunction
  onFocus: VoidFunction
  onCommit: VoidFunction
  onInput: (value: string) => void
  onEscape: VoidFunction
  onExit: VoidFunction
  onEnter: VoidFunction
}> = (props) => {
  let field: HTMLTextAreaElement | undefined

  // 挂载与切题都要按恢复的内容重算高度；ref 回调时元素还没插入文档，scrollHeight 恒为 0
  createEffect(() => {
    props.value
    if (field) resizeInput(field)
  })

  return (
    <form
      data-slot="question-custom"
      data-picked={props.picked}
      onMouseDown={(e) => {
        if (props.disabled) {
          e.preventDefault()
          return
        }
        // 命中的是不可聚焦的 form/序号 span：不拦截默认动作的话浏览器会把焦点甩去 body，委托 keydown 从此收不到键
        if (e.target !== field) e.preventDefault()
        props.onOpen()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        props.onCommit()
      }}
    >
      <QuestionMarker variant="pencil" selected={props.picked} />
      <textarea
        ref={(el) => {
          field = el
          props.ref?.(el)
        }}
        data-slot="question-custom-input"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={props.value}
        rows={1}
        disabled={props.disabled}
        onFocus={props.onFocus}
        onBlur={props.onCommit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            props.onEscape()
            return
          }
          if (
            shouldExitCustomRow({
              key: e.key,
              shiftKey: e.shiftKey,
              selectionStart: e.currentTarget.selectionStart,
              selectionEnd: e.currentTarget.selectionEnd,
            })
          ) {
            e.preventDefault()
            props.onExit()
            return
          }
          if (e.key !== "Enter" || e.shiftKey) return
          e.preventDefault()
          props.onEnter()
        }}
        onInput={(e) => {
          props.onInput(e.currentTarget.value)
          resizeInput(e.currentTarget)
        }}
      />
    </form>
  )
}
