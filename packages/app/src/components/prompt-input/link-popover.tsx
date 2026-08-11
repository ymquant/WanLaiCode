import { Show, type Accessor, createEffect, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"

export type PromptLinkPopoverMode = "actions" | "text" | "url"

export type PromptLinkPopoverDraft = {
  element: HTMLElement
  displayText: string
  href: string
  /** 裸 URL 编辑地址时需要同步更新显示文字，并继续按纯文本格式提交。 */
  plain: boolean
  mode: PromptLinkPopoverMode
  value: string
  showHrefError: boolean
}

export function resolvePromptLinkSave(
  draft: Pick<PromptLinkPopoverDraft, "displayText" | "href" | "plain" | "mode" | "value">,
  normalizeHref: (value: string) => string | undefined,
) {
  if (draft.mode === "actions") return
  const value = draft.value.trim()
  if (draft.mode === "text") {
    if (!value) return
    // 自定义显示文字后不再是裸 URL，提交时必须保留 Markdown 链接结构。
    return { displayText: value, href: draft.href, plain: false, invalid: false }
  }
  if (!value) return { displayText: draft.displayText, href: null, plain: false, invalid: false }
  const href = normalizeHref(value)
  if (!href) return { invalid: true } as const
  // 裸 URL 的地址和可见文字是同一个用户输入；命名链接则只替换目标地址。
  return {
    displayText: draft.plain ? value : draft.displayText,
    href,
    plain: draft.plain,
    invalid: false,
  }
}

type PromptLinkPopoverProps = {
  draft: Accessor<PromptLinkPopoverDraft | undefined>
  onChange: (draft: PromptLinkPopoverDraft) => void
  onClose: () => void
  onOpen: () => void
  onSave: (displayText: string, href: string | null, plain: boolean) => void
  normalizeHref: (value: string) => string | undefined
  labels: {
    open: string
    editText: string
    editLink: string
    text: string
    url: string
    save: string
    remove: string
    placeholder: string
  }
}

export function PromptLinkPopover(props: PromptLinkPopoverProps) {
  let root: HTMLDivElement | undefined
  const [position, setPosition] = createSignal({ left: 0, top: 0 })

  const updatePosition = () => {
    const element = props.draft()?.element
    if (!element?.isConnected) {
      props.onClose()
      return
    }
    const rect = element.getBoundingClientRect()
    const width = props.draft()?.mode === "actions" ? 360 : 432
    setPosition({
      left: Math.max(8, Math.min(rect.left - 14, window.innerWidth - width - 8)),
      top: Math.max(8, rect.top - 8),
    })
  }

  createEffect(() => {
    // 浮层跟随锚点滚动，点击外部或按 Esc 时关闭，避免编辑状态残留在输入框里。
    const draft = props.draft()
    if (!draft) return
    updatePosition()

    const close = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root?.contains(target) || draft.element.contains(target)) return
      props.onClose()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      props.onClose()
    }
    window.addEventListener("scroll", updatePosition, true)
    window.addEventListener("resize", updatePosition)
    window.addEventListener("pointerdown", close, true)
    window.addEventListener("keydown", keydown, true)
    onCleanup(() => {
      window.removeEventListener("scroll", updatePosition, true)
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("keydown", keydown, true)
    })
  })

  const save = () => {
    // 统一解析编辑结果，保证裸 URL 与命名链接分别维持正确的显示和提交语义。
    const draft = props.draft()
    if (!draft) return
    const result = resolvePromptLinkSave(draft, props.normalizeHref)
    if (!result) return
    if (result.invalid) {
      props.onChange({ ...draft, showHrefError: true })
      return
    }
    props.onSave(result.displayText, result.href, result.plain)
  }

  const buttonClass =
    "inline-flex h-9 items-center gap-2 rounded-full px-3 text-14-regular text-text-strong transition-colors hover:bg-surface-raised-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-icon-info-active"
  const inputClass =
    "min-w-0 flex-1 bg-transparent px-1 text-14-regular text-text-strong outline-none placeholder:text-text-weak"

  return (
    <Show when={props.draft()}>
      {(draft) => (
        <Portal>
          <div
            ref={(element) => (root = element)}
            data-component="prompt-link-popover"
            // 使用实际存在的弱边框主题变量，避免无效颜色回退成深色模式下的白色文字色。
            class="pointer-events-auto fixed z-[100] flex -translate-y-full items-center rounded-full border border-border-weak-base bg-surface-raised-strong p-0.5 shadow-lg backdrop-blur-sm"
            classList={{
              "justify-center": draft().mode === "actions",
              "w-[27rem] max-w-[calc(100vw-16px)] gap-1.5 pl-3": draft().mode !== "actions",
              "border-icon-info-active": draft().mode === "text",
              "border-icon-critical-base": draft().mode === "url" && draft().showHrefError,
            }}
            style={{ left: `${position().left}px`, top: `${position().top}px` }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Show
              when={draft().mode === "actions"}
              fallback={
                <>
                  <input
                    ref={(element) => {
                      if (draft().mode !== "actions") requestAnimationFrame(() => element.focus())
                    }}
                    aria-label={draft().mode === "text" ? props.labels.text : props.labels.url}
                    aria-invalid={draft().mode === "url" && draft().showHrefError}
                    autocomplete="off"
                    class={inputClass}
                    placeholder={draft().mode === "text" ? props.labels.text : props.labels.placeholder}
                    value={draft().value}
                    onInput={(event) =>
                      props.onChange({ ...draft(), value: event.currentTarget.value, showHrefError: false })
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      save()
                    }}
                  />
                  <button
                    type="button"
                    class={buttonClass}
                    aria-label={
                      draft().mode === "url" && draft().value.trim().length === 0
                        ? props.labels.remove
                        : props.labels.save
                    }
                    onClick={save}
                  >
                    <Icon
                      name={draft().mode === "url" && draft().value.trim().length === 0 ? "close-small" : "check-small"}
                      size="small"
                    />
                  </button>
                </>
              }
            >
              <button type="button" class={buttonClass} onClick={props.onOpen}>
                <Icon name="open-file" size="small" />
                {props.labels.open}
              </button>
              <button
                type="button"
                class={buttonClass}
                onClick={() =>
                  props.onChange({ ...draft(), mode: "text", value: draft().displayText, showHrefError: false })
                }
              >
                <Icon name="pencil-line" size="small" />
                {props.labels.editText}
              </button>
              <button
                type="button"
                class={buttonClass}
                onClick={() => props.onChange({ ...draft(), mode: "url", value: draft().href, showHrefError: false })}
              >
                <Icon name="link" size="small" />
                {props.labels.editLink}
              </button>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  )
}
