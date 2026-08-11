import { Component, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { useLanguage } from "@/context/language"
import { DialogCustomProvider } from "./dialog-custom-provider"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Dialog as Kobalte } from "@kobalte/core/dialog"

type ModelState = ReturnType<typeof import("@/context/local").useLocal>["model"]

const CUSTOM_ID = "_custom"
const HIDDEN_PROVIDER_IDS = new Set(["opencode", "opencode-go"])

export const DialogSelectProvider: Component<{ model?: ModelState; onBack?: () => void }> = (props) => {
  const dialog = useDialog()
  const providers = useProviders()
  const language = useLanguage()

  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const note = (id: string) => {
    if (id === "wanlaicode") return language.t("dialog.provider.wanlaicode.tagline")
    if (id === "anthropic") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id.startsWith("github-copilot")) return language.t("dialog.provider.copilot.note")
  }

  return (
    <Dialog
      title={language.t("command.provider.connect")}
      transition
      action={
        <Show when={props.onBack}>
          <div class="flex items-center gap-1">
            <IconButton
              icon="arrow-left"
              variant="ghost"
              aria-label={language.t("common.goBack")}
              onClick={() => props.onBack?.()}
            />
            <Kobalte.CloseButton
              data-slot="dialog-close-button"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={language.t("ui.common.close")}
            />
          </div>
        </Show>
      }
    >
      <List
        plainScroll
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(x) => x?.id}
        items={() => {
          language.locale()
          return [
            { id: CUSTOM_ID, name: customLabel() },
            ...providers.all().filter((p) => !HIDDEN_PROVIDER_IDS.has(p.id)),
          ]
        }}
        filterKeys={["id", "name"]}
        groupBy={(x) => (popularProviders.includes(x.id) ? popularGroup() : otherGroup())}
        sortBy={(a, b) => {
          if (a.id === CUSTOM_ID) return -1
          if (b.id === CUSTOM_ID) return 1
          if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
            return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
          return a.name.localeCompare(b.name)
        }}
        sortGroupsBy={(a, b) => {
          const popular = popularGroup()
          if (a.category === popular && b.category !== popular) return -1
          if (b.category === popular && a.category !== popular) return 1
          return 0
        }}
        onSelect={(x) => {
          if (!x) return
          if (x.id === CUSTOM_ID) {
            dialog.show(() => <DialogCustomProvider back="providers" />)
            return
          }
          dialog.show(() => <DialogConnectProvider provider={x.id} />)
        }}
      >
        {(i) => (
          <div class="px-1.25 flex items-center gap-x-3 min-w-0">
            <ProviderIcon data-slot="list-item-extra-icon" id={i.id} class="shrink-0" />
            <span class="shrink-0">{i.name}</span>
            <Show when={i.id === CUSTOM_ID}>
              <Tag>{language.t("settings.providers.tag.custom")}</Tag>
            </Show>
            <Show when={i.id === "wanlaicode"}>
              <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
            </Show>
            <Show when={note(i.id)}>
              {(value) => <span class="text-14-regular text-text-weak truncate min-w-0">{value()}</span>}
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
