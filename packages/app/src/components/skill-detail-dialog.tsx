import { createQuery } from "@tanstack/solid-query"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Markdown } from "@opencode-ai/ui/markdown"
import { SkillIcon } from "@opencode-ai/ui/skill-chip"
import { Switch } from "@opencode-ai/ui/switch"
import type { AddonSkillListItem } from "@opencode-ai/sdk/v2"
import { Show, type Accessor, type JSX } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"

export type AppSkillItem = {
  name: string
  description: string
  location: string
  content: string
  source?: "builtin" | "global" | "project" | "config" | "addon"
  addonName?: string
  displayName?: string
  icon?: string
}

export type SkillDirectoryItem =
  | { kind: "addon"; item: AddonSkillListItem }
  | { kind: "system"; item: AppSkillItem }

export const PERSONAL_SKILLS_ADDON_KEY = "personal-skills@personal"

export const isPersonalSkill = (item: AddonSkillListItem) => item.addon_key === PERSONAL_SKILLS_ADDON_KEY

export const skillMention = (title: string, name: string) =>
  `[${title.replace(/[[\]\\]/g, "\\$&")}](skill://${name}) `

export const directoryItemTitle = (item: SkillDirectoryItem) =>
  item.kind === "addon"
    ? item.item.display_name?.trim() || item.item.namespaced_name
    : item.item.displayName?.trim() || item.item.name

export const sortDirectorySkills = (arr: SkillDirectoryItem[]) =>
  [...arr].sort((a, b) => directoryItemTitle(a).localeCompare(directoryItemTitle(b)))

const ICON_PALETTE = [
  "bg-violet-100 dark:bg-violet-900",
  "bg-yellow-100 dark:bg-yellow-900",
  "bg-green-100 dark:bg-green-900",
  "bg-orange-100 dark:bg-orange-900",
  "bg-purple-100 dark:bg-purple-900",
  "bg-blue-100 dark:bg-blue-900",
  "bg-sky-100 dark:bg-sky-900",
  "bg-pink-100 dark:bg-pink-900",
  "bg-teal-100 dark:bg-teal-900",
  "bg-zinc-100 dark:bg-zinc-800",
]

function pickIconBg(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return ICON_PALETTE[h % ICON_PALETTE.length]
}

export function SkillDetailDialog(props: {
  item: Accessor<SkillDirectoryItem>
  pending: boolean
  onToggle: (item: AddonSkillListItem, enabled: boolean) => void
  onInstall: (item: AddonSkillListItem, installed: boolean) => void
  onTry: (name: string, title: string) => void
}): JSX.Element {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const item = () => props.item()
  const title = () => directoryItemTitle(item())
  const description = () => item().item.description
  const name = () => item().item.name
  const addonContent = createQuery(() => {
    const current = item()
    return {
      queryKey: [
        "addon",
        "skills",
        "content",
        current.kind === "addon" ? current.item.addon_key : "system",
        current.item.name,
      ],
      enabled: current.kind === "addon",
      queryFn: async () => {
        if (current.kind !== "addon") return ""
        const result = await sdk.client.addon.skillContent({
          addon_key: current.item.addon_key,
          name: current.item.name,
        })
        return result.data?.content ?? current.item.content ?? current.item.description ?? ""
      },
    }
  })
  const content = () => {
    const current = item()
    if (current.kind === "system") return current.item.content
    return addonContent.data ?? current.item.content ?? current.item.description ?? ""
  }
  const installed = () => {
    const current = item()
    if (current.kind === "system") return true
    return current.item.installed ?? true
  }
  const enabled = () => {
    const current = item()
    if (current.kind === "system") return true
    return current.item.enabled
  }
  const canToggle = () => item().kind === "addon"
  const canInstallOrUninstall = () => {
    const current = item()
    return current.kind === "addon" && current.item.installed !== undefined
  }
  const canTryInChat = () => installed() && enabled()
  const openInChat = () => {
    dialog.close()
    props.onTry(name(), title())
  }
  const icon = () => {
    const current = item()
    if (current.kind === "system") return current.item.icon
    return current.item.logo
  }
  const fallbackIconClass = () => {
    const current = item()
    if (current.kind !== "addon") return "bg-surface-base"
    if (current.item.brand_color) return ""
    return pickIconBg(current.item.addon_name)
  }
  const fallbackIconStyle = () => {
    const current = item()
    if (current.kind !== "addon" || !current.item.brand_color) return undefined
    return { "background-color": current.item.brand_color }
  }

  return (
    <Dialog fit class="codex-dialog w-[720px] max-w-[calc(100vw-48px)] max-h-[calc(100vh-96px)] !min-h-0 !overflow-hidden">
      <div class="max-h-[calc(100vh-96px)] flex flex-col overflow-hidden">
        <div class="shrink-0 flex items-start justify-between gap-4 p-6 pb-4">
          <div class="flex flex-col gap-6 min-w-0">
            <Show
              when={icon()}
              fallback={
                <div
                  class={`size-12 rounded-full flex items-center justify-center shrink-0 text-text-strong ${fallbackIconClass()}`}
                  style={fallbackIconStyle()}
                >
                  <SkillIcon class="size-6" />
                </div>
              }
            >
              <img
                src={icon()}
                alt={title()}
                class="size-12 rounded-full shrink-0 object-cover bg-surface-base"
                loading="lazy"
              />
            </Show>
            <div class="min-w-0">
              <div class="flex items-baseline gap-2 min-w-0">
                <h2 class="text-20-medium text-text-strong truncate">{title()}</h2>
                <span class="text-20-regular text-text-weak">{language.t("plugins.detail.includes.skill")}</span>
              </div>
              <div class="mt-2 text-15-regular text-text-weak truncate">{description()}</div>
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <Show when={canToggle()}>
              <Switch
                class="switch-pill skill-detail-switch"
                hideLabel
                checked={enabled()}
                disabled={props.pending || !installed()}
                onChange={(checked) => {
                  const current = item()
                  if (current.kind === "addon") props.onToggle(current.item, checked)
                }}
              >
                {language.t("plugins.skills.enable")}
              </Switch>
            </Show>
            <button
              type="button"
              class="size-8 rounded-full flex items-center justify-center text-text-weak hover:text-text-strong hover:bg-surface-base transition-colors"
              aria-label={language.t("common.close")}
              onClick={() => dialog.close()}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 px-6 pb-4 overflow-y-auto">
          <div class="rounded-xl border border-border-weak-base bg-surface-base/40 p-5">
            <Markdown text={content()} cacheKey={`skill-detail:${item().kind}:${name()}`} />
          </div>
        </div>

        <div class="shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t border-border-weak-base bg-background-stronger">
          <Show when={canInstallOrUninstall() && installed()}>
            <button
              type="button"
              class="h-8 px-3 rounded-md bg-red-500/10 text-13-medium text-red-600 hover:bg-red-500/15 disabled:opacity-50"
              disabled={props.pending}
              onClick={() => {
                const current = item()
                if (current.kind === "addon") props.onInstall(current.item, false)
              }}
            >
              {language.t("plugins.detail.uninstall")}
            </button>
          </Show>
          <Show when={canInstallOrUninstall() && !installed()}>
            <button
              type="button"
              class="h-8 px-3 rounded-md bg-surface-base text-13-medium text-text-strong hover:bg-surface-base/80 disabled:opacity-50"
              disabled={props.pending}
              onClick={() => {
                const current = item()
                if (current.kind === "addon") props.onInstall(current.item, true)
              }}
            >
              {language.t("plugins.install")}
            </button>
          </Show>
          <div class="flex-1" />
          <Show when={canTryInChat()}>
            <button
              type="button"
              class="h-9 px-3 rounded-xl bg-text-strong text-background-stronger text-14-medium inline-flex items-center hover:opacity-90 transition-opacity"
              onClick={openInChat}
            >
              <span>{language.t("plugins.hero.tryInChat")}</span>
            </button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
