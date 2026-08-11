import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { createSignal, onMount, Show } from "solid-js"

type Payload = {
  src: string
  alt?: string
}

export function ImagePreviewPage() {
  const [payload, setPayload] = createSignal<Payload | undefined>()
  const [missing, setMissing] = createSignal(false)

  onMount(() => {
    const id = new URLSearchParams(location.search).get("id")
    if (!id) {
      setMissing(true)
      return
    }
    try {
      const key = `image-preview:${id}`
      const raw = sessionStorage.getItem(key)
      sessionStorage.removeItem(key)
      if (!raw) {
        setMissing(true)
        return
      }
      setPayload(JSON.parse(raw) as Payload)
    } catch {
      setMissing(true)
    }
  })

  return (
    <Show
      when={payload()}
      fallback={
        <div class="h-dvh w-screen flex items-center justify-center bg-background-base text-14-regular text-text-weak">
          {missing() ? "Image preview unavailable." : ""}
        </div>
      }
    >
      {(data) => (
        <ImagePreview
          mode="window"
          src={data().src}
          alt={data().alt}
          onClose={() => window.close()}
        />
      )}
    </Show>
  )
}
