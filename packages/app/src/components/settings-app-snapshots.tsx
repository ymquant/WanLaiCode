import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, onCleanup, onMount, Show, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform, type AppSnapshotPermission, type AppSnapshotPermissionState } from "@/context/platform"
import { useSettings } from "@/context/settings"

const unavailable: AppSnapshotPermissionState = {
  supported: false,
  accessibility: "unavailable",
  screen: "unavailable",
  shortcut: "unavailable",
}

const SettingsRow: Component<{ title: string; description: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-wrap items-center gap-4 border-b border-border-weaker-base px-4 py-4 last:border-none sm:flex-nowrap">
    <div class="min-w-0 flex-1">
      <div class="text-14-medium text-text-strong">{props.title}</div>
      <div class="mt-0.5 text-12-regular text-text-weak">{props.description}</div>
    </div>
    <div class="flex w-full shrink-0 justify-end sm:w-auto">{props.children}</div>
  </div>
)

export const SettingsAppSnapshots: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const [state, setState] = createStore({
    requesting: undefined as AppSnapshotPermission | undefined,
    capturing: false,
  })
  const [permissions, permissionActions] = createResource(
    () => platform.getAppSnapshotPermissions?.() ?? Promise.resolve(unavailable),
  )

  onMount(() => {
    const refresh = () => void permissionActions.refetch()
    window.addEventListener("focus", refresh)
    onCleanup(() => window.removeEventListener("focus", refresh))
  })

  const shortcutOptions = createMemo(() => [
    { value: "command" as const, label: "⌘ + ⌘" },
    { value: "option" as const, label: "⌥ + ⌥" },
    { value: "control" as const, label: "⌃ + ⌃" },
    { value: "disabled" as const, label: language.t("appSnapshots.shortcut.disabled") },
  ])
  const targetOptions = createMemo(() => [
    { value: "automatic" as const, label: language.t("appSnapshots.target.automatic") },
    { value: "current" as const, label: language.t("appSnapshots.target.current") },
    { value: "new" as const, label: language.t("appSnapshots.target.new") },
  ])

  const permissionLabel = (value: string) =>
    value === "granted"
      ? language.t("appSnapshots.permission.granted")
      : value === "not-determined"
        ? language.t("appSnapshots.permission.notDetermined")
        : value === "unavailable"
          ? language.t("appSnapshots.permission.unavailable")
          : language.t("appSnapshots.permission.required")

  const request = async (permission: AppSnapshotPermission) => {
    if (!platform.requestAppSnapshotPermission) return
    setState("requesting", permission)
    const result = await platform.requestAppSnapshotPermission(permission).catch(() => undefined)
    if (result) permissionActions.mutate(result)
    setState("requesting", undefined)
  }

  const capture = async () => {
    if (!platform.captureAppSnapshot) return
    setState("capturing", true)
    await platform.captureAppSnapshot().catch(() => {
      showToast({ variant: "error", title: language.t("appSnapshots.error.capture") })
    })
    setState("capturing", false)
  }

  const selectClass =
    "min-w-[180px] [&_[data-slot=select-select-trigger]]:h-9 [&_[data-slot=select-select-trigger]]:rounded-full"

  return (
    <div class="settings-scrollbar mx-auto h-full w-full overflow-y-auto px-6 pb-12 md:px-10">
      <div class="sticky top-0 z-10 bg-background-base pt-6 pb-7">
        <h2 class="text-24-medium text-text-strong">{language.t("appSnapshots.title")}</h2>
      </div>

      <div class="flex flex-col gap-8">
        <section class="flex min-h-24 items-center gap-4 rounded-lg border border-border-weaker-base bg-surface-base px-5 py-4">
          <div class="flex size-13 shrink-0 items-center justify-center rounded-lg bg-[#eef7ff] text-[#1683e8] dark:bg-[#102d46] dark:text-[#67b7ff]">
            <Icon name="window-cursor" size="large" />
          </div>
          <div class="min-w-0">
            <div class="text-16-medium text-text-strong">{language.t("appSnapshots.hero.title")}</div>
            <div class="mt-1 text-13-regular text-text-weak">{language.t("appSnapshots.hero.description")}</div>
          </div>
        </section>

        <Show
          when={platform.os === "macos"}
          fallback={<div class="text-14-regular text-text-weak">{language.t("appSnapshots.error.unsupported")}</div>}
        >
          <section>
            <h3 class="mb-2 text-14-medium text-text-strong">{language.t("appSnapshots.section.behavior")}</h3>
            <div class="rounded-lg bg-surface-base px-1">
              <SettingsRow
                title={language.t("appSnapshots.shortcut.title")}
                description={language.t("appSnapshots.shortcut.description")}
              >
                <Select
                  class={selectClass}
                  options={shortcutOptions()}
                  current={shortcutOptions().find((item) => item.value === settings.appSnapshots.shortcut())}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => item && settings.appSnapshots.setShortcut(item.value)}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </SettingsRow>
              <SettingsRow
                title={language.t("appSnapshots.target.title")}
                description={language.t("appSnapshots.target.description")}
              >
                <Select
                  class={selectClass}
                  options={targetOptions()}
                  current={targetOptions().find((item) => item.value === settings.appSnapshots.target())}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => item && settings.appSnapshots.setTarget(item.value)}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </SettingsRow>
              <SettingsRow
                title={language.t("appSnapshots.sound.title")}
                description={language.t("appSnapshots.sound.description")}
              >
                <Switch
                  checked={settings.appSnapshots.playSound()}
                  onChange={(checked) => settings.appSnapshots.setPlaySound(checked)}
                />
              </SettingsRow>
            </div>
          </section>

          <section>
            <h3 class="mb-2 text-14-medium text-text-strong">{language.t("appSnapshots.section.permissions")}</h3>
            <div class="rounded-lg bg-surface-base px-1">
              <SettingsRow
                title={language.t("appSnapshots.permission.accessibility.title")}
                description={language.t("appSnapshots.permission.accessibility.description")}
              >
                <div class="flex items-center gap-3">
                  <span
                    class="text-12-medium"
                    classList={{
                      "text-green-600 dark:text-green-400": permissions()?.accessibility === "granted",
                      "text-text-weak": permissions()?.accessibility !== "granted",
                    }}
                  >
                    {permissionLabel(permissions()?.accessibility ?? "unavailable")}
                  </span>
                  <Show when={permissions()?.accessibility !== "granted"}>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={state.requesting !== undefined}
                      onClick={() => void request("accessibility")}
                    >
                      {state.requesting === "accessibility"
                        ? language.t("common.loading")
                        : language.t("appSnapshots.permission.allow")}
                    </Button>
                  </Show>
                </div>
              </SettingsRow>
              <SettingsRow
                title={language.t("appSnapshots.permission.screen.title")}
                description={language.t("appSnapshots.permission.screen.description")}
              >
                <div class="flex items-center gap-3">
                  <span
                    class="text-12-medium"
                    classList={{
                      "text-green-600 dark:text-green-400": permissions()?.screen === "granted",
                      "text-text-weak": permissions()?.screen !== "granted",
                    }}
                  >
                    {permissionLabel(permissions()?.screen ?? "unavailable")}
                  </span>
                  <Show when={permissions()?.screen !== "granted"}>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={state.requesting !== undefined}
                      onClick={() => void request("screen")}
                    >
                      {state.requesting === "screen"
                        ? language.t("common.loading")
                        : language.t("appSnapshots.permission.allow")}
                    </Button>
                  </Show>
                </div>
              </SettingsRow>
            </div>
          </section>

          <div class="flex items-center justify-between gap-4 border-t border-border-weaker-base pt-5">
            <div class="text-12-regular text-text-weak">{language.t("appSnapshots.test.description")}</div>
            <Button size="small" variant="secondary" disabled={state.capturing} onClick={() => void capture()}>
              {state.capturing ? language.t("appSnapshots.test.capturing") : language.t("appSnapshots.test.action")}
            </Button>
          </div>
        </Show>
      </div>
    </div>
  )
}
