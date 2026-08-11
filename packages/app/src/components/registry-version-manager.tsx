import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { RegistryVersionOut } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { finiteNum, formatInstallCount } from "@/utils/marketplace-stats"

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

function formatVersionDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function RegistryManageVersionsButton(props: {
  visible: boolean
  loading: boolean
  onManage: () => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <Show when={props.visible}>
      <Tooltip
        placement="bottom"
        value={
          props.loading ? language.t("plugins.detail.versions.loading") : language.t("plugins.detail.versions.manage")
        }
      >
        <button
          type="button"
          class="size-8 rounded-full hover:bg-surface-base text-text-strong disabled:opacity-50 inline-flex items-center justify-center"
          style={NO_DRAG}
          disabled={props.loading}
          aria-label={language.t("plugins.detail.versions.manage")}
          onClick={props.onManage}
        >
          <Icon name="archive" size="small" class="text-icon-weak" />
        </button>
      </Tooltip>
    </Show>
  )
}

export function RegistryVersionsDialog(props: {
  versions: RegistryVersionOut[]
  deleting: boolean
  onDeleteVersion: (version: string) => Promise<void>
}): JSX.Element {
  const language = useLanguage()
  const dialog = useDialog()
  const [confirming, setConfirming] = createSignal<string>()
  const [busyVersion, setBusyVersion] = createSignal<string>()
  const sorted = createMemo(() =>
    [...props.versions].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
  )
  const deleteConfirmed = async (version: string) => {
    if (busyVersion()) return
    setBusyVersion(version)
    try {
      await props.onDeleteVersion(version)
      dialog.close()
    } catch {
      setBusyVersion(undefined)
    }
  }
  return (
    <Dialog
      title={language.t("plugins.detail.versions.title")}
      description={language.t("plugins.detail.versions.count", { count: String(sorted().length) })}
      class="w-full max-w-[560px]"
      fit
    >
      <Show
        when={sorted().length > 0}
        fallback={
          <div class="px-5 pb-5 text-13-regular text-text-weak">
            {language.t("plugins.detail.versions.empty")}
          </div>
        }
      >
        <div class="px-5 pb-5">
          <div class="border border-border-weak-base rounded-xl divide-y divide-border-weak-base overflow-hidden">
            <For each={sorted()}>
              {(version) => (
                <div class="flex items-center gap-3 px-4 py-3 bg-background-stronger">
                  <div class="size-9 rounded-lg bg-surface-base flex items-center justify-center text-text-base shrink-0">
                    <Icon name="archive" size="small" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-13-medium text-text-strong truncate">{version.version}</span>
                      <Show when={version.created_at}>
                        <span class="text-12-regular text-text-weak shrink-0">
                          {formatVersionDate(version.created_at)}
                        </span>
                      </Show>
                    </div>
                    <div class="text-12-regular text-text-weak truncate">
                      {language.t("plugins.detail.versions.meta", {
                        size: formatBytes(finiteNum(version.size_bytes)),
                        downloads: formatInstallCount(finiteNum(version.download_count)),
                      })}
                    </div>
                  </div>
                  <Show
                    when={confirming() === version.version}
                    fallback={
                      <Tooltip placement="left" value={language.t("plugins.detail.versions.delete")}>
                        <button
                          type="button"
                          class="size-8 rounded-full hover:bg-surface-base text-icon-weak hover:text-text-danger disabled:opacity-40 inline-flex items-center justify-center"
                          disabled={props.deleting || !!busyVersion()}
                          aria-label={language.t("plugins.detail.versions.delete")}
                          onClick={() => setConfirming(version.version)}
                        >
                          <Icon name="trash" size="small" />
                        </button>
                      </Tooltip>
                    }
                  >
                    <div class="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        class="h-7 px-2 rounded-md text-12-medium text-text-weak hover:bg-surface-base disabled:opacity-40"
                        disabled={!!busyVersion()}
                        onClick={() => setConfirming(undefined)}
                      >
                        {language.t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        class="h-7 px-2 rounded-md text-12-medium bg-[#E5484D] hover:bg-[#D93D42] disabled:opacity-40"
                        style={{ color: "#FFFFFF" }}
                        disabled={props.deleting || !!busyVersion()}
                        aria-label={language.t("plugins.detail.versions.delete")}
                        onClick={() => void deleteConfirmed(version.version)}
                      >
                        {busyVersion() === version.version
                          ? language.t("common.loading")
                          : language.t("plugins.detail.versions.delete")}
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </Dialog>
  )
}
