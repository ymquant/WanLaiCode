import { showToast } from "@opencode-ai/ui/toast"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform, type AppSnapshotCapture } from "@/context/platform"
import { usePrompt, type ImageAttachmentPart } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { appSnapshotDataUrl } from "./app-snapshot-data-url"

type SnapshotScope = { dir: string; id?: string }
type PendingSnapshot = { scope: SnapshotScope; attachment: ImageAttachmentPart }

const pending: PendingSnapshot[] = []
const listeners = new Set<() => void>()

const scopeMatches = (left: SnapshotScope, right: SnapshotScope) => left.dir === right.dir && left.id === right.id

const enqueue = (item: PendingSnapshot) => {
  pending.push(item)
  listeners.forEach((listener) => listener())
}

const take = (scope: SnapshotScope) => {
  const items = pending.filter((item) => scopeMatches(item.scope, scope))
  items.forEach((item) => pending.splice(pending.indexOf(item), 1))
  return items
}

const filename = (snapshot: AppSnapshotCapture) => {
  const app = snapshot.appName.replace(/[\\/:*?"<>|]/g, "-").trim() || "application"
  return `${app}-snapshot-${new Date(snapshot.capturedAt).toISOString().replaceAll(":", "-")}.png`
}

const attachment = async (snapshot: AppSnapshotCapture): Promise<ImageAttachmentPart> => ({
  type: "image",
  id: snapshot.id,
  filename: filename(snapshot),
  mime: "image/png",
  dataUrl: appSnapshotDataUrl(snapshot.image.buffer),
  appSnapshot: {
    appName: snapshot.appName,
    bundleIdentifier: snapshot.bundleIdentifier,
    windowTitle: snapshot.windowTitle,
    displayID: snapshot.displayID,
    imageWidth: snapshot.image.width,
    imageHeight: snapshot.image.height,
    accessibilityText: snapshot.accessibilityText,
    accessibilityTrusted: snapshot.accessibilityTrusted,
    textTruncated: snapshot.textTruncated,
    capturedAt: snapshot.capturedAt,
  },
})

export function AppSnapshotController() {
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const location = useLocation()
  const params = useParams()
  const navigate = useNavigate()

  const configure = () => {
    if (platform.os !== "macos" || !platform.configureAppSnapshots) return
    void platform.configureAppSnapshots({
      shortcut: settings.appSnapshots.shortcut(),
      playSound: settings.appSnapshots.playSound(),
    })
  }

  createEffect(configure)

  const currentScope = (): SnapshotScope | undefined => {
    if (!params.dir || !/^\/[^/]+\/session(?:\/|$)/.test(location.pathname)) return
    return { dir: params.dir, id: params.id } satisfies SnapshotScope
  }

  const newScope = async (): Promise<SnapshotScope | undefined> => {
    if (params.dir) return { dir: params.dir } satisfies SnapshotScope
    const directory = await platform.ensureScratchChatDir?.()
    if (!directory) return
    return { dir: base64Encode(directory) }
  }

  const accept = async (snapshot: AppSnapshotCapture) => {
    const target = settings.appSnapshots.target()
    const current = currentScope()
    const scope = target !== "new" && current ? current : await newScope()
    if (!scope) {
      showToast({ variant: "error", title: language.t("appSnapshots.error.noTarget") })
      return
    }

    enqueue({ scope, attachment: await attachment(snapshot) })
    const route = `/${scope.dir}/session${scope.id ? `/${scope.id}` : ""}`
    if (location.pathname !== route) navigate(route)
  }

  onMount(() => {
    window.addEventListener("focus", configure)
    const dispose = platform.onAppSnapshot?.((event) => {
      if (event.type === "captured") {
        void accept(event.snapshot).catch((error) => {
          showToast({
            variant: "error",
            title: language.t("appSnapshots.error.capture"),
            description: error instanceof Error ? error.message : String(error),
          })
        })
        return
      }
      if (event.type !== "error") return
      const key =
        event.code === "accessibility-permission"
          ? "appSnapshots.error.accessibility"
          : event.code === "screen-permission"
            ? "appSnapshots.error.screen"
            : event.code === "no-window"
              ? "appSnapshots.error.noWindow"
              : event.code === "timeout"
                ? "appSnapshots.error.timeout"
                : event.code === "unsupported"
                  ? "appSnapshots.error.unsupported"
                  : "appSnapshots.error.capture"
      showToast({ variant: "error", title: language.t(key), description: event.message })
    })
    onCleanup(() => {
      window.removeEventListener("focus", configure)
      dispose?.()
    })
  })

  return null
}

export function AppSnapshotPromptBridge() {
  const prompt = usePrompt()
  const params = useParams()
  const language = useLanguage()
  const [revision, setRevision] = createSignal(0)

  onMount(() => {
    const listener = () => setRevision((value) => value + 1)
    listeners.add(listener)
    onCleanup(() => listeners.delete(listener))
  })

  createEffect(() => {
    revision()
    if (!params.dir) return
    const items = take({ dir: params.dir, id: params.id })
    if (!items.length) return
    prompt.set([...prompt.current(), ...items.map((item) => item.attachment)], prompt.cursor())
    requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>('[data-component="prompt-input"][contenteditable="true"]')
      editor?.focus()
    })
    showToast({
      variant: "success",
      title: language.t("appSnapshots.captured.title"),
      description: language.t("appSnapshots.captured.description", {
        app: items.at(-1)?.attachment.appSnapshot?.appName ?? "",
      }),
    })
  })

  return null
}
