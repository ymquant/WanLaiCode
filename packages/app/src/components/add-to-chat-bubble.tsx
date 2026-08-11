import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { ADD_TO_CHAT_BUBBLE_WIDTH, addToChatBubblePosition } from "./add-to-chat-bubble-position"
import { isAssistantConversationContent } from "./add-to-chat-selection"

export function AddToChatBubble(props: { container: () => HTMLElement | undefined }) {
  const language = useLanguage()
  const prompt = usePrompt()

  const [position, setPosition] = createSignal<{ top: number; left: number } | null>(null)
  const [selectedText, setSelectedText] = createSignal("")

  const hide = () => {
    setPosition(null)
    setSelectedText("")
  }

  const collectSelection = () => {
    if (typeof window === "undefined") return null
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null

    const text = sel.toString().trim()
    if (!text) return null

    const range = sel.getRangeAt(0)
    // 必须落在 message timeline 滚动容器中（避免误触历史侧栏等其他位置）。
    const root = props.container()
    if (!root) return null
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null

    if (!isAssistantConversationContent(range.startContainer)) return null
    if (!isAssistantConversationContent(range.endContainer)) return null

    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null

    return { text, rect }
  }

  const update = () => {
    const next = collectSelection()
    if (!next) {
      hide()
      return
    }
    setSelectedText(next.text)
    setPosition(addToChatBubblePosition(next.rect))
  }

  onMount(() => {
    let selecting = false
    const isInsideBubble = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false
      let node: Node | null = target
      while (node) {
        if (node instanceof HTMLElement && node.dataset.component === "add-to-chat-bubble") {
          return true
        }
        node = node.parentNode
      }
      return false
    }
    const onPointerDown = (event: Event) => {
      // 点按钮本身：让按钮的 mousedown handler 阻止默认折叠选区，这里不要把浮窗 hide 掉。
      if (isInsideBubble(event.target)) return
      selecting = true
      hide()
    }
    const onPointerUp = () => {
      selecting = false
      requestAnimationFrame(update)
    }
    const onSelectionChange = () => {
      if (selecting) return
      update()
    }
    const onScrollOrResize = () => {
      if (selecting) return
      update()
    }

    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("mouseup", onPointerUp)
    document.addEventListener("touchstart", onPointerDown)
    document.addEventListener("touchend", onPointerUp)
    document.addEventListener("keyup", onPointerUp)
    document.addEventListener("selectionchange", onSelectionChange)
    window.addEventListener("scroll", onScrollOrResize, true)
    window.addEventListener("resize", onScrollOrResize)

    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("mouseup", onPointerUp)
      document.removeEventListener("touchstart", onPointerDown)
      document.removeEventListener("touchend", onPointerUp)
      document.removeEventListener("keyup", onPointerUp)
      document.removeEventListener("selectionchange", onSelectionChange)
      window.removeEventListener("scroll", onScrollOrResize, true)
      window.removeEventListener("resize", onScrollOrResize)
    })
  })

  const handleAdd = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const text = selectedText()
    if (!text) return

    prompt.addToChat.push(text)

    const editor = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
    editor?.focus()

    window.getSelection()?.removeAllRanges()
    hide()
  }

  return (
    <Show when={position()}>
      {(pos) => (
        <div
          data-component="add-to-chat-bubble"
          style={{
            position: "fixed",
            top: `${pos().top}px`,
            left: `${pos().left}px`,
            transform: "translateX(-50%) scale(1.15)",
            "transform-origin": "bottom center",
            "z-index": "70",
            width: `${ADD_TO_CHAT_BUBBLE_WIDTH}px`,
            "border-radius": "9999px",
            background: "var(--surface-raised-base)",
            border: "1px solid var(--border-base)",
            padding: "4px",
            "box-shadow":
              "0 12px 30px -10px light-dark(rgba(0, 0, 0, 0.28), rgba(0, 0, 0, 0.6)), 0 4px 12px -4px light-dark(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.4))",
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
          }}
        >
          <style>
            {`[data-component="add-to-chat-bubble"] [data-component="button"] {
              height: 20px;
              gap: 4px;
              font-size: 11px;
              line-height: 1;
              font-weight: 440;
              color: var(--text-strong) !important;
              box-shadow: none !important;
              border: none !important;
              background-color: transparent !important;
            }
            [data-component="add-to-chat-bubble"] [data-component="button"]:hover:not(:disabled) {
              background-color: var(--surface-raised-base-hover) !important;
              color: var(--text-strong) !important;
            }
            [data-component="add-to-chat-bubble"] [data-component="button"][data-icon] {
              width: 100%;
              padding: 0 6px;
            }
            [data-component="add-to-chat-bubble"] [data-component="button"] [data-component="icon"] {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              color: var(--icon-strong-base);
            }
            [data-component="add-to-chat-bubble"] [data-component="button"] [data-component="icon"] svg {
              width: 12px;
              height: 12px;
              display: block;
              color: var(--icon-strong-base);
              stroke-width: 1.5;
            }`}
          </style>
          <Button
            size="small"
            variant="secondary"
            icon="speech-bubble"
            style={{ "border-radius": "9999px" }}
            onMouseDown={(e: MouseEvent) => e.preventDefault()}
            onClick={handleAdd}
          >
            {language.t("session.addToChat.button")}
          </Button>
        </div>
      )}
    </Show>
  )
}
