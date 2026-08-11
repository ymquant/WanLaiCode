import { type JSX, For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"

type Section<K extends "organize" | "sortBy" | "show"> = {
  key: K
  title: string
  options: Array<{ value: string; label: string }>
}

// 筛选/排序下拉，三段：整理 / 排序条件 / 显示
export const FilterMenu = (props: {
  open: () => boolean
  onClose: () => void
  anchor: () => HTMLElement | undefined
}): JSX.Element => {
  const language = useLanguage()
  const layout = useLayout()
  const [pos, setPos] = createSignal<{ top: number; left: number } | undefined>()
  let menuEl: HTMLDivElement | undefined

  // 估算菜单高度（实际渲染后会再校正一次）
  const ESTIMATED_HEIGHT = 380
  const MENU_WIDTH = 200
  const GAP = 4
  const MARGIN = 8

  const updatePosition = () => {
    const el = props.anchor()
    if (!el?.isConnected) {
      props.onClose()
      return
    }
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || !layout.sidebar.opened()) {
      props.onClose()
      return
    }
    const menuHeight = menuEl?.offsetHeight ?? ESTIMATED_HEIGHT
    const spaceBelow = window.innerHeight - r.bottom - MARGIN
    const spaceAbove = r.top - MARGIN
    // 优先向下；不够就向上；都不够取空间大的一侧并贴住边界
    let top: number
    if (spaceBelow >= menuHeight + GAP) {
      top = r.bottom + GAP
    } else if (spaceAbove >= menuHeight + GAP) {
      top = r.top - menuHeight - GAP
    } else if (spaceAbove > spaceBelow) {
      top = MARGIN
    } else {
      top = Math.max(MARGIN, window.innerHeight - menuHeight - MARGIN)
    }
    const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - MENU_WIDTH - MARGIN)
    setPos({ top, left })
  }

  createEffect(() => {
    if (!props.open()) return
    layout.sidebar.width()
    if (!layout.sidebar.opened()) {
      props.onClose()
      return
    }
    updatePosition()
    requestAnimationFrame(updatePosition)
  })

  onMount(() => {
    updatePosition()
    // 渲染完成后菜单实际高度可能不同，再校正一次
    requestAnimationFrame(updatePosition)
    const onResize = () => {
      if (props.open()) updatePosition()
    }
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  const onDocClick = (e: MouseEvent) => {
    const el = props.anchor()
    const target = e.target as Node
    if (el?.contains(target)) return
    const menu = document.getElementById("codex-filter-menu")
    if (menu?.contains(target)) return
    props.onClose()
  }
  onMount(() => {
    document.addEventListener("mousedown", onDocClick)
    onCleanup(() => document.removeEventListener("mousedown", onDocClick))
  })

  const sections: [Section<"organize">, Section<"sortBy">, Section<"show">] = [
    {
      key: "organize",
      title: language.t("sidebar.filter.organize"),
      options: [
        { value: "byProject", label: language.t("sidebar.filter.organize.byProject") },
        { value: "recent", label: language.t("sidebar.filter.organize.recent") },
        { value: "chrono", label: language.t("sidebar.filter.organize.chrono") },
      ],
    },
    {
      key: "sortBy",
      title: language.t("sidebar.filter.sortBy"),
      options: [
        { value: "created", label: language.t("sidebar.filter.sortBy.created") },
        { value: "updated", label: language.t("sidebar.filter.sortBy.updated") },
      ],
    },
    {
      key: "show",
      title: language.t("sidebar.filter.show"),
      options: [
        { value: "all", label: language.t("sidebar.filter.show.all") },
        { value: "relevant", label: language.t("sidebar.filter.show.relevant") },
      ],
    },
  ]

  return (
    <Show when={props.open() && pos()}>
      <Portal>
        <div
          id="codex-filter-menu"
          ref={(el) => (menuEl = el)}
          class="fixed z-50 w-[200px] rounded-[12px] overflow-hidden"
          style={{
            top: `${pos()!.top}px`,
            left: `${pos()!.left}px`,
            "background-color": "var(--background-base, #ffffff)",
            "box-shadow":
              "0 12px 32px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.1)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden py-1.5">
            <For each={sections}>
              {(section, i) => (
                <>
                  <Show when={i() > 0}>
                    <div class="my-1.5 mx-3 h-px bg-[rgba(0,0,0,0.08)] dark:bg-[rgba(255,255,255,0.08)]" />
                  </Show>
                  <div class="px-4 pt-1.5 pb-1 text-[12px] text-text-weak">{section.title}</div>
                  <For each={section.options}>
                    {(opt) => {
                      const filter = layout.tree.filter
                      const selected = () => (filter() as Record<string, string>)[section.key] === opt.value
                      return (
                        <button
                          type="button"
                          class="mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-strong hover:bg-[rgba(0,0,0,0.04)] dark:hover:bg-[rgba(255,255,255,0.04)]"
                          onClick={() => {
                            layout.tree.setFilter(section.key, opt.value)
                          }}
                        >
                          <span class="w-4 shrink-0">
                            <Show when={selected()}>
                              <Icon name="check" size="small" class="text-icon-base" />
                            </Show>
                          </span>
                          <span class="min-w-0 flex-1 truncate">{opt.label}</span>
                        </button>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
