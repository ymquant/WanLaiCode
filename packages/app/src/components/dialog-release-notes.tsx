import { createSignal, Show, For } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

export type Highlight = {
  title: string
  description: string
  media?: {
    type: "image" | "video"
    src: string
    alt?: string
  }
}

export function DialogReleaseNotes(props: { highlights: Highlight[]; version?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()
  const [index, setIndex] = createSignal(0)

  const total = () => props.highlights.length
  const last = () => Math.max(0, total() - 1)
  const feature = () => props.highlights[index()] ?? props.highlights[last()]
  const isFirst = () => index() === 0
  const isLast = () => index() >= last()
  const paged = () => total() > 1
  // 去掉前缀 v 与 dev 构建后缀，只留语义版本号
  const version = () => props.version?.replace(/^v/i, "").split("-")[0]?.trim() || undefined

  function handleNext() {
    if (isLast()) return
    setIndex(index() + 1)
  }

  function handleClose() {
    dialog.close()
  }

  function handleDisable() {
    settings.general.setReleaseNotes(false)
    handleClose()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      handleClose()
      return
    }

    if (!paged()) return
    if (e.key === "ArrowLeft" && !isFirst()) {
      e.preventDefault()
      setIndex(index() - 1)
    }
    if (e.key === "ArrowRight" && !isLast()) {
      e.preventDefault()
      setIndex(index() + 1)
    }
  }

  return (
    <Dialog size="normal" fit class="w-[min(calc(100vw-32px),460px)]">
      <div class="flex flex-col gap-5 p-6 outline-none" tabIndex={0} autofocus onKeyDown={handleKeyDown}>
        {/* 顶部：品牌色块 + 版本号 */}
        <div class="flex items-center gap-2.5">
          <span class="w-2.5 h-5 rounded-[2px] bg-[#dcde8d] shrink-0" />
          <Show
            when={version()}
            fallback={
              <span class="text-12-mono text-text-weak">{language.t("settings.general.row.releaseNotes.title")}</span>
            }
          >
            <span class="text-12-mono text-text-strong">v{version()}</span>
          </Show>
        </div>

        {/* 媒体（有则内嵌成框图，无则整块不渲染——不再留空白侧栏） */}
        <Show when={feature()?.media}>
          <div class="overflow-hidden rounded-lg border border-border-weak-base bg-surface-inset-base">
            {feature()!.media!.type === "image" ? (
              <img
                src={feature()!.media!.src}
                alt={feature()!.media!.alt ?? feature()?.title ?? language.t("dialog.releaseNotes.media.alt")}
                class="w-full max-h-52 object-cover block"
              />
            ) : (
              <video
                src={feature()!.media!.src}
                autoplay
                loop
                muted
                playsinline
                class="w-full max-h-52 object-cover block"
              />
            )}
          </div>
        </Show>

        {/* 标题 + 描述（min-h 稳定底部，翻页不跳动） */}
        <div class="flex flex-col gap-2 min-h-[60px]">
          <h1 class="text-16-medium text-text-strong">{feature()?.title ?? ""}</h1>
          <p class="text-14-regular text-text-base leading-relaxed">{feature()?.description ?? ""}</p>
        </div>

        {/* 底部：操作按钮 + 分页点 */}
        <div class="flex items-end justify-between gap-4">
          <div class="flex flex-col items-start gap-2">
            {isLast() ? (
              <Button variant="primary" size="large" onClick={handleClose}>
                {language.t("dialog.releaseNotes.action.getStarted")}
              </Button>
            ) : (
              <Button variant="secondary" size="large" onClick={handleNext}>
                {language.t("dialog.releaseNotes.action.next")}
              </Button>
            )}

            <Button variant="ghost" size="small" onClick={handleDisable}>
              {language.t("dialog.releaseNotes.action.hideFuture")}
            </Button>
          </div>

          <Show when={paged()}>
            <div class="flex items-center gap-1.5 pb-2.5">
              <For each={props.highlights}>
                {(_, i) => (
                  <button
                    type="button"
                    class="h-6 flex items-center cursor-pointer bg-transparent border-none p-0 transition-all duration-200"
                    classList={{ "w-5": i() === index(), "w-2": i() !== index() }}
                    onClick={() => setIndex(i())}
                  >
                    <div
                      class="w-full h-1 rounded-[1px] transition-colors duration-200"
                      classList={{
                        "bg-[#dcde8d]": i() === index(),
                        "bg-icon-weak-base": i() !== index(),
                      }}
                    />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
