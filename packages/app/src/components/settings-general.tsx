import { Component, Show, createMemo, createResource, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useIssueReport } from "@/context/issue-report"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import {
  useSettings,
} from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { SettingsList } from "./settings-list"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const issueReport = useIssueReport()
  const settings = useSettings()

  const [store, setStore] = createStore({
    checking: false,
  })

  const desktop = createMemo(() => platform.platform === "desktop")

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions = platform.updateAndRestart
          ? [
              {
                label: language.t("toast.update.action.installRestart"),
                onClick: async () => {
                  await platform.updateAndRestart!()
                },
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]
          : [
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  const globalSync = useGlobalSync()
  const globalSdk = useGlobalSDK()

  // 响应式登录态：用于门控"仅登录可见"的 UI（如内测版开关）。
  // resource 拿到结果后顺带执行启动同步 channel 逻辑，省去 onMount 里的第二次 status 调用。
  const [wanlaicodeStatus] = createResource(() =>
    globalSdk.client.wanlaicodeUserCenter
      .status()
      .then((res) => {
        // 启动时从服务端同步权威 channel，仅当已登录时执行，失败静默用本地缓存兜底
        if (res.data?.authenticated) {
          void globalSdk.client.wanlaicodeUserCenter.updateChannel.get().then((r) => {
            const channel = r.data?.channel
            if (channel !== "prod" && channel !== "canary") return
            settings.updates.setCanary(channel === "canary")
            void platform.setUpdateChannel?.(channel)
          })
        }
        return res.data
      })
      .catch(() => null),
  )
  const authenticated = createMemo(() => wanlaicodeStatus()?.authenticated === true)

  const [shells] = createResource(
    () =>
      globalSdk.client.pty
        .shells()
        .then((res) => res.data ?? [])
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  onMount(() => {
    void theme.loadThemes()
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => globalSync.data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = globalSync.data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })

  const followupOptions = createMemo((): { value: "queue" | "steer"; label: string }[] => [
    { value: "queue", label: language.t("settings.general.row.followup.option.queue") },
    { value: "steer", label: language.t("settings.general.row.followup.option.steer") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const listClass =
    "[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none"
  const switchClass = "settings-general-switch"
  const selectClass = "settings-general-select"

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.general")}</h3>

      <div class={listClass}>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.language.title")}
            description={language.t("settings.general.row.language.description")}
          >
            <Select
              class={selectClass}
              data-action="settings-language"
              options={languageOptions()}
              current={languageOptions().find((o) => o.value === language.locale())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && language.setLocale(option.value)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.shell.title")}
            description={language.t("settings.general.row.shell.description")}
          >
            <Select
              class={selectClass}
              data-action="settings-shell"
              options={shellOptions()}
              current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
              value={(o) => o.id}
              label={(o) => o.label}
              onSelect={(option) => {
                if (!option) return
                if (option.value === currentShell()) return
                globalSync.updateConfig({ shell: option.value })
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.followup.title")}
            description={language.t("settings.general.row.followup.description")}
          >
            <Select
              class={selectClass}
              data-action="settings-followup"
              options={followupOptions()}
              current={followupOptions().find((o) => o.value === settings.general.followup())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && settings.general.setFollowup(option.value)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.reasoningSummaries.title")}
            description={language.t("settings.general.row.reasoningSummaries.description")}
          >
            <div data-action="settings-feed-reasoning-summaries">
              <Switch
                class={switchClass}
                checked={settings.general.showReasoningSummaries()}
                onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.timestamps.title")}
            description={language.t("settings.general.row.timestamps.description")}
          >
            <div data-action="settings-feed-timestamps">
              <Switch
                class={switchClass}
                checked={settings.general.showTimestamps()}
                onChange={(checked) => settings.general.setShowTimestamps(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.translateReasoning.title")}
            description={language.t("settings.general.row.translateReasoning.description")}
          >
            <div data-action="settings-feed-translate-reasoning">
              <Switch
                class={switchClass}
                checked={settings.general.translateContent()}
                onChange={(checked) => settings.general.setTranslateContent(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.shellToolPartsExpanded.title")}
            description={language.t("settings.general.row.shellToolPartsExpanded.description")}
          >
            <div data-action="settings-feed-shell-tool-parts-expanded">
              <Switch
                class={switchClass}
                checked={settings.general.shellToolPartsExpanded()}
                onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.editToolPartsExpanded.title")}
            description={language.t("settings.general.row.editToolPartsExpanded.description")}
          >
            <div data-action="settings-feed-edit-tool-parts-expanded">
              <Switch
                class={switchClass}
                checked={settings.general.editToolPartsExpanded()}
                onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.reportIssue.title")}
            description={language.t("settings.general.row.reportIssue.description")}
          >
            <Button size="small" variant="secondary" onClick={() => issueReport.open()}>
              <Icon name="warning" size="small" />
              <span class="ml-1">{language.t("settings.general.row.reportIssue.action")}</span>
            </Button>
          </SettingsRow>
        </SettingsList>
      </div>
    </div>
  )

  const AdvancedSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.advanced")}</h3>

      <div class={listClass}>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.showFileTree.title")}
            description={language.t("settings.general.row.showFileTree.description")}
          >
            <div data-action="settings-show-file-tree">
              <Switch
                class={switchClass}
                checked={settings.general.showFileTree()}
                onChange={(checked) => settings.general.setShowFileTree(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.showNavigation.title")}
            description={language.t("settings.general.row.showNavigation.description")}
          >
            <div data-action="settings-show-navigation">
              <Switch
                class={switchClass}
                checked={settings.general.showNavigation()}
                onChange={(checked) => settings.general.setShowNavigation(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.showSearch.title")}
            description={language.t("settings.general.row.showSearch.description")}
          >
            <div data-action="settings-show-search">
              <Switch
                class={switchClass}
                checked={settings.general.showSearch()}
                onChange={(checked) => settings.general.setShowSearch(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.showTerminal.title")}
            description={language.t("settings.general.row.showTerminal.description")}
          >
            <div data-action="settings-show-terminal">
              <Switch
                class={switchClass}
                checked={settings.general.showTerminal()}
                onChange={(checked) => settings.general.setShowTerminal(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.row.showStatus.title")}
            description={language.t("settings.general.row.showStatus.description")}
          >
            <div data-action="settings-show-status">
              <Switch
                class={switchClass}
                checked={settings.general.showStatus()}
                onChange={(checked) => settings.general.setShowStatus(checked)}
              />
            </div>
          </SettingsRow>
        </SettingsList>
      </div>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <div class={listClass}>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.notifications.agent.title")}
            description={language.t("settings.general.notifications.agent.description")}
          >
            <div data-action="settings-notifications-agent">
              <Switch
                class={switchClass}
                checked={settings.notifications.agent()}
                onChange={(checked) => settings.notifications.setAgent(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.notifications.permissions.title")}
            description={language.t("settings.general.notifications.permissions.description")}
          >
            <div data-action="settings-notifications-permissions">
              <Switch
                class={switchClass}
                checked={settings.notifications.permissions()}
                onChange={(checked) => settings.notifications.setPermissions(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.notifications.errors.title")}
            description={language.t("settings.general.notifications.errors.description")}
          >
            <div data-action="settings-notifications-errors">
              <Switch
                class={switchClass}
                checked={settings.notifications.errors()}
                onChange={(checked) => settings.notifications.setErrors(checked)}
              />
            </div>
          </SettingsRow>
        </SettingsList>
      </div>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <div class={listClass}>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.sounds.agent.title")}
            description={language.t("settings.general.sounds.agent.description")}
          >
            <Select
              class={selectClass}
              data-action="settings-sounds-agent"
              {...soundSelectProps(
                () => settings.sounds.agentEnabled(),
                () => settings.sounds.agent(),
                (value) => settings.sounds.setAgentEnabled(value),
                (id) => settings.sounds.setAgent(id),
              )}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.sounds.permissions.title")}
            description={language.t("settings.general.sounds.permissions.description")}
          >
            <Select
              class={selectClass}
              data-action="settings-sounds-permissions"
              {...soundSelectProps(
                () => settings.sounds.permissionsEnabled(),
                () => settings.sounds.permissions(),
                (value) => settings.sounds.setPermissionsEnabled(value),
                (id) => settings.sounds.setPermissions(id),
              )}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.general.sounds.errors.title")}
            description={language.t("settings.general.sounds.errors.description")}
          >
            <Select
              class={selectClass}
              data-action="settings-sounds-errors"
              {...soundSelectProps(
                () => settings.sounds.errorsEnabled(),
                () => settings.sounds.errors(),
                (value) => settings.sounds.setErrorsEnabled(value),
                (id) => settings.sounds.setErrors(id),
              )}
            />
          </SettingsRow>
        </SettingsList>
      </div>
    </div>
  )

  const UpdatesSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <div class={listClass}>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.updates.row.startup.title")}
            description={language.t("settings.updates.row.startup.description")}
          >
            <div data-action="settings-updates-startup">
              <Switch
                class={switchClass}
                checked={settings.updates.startup()}
                disabled={!platform.checkUpdate}
                onChange={(checked) => settings.updates.setStartup(checked)}
              />
            </div>
          </SettingsRow>

          <Show when={authenticated()}>
            <SettingsRow
              title={language.t("settings.updates.row.canary.title")}
              description={language.t("settings.updates.row.canary.description")}
            >
              <div data-action="settings-updates-canary">
                <Switch
                  class={switchClass}
                  checked={settings.updates.canary()}
                  disabled={!platform.checkUpdate}
                  onChange={(checked) => {
                    // 乐观更新本地状态
                    settings.updates.setCanary(checked)
                    const channel = checked ? "canary" : "prod"
                    // 写后端 + 通知主进程
                    void globalSdk.client.wanlaicodeUserCenter.updateChannel
                      .set({ channel })
                      .then(() => platform.setUpdateChannel?.(channel))
                      .catch((err: unknown) => {
                        // 回滚乐观更新
                        settings.updates.setCanary(!checked)
                        const message = err instanceof Error ? err.message : String(err)
                        showToast({ title: language.t("common.requestFailed"), description: message })
                      })
                  }}
                />
              </div>
            </SettingsRow>
          </Show>

          <SettingsRow
            title={language.t("settings.general.row.releaseNotes.title")}
            description={language.t("settings.general.row.releaseNotes.description")}
          >
            <div data-action="settings-release-notes">
              <Switch
                class={switchClass}
                checked={settings.general.releaseNotes()}
                onChange={(checked) => settings.general.setReleaseNotes(checked)}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settings.updates.row.check.title")}
            description={language.t("settings.updates.row.check.description")}
          >
            <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
              {store.checking
                ? language.t("settings.updates.action.checking")
                : language.t("settings.updates.action.checkNow")}
            </Button>
          </SettingsRow>
        </SettingsList>
      </div>
    </div>
  )

  return (
    <div class="flex h-full flex-col bg-background-base">
      <style>{`
        [data-component="switch"].settings-general-switch [data-slot="switch-control"] {
          width: 40px;
          height: 24px;
          border-radius: 999px;
          border: 1px solid var(--border-weaker-base);
          background: var(--surface-weak);
          transition: background-color 150ms, border-color 150ms;
        }

        [data-component="switch"].settings-general-switch [data-slot="switch-thumb"] {
          width: 18px;
          height: 18px;
          border: none;
          border-radius: 999px;
          background: var(--surface-raised-stronger-non-alpha);
          box-shadow: 0 1px 2px color-mix(in srgb, var(--text-strong) 12%, transparent);
          transform: translateX(2px);
          transition: transform 150ms, background-color 150ms;
        }

        [data-component="switch"].settings-general-switch:hover:not([data-disabled], [data-readonly]) [data-slot="switch-control"] {
          border-color: var(--border-weak-hover);
          background: var(--surface-weaker);
        }

        [data-component="switch"].settings-general-switch[data-checked] [data-slot="switch-control"] {
          border-color: #4098ff;
          background: #4098ff;
        }

        [data-component="switch"].settings-general-switch[data-checked] [data-slot="switch-thumb"] {
          transform: translateX(18px);
          background: #ffffff;
        }

        [data-component="switch"].settings-general-switch[data-checked]:hover:not([data-disabled], [data-readonly]) [data-slot="switch-control"] {
          border-color: #2f8cff;
          background: #2f8cff;
        }

        [data-component="switch"].settings-general-switch[data-disabled] [data-slot="switch-control"] {
          border-color: var(--border-weaker-base);
          background: var(--input-disabled);
        }

        [data-component="switch"].settings-general-switch[data-disabled] [data-slot="switch-thumb"] {
          background: var(--surface-raised-stronger-non-alpha);
        }

        [data-slot="select-select-trigger"].settings-general-select {
          width: 132px;
          min-width: 132px;
          height: 28px;
          padding: 0 9px 0 10px;
          border: 0;
          border-radius: 10px;
          background: var(--surface-weak);
          gap: 8px;
          justify-content: space-between;
          text-align: left;
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-general-select [data-slot="select-select-trigger-value"] {
          flex: 1;
          text-align: left;
          color: var(--text-strong);
          font-size: 12px;
          font-weight: 400;
        }

        [data-slot="select-select-trigger"].settings-general-select [data-slot="select-select-trigger-icon"] {
          width: 14px;
          height: 14px;
          overflow: hidden;
          flex-shrink: 0;
          color: var(--icon-base);
          background: transparent;
          border-radius: 0;
        }
        [data-slot="select-select-trigger"].settings-general-select [data-slot="select-select-trigger-icon"] [data-slot="icon-svg"] {
          clip-path: none;
          transform: none;
        }

        [data-slot="select-select-trigger"].settings-general-select:hover:not(:disabled),
        [data-slot="select-select-trigger"].settings-general-select[data-expanded],
        [data-slot="select-select-trigger"].settings-general-select[data-expanded]:hover:not(:disabled) {
          background: var(--surface-weaker);
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-general-select:focus,
        [data-slot="select-select-trigger"].settings-general-select:focus-visible {
          background: var(--surface-weak);
          box-shadow: none;
        }

        .settings-general-font-size {
          width: 74px;
          min-width: 74px;
          height: 30px;
          padding: 0 8px 0 10px;
          border: 1px solid var(--border-weaker-base);
          border-radius: 10px;
          background: var(--surface-raised-stronger-non-alpha);
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 400;
          text-align: center;
          outline: none;
          box-shadow: none;
        }

        .settings-general-font-size:hover {
          border-color: var(--border-weak-hover);
          background: var(--input-hover);
        }

        .settings-general-font-size:focus,
        .settings-general-font-size:focus-visible {
          border-color: var(--border-weak-hover);
          background: var(--input-focus);
        }

        .settings-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: var(--border-weak-base) transparent;
        }

        .settings-scrollbar::-webkit-scrollbar {
          width: 10px;
        }

        .settings-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb {
          background: var(--border-weak-base);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb:hover {
          background: var(--border-weak-hover);
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      <div class="mx-auto w-full max-w-[920px] shrink-0 px-4 pt-6 pb-8 sm:px-10">
        <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
      </div>

      <div class="settings-scrollbar min-h-0 flex-1 overflow-y-auto pb-10">
        <div class="mx-auto flex w-full max-w-[920px] flex-col gap-8 px-4 sm:px-10">
          <GeneralSection />

          <NotificationsSection />

          <SoundsSection />

          <UpdatesSection />

          <Show
            when={
              desktop() && (import.meta.env.VITE_WANLAICODE_CHANNEL ?? import.meta.env.VITE_OPENCODE_CHANNEL) === "beta"
            }
          >
            <AdvancedSection />
          </Show>
        </div>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 border-b border-border-weaker-base px-4 py-4 last:border-none sm:flex-nowrap sm:px-[14px]">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
