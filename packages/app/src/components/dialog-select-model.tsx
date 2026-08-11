import { Component, createMemo, JSX, Show } from "solid-js"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { META_SEP, formatPrice, perMillionTokenCurrencyLabel } from "./pricing-format"
import { isFreeModel } from "./model-filter"
import { ModelListRefreshButton } from "./model-list-refresh-button"
import { modelCapabilityMetaKeys } from "./model-capability-meta"

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]
type CapabilityKey = "text" | "image" | "audio" | "video" | "pdf"

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  multiAction?: boolean
  model?: ModelState
  afterMessageID?: string
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const capabilityLabel = (value: CapabilityKey | "reasoning") => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "reasoning") return language.t("model.input.reasoning")
    return language.t("model.input.pdf")
  }

  const capabilityMeta = (item: ModelItem) => modelCapabilityMetaKeys(item).map((key) => capabilityLabel(key)).join(META_SEP)

  const rowMeta = (item: ModelItem) => {
    const pricing = item.pricing
    const rateInfo = pricing
      ? (() => {
          const label = perMillionTokenCurrencyLabel(pricing, language.t)
          if (!label) return undefined
          const { symbol, shortSuffix } = label
          return `${symbol}${formatPrice(pricing.input)}${shortSuffix}`
        })()
      : item.wanlaicode?.rate_multiplier
        ? language.t("model.rate_multiplier", { multiplier: item.wanlaicode.rate_multiplier })
        : undefined
    return [capabilityMeta(item), rateInfo].filter((v): v is string => !!v).join(META_SEP)
  }

  const models = createMemo(() => {
    const items = model
      .list()
      .filter((m) => m.provider.id !== "opencode")
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true))
    const externalModels = new Set(
      items.filter((item) => item.provider.id !== "wanlaicode").map((item) => item.id),
    )
    return items.filter(
      (item) => item.provider.id !== "wanlaicode" || !externalModels.has(item.id),
    )
  })

  return (
    <List
      plainScroll
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{
        placeholder: language.t("dialog.model.search.placeholder"),
        autofocus: true,
        action: props.action,
        multiAction: props.multiAction,
      }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={isFreeModel(item)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
          afterMessageID: props.afterMessageID,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center justify-between gap-x-3 text-13-regular">
          <div class="min-w-0 flex items-center gap-x-2">
            <span class="truncate">{i.name}</span>
            <Show when={isFreeModel(i)}>
              <Tag>{language.t("model.tag.free")}</Tag>
            </Show>
            <Show when={i.latest}>
              <Tag>{language.t("model.tag.latest")}</Tag>
            </Show>
          </div>
          <Show when={rowMeta(i)}>
            {(value) => <span class="shrink-0 text-12-regular text-text-weak">{value()}</span>}
          </Show>
        </div>
      )}
    </List>
  )
}

export type DialogSelectModelProps = { provider?: string; model?: ModelState; afterMessageID?: string }

export const DialogSelectModel: Component<DialogSelectModelProps> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const provider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => (
        <x.DialogManageModels
          select={{ provider: props.provider, model: props.model, afterMessageID: props.afterMessageID }}
        />
      ))
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList
        provider={props.provider}
        model={props.model}
        afterMessageID={props.afterMessageID}
        onSelect={() => dialog.close()}
        action={<ModelListRefreshButton />}
      />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
