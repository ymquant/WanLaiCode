import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import type { AddonLocalArchivePreview } from "@opencode-ai/sdk/v2"
import { createSignal, For, Show, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"

function displayName(preview: AddonLocalArchivePreview) {
  return preview.display_name?.trim() || preview.name || preview.key
}

export const DialogLocalPluginArchive: Component<{
  preview: AddonLocalArchivePreview
  onConfirm: () => Promise<void> | void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onConfirm()
      dialog.close()
    } catch {
      setBusy(false)
    }
  }

  return (
    <Dialog
      fit
      title={language.t("plugins.installLocalArchive.confirm.title")}
      description={language.t("plugins.installLocalArchive.confirm.description")}
      class="w-full max-w-[620px]"
    >
      <div class="w-full max-h-[calc(100vh-96px)] overflow-y-auto px-5 pb-5 flex flex-col gap-5">
        <div class="flex items-center gap-3 min-w-0">
          <PluginLogo preview={props.preview} />
          <div class="min-w-0 flex-1">
            <div class="text-18-medium text-text-strong truncate">{displayName(props.preview)}</div>
            <div class="text-13-regular text-text-weak truncate">{props.preview.name}</div>
          </div>
          <Show when={props.preview.version}>
            <span class="text-12-regular text-text-weak px-2 py-0.5 rounded-full border border-border-weak-base shrink-0">
              v{props.preview.version}
            </span>
          </Show>
        </div>

        <div class="border border-border-weak-base rounded-xl px-5 py-4 flex flex-col gap-4">
          <Show when={props.preview.description || props.preview.long_description}>
            <Section title={language.t("plugins.installLocalArchive.confirm.about")}>
              <p class="text-13-regular text-text-base whitespace-pre-line">
                {props.preview.long_description || props.preview.description}
              </p>
            </Section>
          </Show>
          <Show when={props.preview.developer_name}>
            <Row
              label={language.t("plugins.installLocalArchive.confirm.developer", {
                name: props.preview.developer_name!,
              })}
            />
          </Show>
          <Show when={props.preview.category}>
            <Row
              label={language.t("plugins.installLocalArchive.confirm.category", { name: props.preview.category! })}
            />
          </Show>
          <Show when={(props.preview.capabilities ?? []).length > 0}>
            <Section title={language.t("plugins.installLocalArchive.confirm.capabilities")}>
              <Chips items={props.preview.capabilities ?? []} />
            </Section>
          </Show>
          <Show when={hasIncludes(props.preview)}>
            <Section title={language.t("plugins.installLocalArchive.confirm.includes")}>
              <Show when={(props.preview.manifest_apps ?? []).length > 0}>
                <Subhead label={language.t("plugins.installLocalArchive.confirm.apps")} />
                <Chips items={(props.preview.manifest_apps ?? []).map((item) => item.name)} />
              </Show>
              <Show when={(props.preview.manifest_mcp_servers ?? []).length > 0}>
                <Subhead label={language.t("plugins.installLocalArchive.confirm.mcpServers")} />
                <Chips items={(props.preview.manifest_mcp_servers ?? []).map((item) => item.name)} />
              </Show>
              <Show when={(props.preview.manifest_skills ?? []).length > 0}>
                <Subhead label={language.t("plugins.installLocalArchive.confirm.skills")} />
                <Chips
                  items={(props.preview.manifest_skills ?? []).map((item) => item.display_name?.trim() || item.name)}
                />
              </Show>
            </Section>
          </Show>
          <Show when={props.preview.has_hooks}>
            <Row label={language.t("plugins.installLocalArchive.confirm.hooks")} />
          </Show>
        </div>

        <div class="flex justify-end items-center gap-2">
          <Button type="button" variant="ghost" size="large" disabled={busy()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" size="large" disabled={busy()} onClick={() => void confirm()}>
            {busy() ? language.t("common.loading") : language.t("plugins.installLocalArchive.confirm.action")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function hasIncludes(preview: AddonLocalArchivePreview) {
  return (
    (preview.manifest_apps?.length ?? 0) > 0 ||
    (preview.manifest_mcp_servers?.length ?? 0) > 0 ||
    (preview.manifest_skills?.length ?? 0) > 0
  )
}

function Row(props: { label: string }): JSX.Element {
  return <div class="text-13-regular text-text-base">{props.label}</div>
}

function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <div class="text-13-medium text-text-strong">{props.title}</div>
      {props.children}
    </div>
  )
}

function Subhead(props: { label: string }): JSX.Element {
  return <div class="text-11-medium uppercase tracking-wide text-text-weak mt-1">{props.label}</div>
}

function Chips(props: { items: string[] }): JSX.Element {
  return (
    <div class="flex flex-wrap gap-2">
      <For each={props.items}>
        {(item) => (
          <span class="text-12-regular text-text-base px-2.5 py-0.5 rounded-lg border border-border-weak-base bg-background-stronger leading-5">
            {item}
          </span>
        )}
      </For>
    </div>
  )
}

function PluginLogo(props: { preview: AddonLocalArchivePreview }): JSX.Element {
  const label = displayName(props.preview)
  const style = props.preview.brand_color ? { "background-color": props.preview.brand_color } : undefined
  return (
    <Show
      when={props.preview.logo}
      fallback={
        <div
          class="size-12 rounded-2xl flex items-center justify-center bg-surface-base text-text-strong"
          style={style}
        >
          <Icon name="mcp" size="medium" />
        </div>
      }
    >
      <img src={props.preview.logo} alt={label} class="size-12 rounded-2xl object-cover bg-surface-base" />
    </Show>
  )
}
