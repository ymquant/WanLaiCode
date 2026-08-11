import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { usePlatform } from "@/context/platform"

// 系统三按钮（─ □ ✕）默认 CSS 占位宽度，仅在 WCO API 不可用时兜底
const DEFAULT_CONTROLS_RESERVE = 138
/** 中间拖拽区最小宽度；窗口极窄时避免 flex-1 被挤成 0 无法拖动 */
const MIN_DRAG_WIDTH = 48

type WindowControlsOverlayLike = {
  visible: boolean
  getTitlebarAreaRect: () => DOMRect
  addEventListener: (type: "geometrychange", listener: () => void) => void
  removeEventListener: (type: "geometrychange", listener: () => void) => void
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | undefined {
  if (typeof navigator === "undefined") return undefined
  const wco = (navigator as unknown as { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
  return wco && typeof wco.getTitlebarAreaRect === "function" ? wco : undefined
}

export type WindowsTitlebarProps = {
  leading?: () => JSX.Element
}

export function WindowsTitlebar(props: WindowsTitlebarProps) {
  const platform = usePlatform()

  const visible = createMemo(() => platform.platform === "desktop" && platform.os === "windows")

  // 通过 WCO API 动态测量系统按钮（─ □ ✕）在 CSS 像素下的占位
  // 渲染端 zoom / OS DPI 变化时按钮的实际 CSS 宽度都会变，写死 138 在 zoom<1 时会被覆盖
  const [controlsReserve, setControlsReserve] = createSignal(DEFAULT_CONTROLS_RESERVE)

  const measureReserve = () => {
    const wco = getWindowControlsOverlay()
    if (!wco || !wco.visible) {
      setControlsReserve(DEFAULT_CONTROLS_RESERVE)
      return
    }
    const rect = wco.getTitlebarAreaRect()
    // 可拖动区域以右就是系统按钮区；CSS 宽度 = innerWidth - (rect.x + rect.width)
    const reserve = window.innerWidth - (rect.x + rect.width)
    setControlsReserve(reserve > 0 ? reserve : DEFAULT_CONTROLS_RESERVE)
  }

  createEffect(() => {
    if (!visible()) return
    measureReserve()
    const wco = getWindowControlsOverlay()
    const handler = () => measureReserve()
    wco?.addEventListener("geometrychange", handler)
    window.addEventListener("resize", handler)
    onCleanup(() => {
      wco?.removeEventListener("geometrychange", handler)
      window.removeEventListener("resize", handler)
    })
  })

  return (
    <Show when={visible()}>
      <div
        data-component="windows-titlebar"
        class="h-9 shrink-0 flex items-center select-none"
        style={
          {
            "-webkit-app-region": "drag",
            // 默认实色；wanlai-theme + Mica 由 CSS 覆盖为半透明 tint / 透明叠层
            "background-color": "var(--windows-statusbar-bg)",
          } as Record<string, string>
        }
      >
        <Show when={props.leading}>
          <div
            class="relative z-10 flex items-center gap-1.5 pl-2 pr-1 h-full shrink-0"
            style={
              {
                "-webkit-app-region": "no-drag",
                "--icon-base": "var(--windows-statusbar-icon)",
                "--icon-disabled": "var(--windows-statusbar-icon-disabled)",
              } as Record<string, string>
            }
          >
            {props.leading!()}
          </div>
        </Show>
        <div
          class="h-full shrink-0"
          style={
            {
              "-webkit-app-region": "drag",
              "min-width": `${MIN_DRAG_WIDTH}px`,
              flex: "1 1 auto",
            } as Record<string, string>
          }
        />
        {/* 右侧 no-drag 给 Electron titleBarOverlay 系统按钮（─ □ ×）让位；宽度由 WCO API 实测，避免 zoom/DPI 下重叠 */}
        <div
          class="h-full shrink-0"
          style={
            {
              "-webkit-app-region": "no-drag",
              width: `${controlsReserve()}px`,
            } as Record<string, string>
          }
        />
      </div>
    </Show>
  )
}
