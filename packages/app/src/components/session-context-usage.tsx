import { Match, Show, Switch, createMemo } from "solid-js"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Tooltip, type TooltipProps } from "@opencode-ai/ui/tooltip"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { showToast } from "@opencode-ai/ui/toast"

import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useSessionLayout } from "@/pages/session/session-layout"

// 暂不展示上下文 Tab，下面这些 import 仅为日后恢复保留：
// import { useFile } from "@/context/file"
// import { useLayout } from "@/context/layout"
// import { createSessionTabs } from "@/pages/session/helpers"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

// 暂不展示上下文 Tab —— 占比按钮的点击行为已改为触发 /compact。
// 保留此函数以便日后需要恢复 Tab 入口时直接复用，请勿删除。
// function openSessionContext(args: {
//   view: ReturnType<ReturnType<typeof useLayout>["view"]>
//   layout: ReturnType<typeof useLayout>
//   tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
// }) {
//   if (!args.view.reviewPanel.opened()) args.view.reviewPanel.open()
//   if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
//   void args.tabs.open("context")
//   args.tabs.setActive("context")
// }

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const language = useLanguage()
  const providers = useProviders()
  const { params } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const activeModel = createMemo(() => {
    const m = local.model.current()
    if (!m) return undefined
    return { providerID: m.provider.id, modelID: m.id }
  })
  const metrics = createMemo(() => getSessionContextMetrics(messages(), providers.all(), activeModel()))
  const context = createMemo(() => metrics().context)
  const cost = createMemo(() => {
    return usd().format(metrics().totalCost)
  })

  const runCompact = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }
    await sdk.client.session.summarize({
      sessionID,
      modelID: model.id,
      providerID: model.provider.id,
    })
  }

  const circle = () => (
    <div class="flex size-6 items-center justify-center">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.usage ?? 0} />
    </div>
  )

  // indicator 模式：纯数据展示（暗底 Tooltip，无交互），保留供日后恢复 Tab 时复用。
  const indicatorTooltip = () => (
    <div class="flex min-w-[160px] flex-col gap-3 px-1 py-1.5">
      <Show when={context()}>
        {(ctx) => (
          <div class="flex flex-col">
            <span class="text-text-invert-strong text-14-medium tabular-nums leading-tight">
              {ctx().total.toLocaleString(language.intl())}
            </span>
            <div class="text-text-invert-base text-11-regular mt-0.5 flex items-center gap-1">
              <span class="tabular-nums">{ctx().usage ?? 0}%</span>
              <span class="opacity-40">·</span>
              <span>{language.t("context.usage.tokens")}</span>
            </div>
          </div>
        )}
      </Show>
      <Show when={metrics().totalCost > 0}>
        <div class="flex flex-col">
          <span class="text-text-invert-strong text-13-regular tabular-nums leading-tight">{cost()}</span>
          <span class="text-text-invert-base text-11-regular mt-0.5">{language.t("context.usage.cost")}</span>
        </div>
      </Show>
    </div>
  )

  // button 模式：仿 DropdownMenu 风格的菜单卡片（header + separator + menu item），
  // hover 即出，内部 menu item 可点击触发压缩。容器宽度由内容决定 + 整体居中。
  const hoverContent = () => (
    <div class="flex flex-col">
      <div class="flex flex-col items-center gap-1 px-3 py-1.5">
        <Show when={context()}>
          {(ctx) => (
            <div class="flex flex-col items-center">
              <span class="text-text-strong text-14-medium tabular-nums leading-tight">
                {ctx().total.toLocaleString(language.intl())}
              </span>
              <div class="text-text-base text-11-regular mt-0.5 flex items-center gap-1">
                <span class="tabular-nums">{ctx().usage ?? 0}%</span>
                <span class="opacity-40">·</span>
                <span>{language.t("context.usage.tokens")}</span>
              </div>
            </div>
          )}
        </Show>
        <Show when={metrics().totalCost > 0}>
          <div class="mt-1 flex items-baseline gap-1.5">
            <span class="text-text-strong text-13-regular tabular-nums leading-tight">{cost()}</span>
            <span class="text-text-base text-11-regular">{language.t("context.usage.cost")}</span>
          </div>
        </Show>
      </div>
      <div class="-mx-1 my-1 h-px bg-border-weak-base" />
      <button
        type="button"
        onClick={runCompact}
        class="text-text-strong text-13-regular hover:bg-surface-base-hover active:bg-surface-base-active flex w-full items-center justify-center rounded-[5px] px-3 py-1 transition-colors"
        aria-label={language.t("command.session.compact")}
      >
        {language.t("context.usage.compact.hint")}
      </button>
    </div>
  )

  return (
    <Show when={params.id}>
      <Switch>
        <Match when={variant() === "indicator"}>
          <Tooltip value={indicatorTooltip()} placement={props.placement ?? "top"}>
            {circle()}
          </Tooltip>
        </Match>
        <Match when={true}>
          <HoverCard
            trigger={circle()}
            placement={props.placement ?? "top"}
            openDelay={120}
            closeDelay={120}
            class="!min-w-0 !rounded-[10px]"
          >
            {hoverContent()}
          </HoverCard>
        </Match>
      </Switch>
    </Show>
  )
}
