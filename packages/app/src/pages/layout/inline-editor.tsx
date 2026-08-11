import { createStore } from "solid-js/store"
import { onCleanup, Show, type Accessor } from "solid-js"
import { InlineInput } from "@opencode-ai/ui/inline-input"

export function createInlineEditorController() {
  // This controller intentionally supports one active inline editor at a time.
  const [editor, setEditor] = createStore({
    active: "" as string,
    value: "",
  })

  const editorOpen = (id: string) => editor.active === id
  const editorValue = () => editor.value
  const openEditor = (id: string, value: string) => {
    if (!id) return
    setEditor({ active: id, value })
  }
  const closeEditor = () => setEditor({ active: "", value: "" })

  const saveEditor = (callback: (next: string) => void) => {
    const next = editor.value.trim()
    if (!next) {
      closeEditor()
      return
    }
    closeEditor()
    callback(next)
  }

  const editorKeyDown = (event: KeyboardEvent, callback: (next: string) => void) => {
    if (event.key === "Enter") {
      event.preventDefault()
      saveEditor(callback)
      return
    }
    if (event.key !== "Escape") return
    event.preventDefault()
    closeEditor()
  }

  const InlineEditor = (props: {
    id: string
    value: Accessor<string>
    onSave: (next: string) => void
    class?: string
    displayClass?: string
    editing?: boolean
    stopPropagation?: boolean
    openOnDblClick?: boolean
    // 可选：不传则不限长度，保持 workspace / thread 等既有调用方的行为不变。
    maxLength?: number
  }) => {
    let frame: number | undefined

    onCleanup(() => {
      if (frame === undefined) return
      cancelAnimationFrame(frame)
    })

    const isEditing = () => props.editing ?? editorOpen(props.id)
    const stopEvents = () => props.stopPropagation ?? false
    const allowDblClick = () => props.openOnDblClick ?? true
    const stopPropagation = (event: Event) => {
      if (!stopEvents()) return
      event.stopPropagation()
    }
    const handleDblClick = (event: MouseEvent) => {
      if (!allowDblClick()) return
      stopPropagation(event)
      openEditor(props.id, props.value())
    }

    return (
      <Show
        when={isEditing()}
        fallback={
          <span
            class={props.displayClass ?? props.class}
            onDblClick={handleDblClick}
            onPointerDown={stopPropagation}
            onMouseDown={stopPropagation}
            onClick={stopPropagation}
            onTouchStart={stopPropagation}
          >
            {props.value()}
          </span>
        }
      >
        <InlineInput
          ref={(el) => {
            if (frame !== undefined) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
              frame = undefined
              if (!el.isConnected) return
              el.focus()
            })
          }}
          value={editorValue()}
          class={props.class}
          // 原生 maxlength 只拦新输入，不动已经填进来的存量长名称 —— 与另两个改名入口同一套语义。
          maxLength={props.maxLength}
          onInput={(event) => setEditor("value", event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            editorKeyDown(event, props.onSave)
          }}
          onBlur={closeEditor}
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
          onDblClick={stopPropagation}
          onMouseDown={stopPropagation}
          onMouseUp={stopPropagation}
          onTouchStart={stopPropagation}
        />
      </Show>
    )
  }

  return {
    editor,
    editorOpen,
    editorValue,
    openEditor,
    closeEditor,
    saveEditor,
    editorKeyDown,
    setEditor,
    InlineEditor,
  }
}
