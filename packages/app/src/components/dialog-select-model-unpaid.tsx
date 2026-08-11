import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Component, createEffect, createMemo, createResource, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocal } from "@/context/local"
import { useRefreshProviders } from "@/hooks/refresh-providers-query"
import { useProviders } from "@/hooks/use-providers"
import { ModelTooltip } from "./model-tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { isFreeModel } from "./model-filter"
import { shouldShowWanlaiCodeLoginError } from "./wanlaicode-login-state"

type ModelState = ReturnType<typeof useLocal>["model"]

export const DialogSelectModelUnpaid: Component<{ model?: ModelState; afterMessageID?: string }> = (props) => {
  const model = props.model ?? useLocal().model
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const providers = useProviders()
  const providerRefresh = useRefreshProviders()
  const language = useLanguage()
  const [status] = createResource(() =>
    globalSDK.client.wanlaicodeUserCenter
      .status()
      .then((result) => result.data)
      .catch(() => undefined),
  )

  const wanlaiCodeModels = createMemo(() => {
    const listed = model.list().filter((m) => m.provider.id === "wanlaicode")
    const provider = providers.all().find((item) => item.id === "wanlaicode")
    // provider.connected 旧数据可能暂时漏掉 WanlaiCode；unpaid 弹窗仍应展示 all 里已经下发的内置模型。
    const fallback = provider
      ? Object.values(provider.models).map((item) => ({
          ...item,
          provider,
          latest: item.name.includes("(latest)"),
          name: item.name.replace("(latest)", "").trim(),
        }))
      : []
    // 这条未开套餐路径的旧行为是直接展示内置可用模型，不受“管理模型”里的显隐状态影响；
    // 否则用户本地持久化了 hide 或精选规则未命中时，会把 WanlaiCode 提供的模型整栏过滤成空。
    return listed.length > 0 ? listed : fallback
  })

  let providerRefreshRequested = false
  createEffect(() => {
    if (providerRefreshRequested) return
    if (status()?.authenticated !== true) return
    if (wanlaiCodeModels().length > 0) return
    providerRefreshRequested = true
    void providerRefresh.refresh()
  })

  const all = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider model={model} onBack={() => dialog.show(() => <DialogSelectModelUnpaid model={model} afterMessageID={props.afterMessageID} />)} />)
    })
  }

  let missingApiKeyToastShown = false
  createEffect(() => {
    if (missingApiKeyToastShown) return
    const allProviders = providers.all()
    const connected = new Set(providers.connected().map((p) => p.id))
    if (
      !shouldShowWanlaiCodeLoginError({
        providerReady: allProviders.length > 0,
        connected: connected.has("wanlaicode"),
        hasModels: wanlaiCodeModels().length > 0,
        authenticated: status()?.authenticated,
        authLoading: status.loading,
      })
    )
      return
    missingApiKeyToastShown = true
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("dialog.provider.wanlaicode.error.missingApiKey"),
    })
  })

  let listRef: ListRef | undefined
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="[&_[data-slot=dialog-body]]:flex [&_[data-slot=dialog-body]]:flex-col"
    >
      <div class="flex flex-col gap-3 px-2.5 flex-1 min-h-0" onKeyDown={handleKeyDown}>
        <div class="text-14-medium text-text-base px-2.5">
          {language.t("dialog.model.unpaid.wanlaicodeModels.title")}
        </div>
        <List
          class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:overflow-visible"
          ref={(ref) => (listRef = ref)}
          items={wanlaiCodeModels}
          current={model.current()}
          emptyMessage={
            status.loading || providerRefresh.refreshing()
              ? language.t("common.loading")
              : language.t("dialog.model.empty")
          }
          key={(x) => `${x.provider.id}:${x.id}`}
          itemWrapper={(item, node) => (
            <Tooltip
              class="w-full"
              placement="right-start"
              gutter={12}
              value={
                <ModelTooltip
                  model={item}
                  latest={item.latest}
                  free={isFreeModel(item)}
                />
              }
            >
              {node}
            </Tooltip>
          )}
          onSelect={(x) => {
            model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
              recent: true,
              afterMessageID: props.afterMessageID,
            })
            dialog.close()
          }}
        >
          {(i) => (
            <div class="w-full flex items-center gap-x-2.5">
              <span>{i.name}</span>
              <Show when={isFreeModel(i)}>
                <Tag>{language.t("model.tag.free")}</Tag>
              </Show>
              <Show when={i.latest}>
                <Tag>{language.t("model.tag.latest")}</Tag>
              </Show>
            </div>
          )}
        </List>
      </div>
      <div class="px-1.5 pb-1.5">
        <Button
          variant="ghost"
          class="w-full justify-start px-[11px] py-3.5 gap-4.5 text-14-medium"
          icon="dot-grid"
          onClick={all}
        >
          {language.t("dialog.provider.viewAll")}
        </Button>
      </div>
    </Dialog>
  )
}
