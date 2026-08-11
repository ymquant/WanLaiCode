import {
  createContext,
  createSignal,
  type ParentProps,
  Show,
  useContext,
} from "solid-js"
import { Portal } from "solid-js/web"
import { ImagePreview, type ImagePreviewProps } from "../components/image-preview"

export type ImagePreviewShowProps = Omit<ImagePreviewProps, "onClose" | "mode">

type OpenInOsWindow = (props: ImagePreviewShowProps) => boolean | Promise<boolean>

function init(openInOsWindow?: OpenInOsWindow) {
  const [active, setActive] = createSignal<ImagePreviewShowProps | undefined>()

  return {
    get active() {
      return active()
    },
    show(props: ImagePreviewShowProps) {
      const result = openInOsWindow?.(props)
      if (result === true) return
      if (result && typeof result === "object" && "then" in result) {
        void result.then((opened) => {
          if (!opened) setActive(props)
        })
        return
      }
      setActive(props)
    },
    close() {
      setActive(undefined)
    },
  }
}

const Context = createContext<ReturnType<typeof init>>()

export type ImagePreviewProviderProps = ParentProps & {
  openInOsWindow?: OpenInOsWindow
}

export function ImagePreviewProvider(props: ImagePreviewProviderProps) {
  const ctx = init(props.openInOsWindow)
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <Show when={typeof document !== "undefined" && ctx.active}>
        <Portal mount={document.body}>
          <ImagePreview {...ctx.active!} onClose={ctx.close} />
        </Portal>
      </Show>
    </Context.Provider>
  )
}

export function useImagePreview() {
  const ctx = useContext(Context)

  if (!ctx) {
    throw new Error("useImagePreview must be used within an ImagePreviewProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    show(props: ImagePreviewShowProps) {
      ctx.show(props)
    },
    close() {
      ctx.close()
    },
  }
}
