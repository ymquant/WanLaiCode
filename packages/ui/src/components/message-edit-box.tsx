import { createSignal, onMount } from "solid-js"
import { useI18n } from "../context/i18n"

export interface MessageEditBoxProps {
  initialText: string
  onSend: (text: string) => void
  onCancel: () => void
  /** When true, Send is enabled even if the body is empty (e.g. excerpt-only user messages). */
  allowEmptySubmit?: boolean
}

export function MessageEditBox(props: MessageEditBoxProps) {
  const i18n = useI18n()
  const [text, setText] = createSignal(props.initialText)
  const [composing, setComposing] = createSignal(false)
  let textareaRef: HTMLTextAreaElement | undefined

  onMount(() => {
    if (!textareaRef) return
    textareaRef.focus()
    textareaRef.select()
    textareaRef.style.height = "auto"
    textareaRef.style.height = `${textareaRef.scrollHeight}px`
  })

  const handleSend = () => {
    const raw = text()
    if (!props.allowEmptySubmit && !raw.trim()) return
    props.onSend(props.allowEmptySubmit ? raw : raw.trim())
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) return
    if (e.key === "Enter" && (e.isComposing || composing() || e.keyCode === 229)) return
    if (e.key === "Enter") {
      e.preventDefault()
      handleSend()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      props.onCancel()
    }
  }

  const handleInput = () => {
    if (!textareaRef) return
    textareaRef.style.height = "auto"
    textareaRef.style.height = `${textareaRef.scrollHeight}px`
  }

  return (
    <div
      data-component="message-edit-box"
      style={{
        width: "100%",
        "max-width": "100%",
      }}
    >
      <div
        style={{
          "background-color": "var(--surface-weak)",
          border: "none",
          "border-radius": "16px",
          padding: "16px",
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
        }}
      >
        <textarea
          ref={(el) => (textareaRef = el)}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value)
            handleInput()
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={handleKeyDown}
          style={{
            width: "100%",
            resize: "none",
            "background-color": "transparent",
            border: "none",
            outline: "none",
            "font-size": "14px",
            "line-height": "1.6",
            color: "var(--text-strong)",
            "font-family": "inherit",
            overflow: "auto",
            height: "100px",
          }}
          class="no-scrollbar"
        />
        <div
          style={{
            display: "flex",
            "justify-content": "flex-end",
            gap: "8px",
          }}
        >
          <button
            type="button"
            onClick={props.onCancel}
            style={{
              width: "44px",
              height: "27px",
              "font-size": "13px",
              color: "var(--text-strong)",
              "background-color": "var(--surface-strong)",
              border: "1px solid var(--border-weak-base)",
              "border-radius": "8px",
              cursor: "pointer",
              "font-family": "inherit",
              outline: "none",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
            }}
          >
            {i18n.t("ui.message.editBox.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={!props.allowEmptySubmit && !text().trim()}
            style={{
              width: "44px",
              height: "27px",
              "font-size": "13px",
              color: "var(--text-invert-base)",
              "background-color": "var(--surface-float-base)",
              border: "none",
              "border-radius": "8px",
              cursor: props.allowEmptySubmit || text().trim() ? "pointer" : "not-allowed",
              "font-family": "inherit",
              outline: "none",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              opacity: !props.allowEmptySubmit && !text().trim() ? 0.5 : 1,
            }}
          >
            {i18n.t("ui.message.editBox.send")}
          </button>
        </div>
      </div>
    </div>
  )
}
