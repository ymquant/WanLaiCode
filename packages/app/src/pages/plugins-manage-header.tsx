import { For, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { type ManageTab, type ManageTabCounts } from "./plugins-manage-model"

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

export function ManagePageHeader(props: {
  language: ReturnType<typeof useLanguage>
  counts: () => ManageTabCounts
  visibleTabs: () => ManageTab[]
  tab: () => ManageTab
  selectTab: (tab: ManageTab) => void
  search: () => string
  setSearch: (value: string) => void
  placeholder: string
}): JSX.Element {
  return (
    <>
      <h1 class="text-[30px] font-normal leading-[1.2] tracking-tight text-text-strong">
        {props.language.t("plugins.page.title")}
      </h1>
      <div class="mt-2 text-[18px] leading-6 text-text-weak">{props.language.t("plugins.manage.subtitle")}</div>

      <div class="mt-[46px] flex items-center justify-between gap-4">
        <div class="flex items-center gap-1.5 flex-wrap" role="tablist">
          <For each={props.visibleTabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={props.tab() === tab}
                class="inline-flex h-9 items-center gap-1.5 rounded-[12px] px-3 text-[18px] leading-6 transition-colors"
                classList={{
                  "bg-surface-base text-text-strong": props.tab() === tab,
                  "text-text-weak hover:text-text-base": props.tab() !== tab,
                }}
                style={NO_DRAG}
                onClick={() => props.selectTab(tab)}
              >
                <span>{props.language.t(`plugins.manage.tab.${tab}` as const)}</span>
                <span class="text-[18px] text-text-weak">{props.counts()[tab]}</span>
              </button>
            )}
          </For>
        </div>
        <div
          class="flex h-9 w-[292px] shrink-0 items-center gap-2 rounded-[12px] border border-border-weak-base bg-background-stronger px-3"
          style={NO_DRAG}
        >
          <Icon name="magnifying-glass" size="normal" class="shrink-0 text-text-weak" />
          <input
            type="text"
            class="min-w-0 flex-1 bg-transparent text-[18px] leading-6 text-text-strong outline-none placeholder:text-text-weak"
            placeholder={props.placeholder}
            value={props.search()}
            onInput={(event) => props.setSearch(event.currentTarget.value)}
            style={NO_DRAG}
          />
        </div>
      </div>
    </>
  )
}
