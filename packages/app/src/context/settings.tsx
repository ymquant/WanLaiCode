import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export type AppSnapshotSettings = {
  shortcut: "command" | "option" | "control" | "disabled"
  target: "automatic" | "current" | "new"
  playSound: boolean
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    followupConfigured: boolean
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showTimestamps: boolean
    showReasoningSummaries: boolean
    translateContent: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
  }
  updates: {
    startup: boolean
    canary: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
  appSnapshots: AppSnapshotSettings
  git: {
    branchPrefix: string
    branchDetailsCardPinned: boolean
  }
  personalization: {
    /** 「自定义指令」自由文本，传给 Codex 作为额外上下文（含 commit message 生成等） */
    customInstructions: string
  }
}

export const monoDefault = "System Mono"
export const sansDefault = "Inter"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = '"Inter", "Noto Sans SC", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "queue",
    followupConfigured: false,
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showTimestamps: false,
    showReasoningSummaries: true,
    translateContent: true,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
  },
  updates: {
    startup: true,
    canary: false,
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
  appSnapshots: {
    shortcut: "command",
    target: "automatic",
    playSound: true,
  },
  git: {
    branchPrefix: "codex",
    branchDetailsCardPinned: true,
  },
  personalization: {
    customInstructions: "",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty(
        "--font-size-base",
        `${store.appearance?.fontSize ?? defaultSettings.appearance.fontSize}px`,
      )
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: createMemo(() =>
          store.general?.followupConfigured
            ? (store.general?.followup ?? defaultSettings.general.followup)
            : defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value)
          setStore("general", "followupConfigured", true)
        },
        showFileTree: withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree),
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch: withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch),
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus: withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus),
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showTimestamps: withFallback(() => store.general?.showTimestamps, defaultSettings.general.showTimestamps),
        setShowTimestamps(value: boolean) {
          setStore("general", "showTimestamps", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        translateContent: withFallback(() => store.general?.translateContent, defaultSettings.general.translateContent),
        setTranslateContent(value: boolean) {
          setStore("general", "translateContent", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
      },
      updates: {
        startup: withFallback(() => store.updates?.startup, defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
        canary: withFallback(() => store.updates?.canary, defaultSettings.updates.canary),
        setCanary(value: boolean) {
          setStore("updates", "canary", value)
        },
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
      appSnapshots: {
        shortcut: withFallback(() => store.appSnapshots?.shortcut, defaultSettings.appSnapshots.shortcut),
        setShortcut(value: AppSnapshotSettings["shortcut"]) {
          setStore("appSnapshots", "shortcut", value)
        },
        target: withFallback(() => store.appSnapshots?.target, defaultSettings.appSnapshots.target),
        setTarget(value: AppSnapshotSettings["target"]) {
          setStore("appSnapshots", "target", value)
        },
        playSound: withFallback(() => store.appSnapshots?.playSound, defaultSettings.appSnapshots.playSound),
        setPlaySound(value: boolean) {
          setStore("appSnapshots", "playSound", value)
        },
      },
      git: {
        branchPrefix: withFallback(() => store.git?.branchPrefix, defaultSettings.git.branchPrefix),
        setBranchPrefix(value: string) {
          const cleaned = value.trim().replace(/^\/+|\/+$/g, "")
          setStore("git", "branchPrefix", cleaned || defaultSettings.git.branchPrefix)
        },
        branchDetailsCardPinned: withFallback(
          () => store.git?.branchDetailsCardPinned,
          defaultSettings.git.branchDetailsCardPinned,
        ),
        setBranchDetailsCardPinned(value: boolean) {
          setStore("git", "branchDetailsCardPinned", value)
        },
      },
      personalization: {
        customInstructions: withFallback(
          () => store.personalization?.customInstructions,
          defaultSettings.personalization.customInstructions,
        ),
        setCustomInstructions(value: string) {
          setStore("personalization", "customInstructions", value)
        },
      },
    }
  },
})
