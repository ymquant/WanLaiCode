import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { JSXElement, ParentProps } from "solid-js"
import { Show } from "solid-js"
import "./codex.css"

// Codex 风弹层:直接用 Kobalte.Content + 自有 .cdx 样式,
// 绕开万来Code 共享 Dialog 的 oc-2 外观,无障碍/portal/Escape 仍由 dialog context 提供。
export function CdxModal(
  props: ParentProps<{
    title: JSXElement
    action?: JSXElement
    maxWidth: number
  }>,
) {
  return (
    <Kobalte.Content
      class="cdx cdx-modal"
      style={{ width: "calc(100vw - 48px)", "max-width": `${props.maxWidth}px` }}
      onOpenAutoFocus={(e) => {
        const target = e.currentTarget as HTMLElement | null
        const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
        if (autofocusEl) {
          e.preventDefault()
          autofocusEl.focus()
        }
      }}
    >
      <div class="cdx-modal__header">
        <Kobalte.Title class="cdx-modal__title" as="div">
          {props.title}
        </Kobalte.Title>
        <Show when={props.action}>{props.action}</Show>
      </div>
      <div class="cdx-modal__body">{props.children}</div>
    </Kobalte.Content>
  )
}

// 关闭图标按钮
export function CdxClose(props: { onClick: () => void }) {
  return (
    <button type="button" class="cdx-iconbtn" aria-label="close" onClick={props.onClick}>
      <Icon name="close" size="small" />
    </button>
  )
}

// 内联图标(共享 Icon 集没有 pause/trash,这里自绘)
export function CdxPauseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      <path d="M7.25 4.5v11M12.75 4.5v11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  )
}

export function CdxTrashGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      <path
        d="M3.75 5.75h12.5M8 5.5V4.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75V5.5M6 5.75l.75 10.25a1 1 0 0 0 1 .92h4.5a1 1 0 0 0 1-.92L14 5.75"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

// 删除确认弹窗(对照 Codex deleteConfirm)
export function CdxConfirm(props: {
  title: string
  name?: string
  body: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
}) {
  const dialog = useDialog()
  return (
    <CdxModal maxWidth={420} title={props.title} action={<CdxClose onClick={() => dialog.close()} />}>
      <div class="cdx-confirm">
        <Show when={props.name}>
          <div class="cdx-confirm__name">{props.name}</div>
        </Show>
        <div class="cdx-confirm__body">{props.body}</div>
        <div class="cdx-confirm__footer">
          <button type="button" class="cdx-btn cdx-btn--ghost" onClick={() => dialog.close()}>
            {props.cancelLabel}
          </button>
          <button
            type="button"
            class="cdx-btn cdx-btn--danger"
            onClick={() => {
              props.onConfirm()
              dialog.close()
            }}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </CdxModal>
  )
}
