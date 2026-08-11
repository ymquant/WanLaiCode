import { createSignal } from "solid-js"
import { Toast, toaster } from "@opencode-ai/ui/toast"

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

export function showArchiveSessionToast(input: {
  undoLabel: string
  middleLabel: string
  settingsLabel: string
  suffixLabel: string
  onUndo: () => void | Promise<void>
  onOpenArchivedSettings: () => void
}) {
  return toaster.show((props) => {
    const [undoBusy, setUndoBusy] = createSignal(false)

    const undo = () => {
      if (undoBusy()) return
      setUndoBusy(true)
      toaster.dismiss(props.toastId)
      void Promise.resolve(input.onUndo()).finally(() => setUndoBusy(false))
    }

    return (
      <Toast
        toastId={props.toastId}
        duration={3000}
        data-variant="surface"
        class="archive-session-toast"
        style={NO_DRAG}
      >
        <Toast.Content>
          <Toast.Description>
            <span class="inline-flex flex-wrap items-baseline whitespace-nowrap font-sans text-13-regular leading-snug">
              <button
                type="button"
                data-slot="toast-archive-link"
                style={NO_DRAG}
                disabled={undoBusy()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  undo()
                }}
              >
                {input.undoLabel}
              </button>
              <span>{input.middleLabel}</span>
              <button
                type="button"
                data-slot="toast-archive-link"
                style={NO_DRAG}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  toaster.dismiss(props.toastId)
                  input.onOpenArchivedSettings()
                }}
              >
                {input.settingsLabel}
              </button>
              <span>{input.suffixLabel}</span>
            </span>
          </Toast.Description>
        </Toast.Content>
        <Toast.CloseButton style={NO_DRAG} />
      </Toast>
    )
  })
}
