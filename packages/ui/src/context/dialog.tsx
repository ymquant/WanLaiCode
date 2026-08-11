import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  For,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

const DIALOG_CONTENT_SELECTOR = '[data-component="dialog"], [role="dialog"]'
const DIALOG_OVERLAY_SELECTOR = '[data-component="dialog-overlay"]'
export const DIALOG_ACTIVE_EVENT = "oc-dialog-active-change" as const

function emitDialogActive(active: boolean) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(DIALOG_ACTIVE_EVENT, { detail: { active } }))
}

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
}

const Context = createContext<ReturnType<typeof init>>()

export function cleanupOrphanedDialogPortals(active?: () => unknown) {
  if (active?.()) return
  if (typeof document === "undefined") return

  for (const overlay of document.querySelectorAll<HTMLElement>(DIALOG_OVERLAY_SELECTOR)) {
    const portal = overlay.parentElement
    if (!portal) {
      overlay.remove()
      continue
    }
    if (portal.querySelector(DIALOG_CONTENT_SELECTOR)) continue
    portal.remove()
  }
}

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }
  const active = () => stack().at(-1)

  onCleanup(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    for (const item of stack()) item.dispose()
    cleanupOrphanedDialogPortals()
    emitDialogActive(false)
  })

  const close = () => {
    const current = active()
    if (!current) {
      cleanupOrphanedDialogPortals()
      return
    }
    if (lock.value) return
    lock.value = true
    current.onClose?.()

    const id = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    if (stack().length <= 1) emitDialogActive(false)
    current.setClosing(true)

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => (items.at(-1)?.id === id ? items.slice(0, -1) : items.filter((item) => item.id !== id)))
      cleanupOrphanedDialogPortals()
      if (stack().length > 0) emitDialogActive(true)
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (active()) return
    queueMicrotask(() => cleanupOrphanedDialogPortals(active))
  })

  createEffect(() => {
    if (!active()) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const createActive = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    const id = Math.random().toString(36).slice(2)
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close()
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" onClick={close} />
              {element()}
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return undefined

    return { id, node, dispose, owner, onClose, setClosing }
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    cleanupOrphanedDialogPortals()

    for (const item of stack()) item.dispose()
    setStack([])
    cleanupOrphanedDialogPortals()

    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false

    const next = createActive(element, owner, onClose)
    if (next) {
      setStack([next])
      emitDialogActive(true)
    }
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    cleanupOrphanedDialogPortals()

    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false

    const next = createActive(element, owner, onClose)
    if (next) {
      setStack((items) => [...items, next])
      emitDialogActive(true)
    }
  }

  return {
    get active() {
      return active()
    },
    get stack() {
      return stack()
    },
    close,
    push,
    show,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    show(element: DialogElement, onClose?: () => void) {
      const base = ctx.active?.owner ?? owner
      ctx.show(element, base, onClose)
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.active?.owner ?? owner
      ctx.push(element, base, onClose)
    },
    close() {
      ctx.close()
    },
  }
}
