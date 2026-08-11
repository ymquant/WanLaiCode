import { Button } from "@opencode-ai/ui/button"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getFilename } from "@opencode-ai/core/util/path"
import { Component, For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js"
import {
  branchSwitchErrorMessage,
  DialogBranchSwitch,
  isBranchSwitchOverwriteError,
  parseBranchSwitchOverwriteFiles,
  type BranchSwitchChange,
} from "@/components/dialog-branch-switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { unwrapSDKSafe, useUserCenterEvents, windowLimit, windowRemaining } from "@/pages/users/shared"
import { selectActiveEntitlement, type SoftwareEntitlementWindow, type TabID } from "@/pages/users/types"
import { openUserCenterOverlay } from "@/context/open-user-center"
import { pathKey } from "@/utils/path-key"
import { formatServerError } from "@/utils/server-errors"
import { isScratchSessionPath } from "@/utils/scratch"
import { envBranchIconProps, envRowEndIconClass } from "@/components/session-details-card-git-ops"

const envControlsMenuClass = "codex-chat-menu env-controls-menu"

const envRowEndIconProps = (menu: boolean, extra = "") =>
  menu ? { class: `${envRowEndIconClass} ${extra}`.trim() } : { size: "small" as const, class: `shrink-0 ${extra}`.trim() }

const envRowEndCheckName = (menu: boolean) => (menu ? "check" : "check-small")

type ControlVariant = "footer" | "menu"

const footerTriggerClass =
  "min-w-0 max-w-[240px] h-7 px-2 text-13-regular text-text-base !bg-transparent hover:!bg-surface-base-hover"
const branchFooterTriggerClass =
  "min-w-0 max-w-[200px] h-7 px-2 text-13-regular text-text-base !bg-transparent hover:!bg-surface-base-hover"
const menuTriggerClass =
  "env-row-trigger flex w-full items-center gap-2 mx-1 px-2 py-1.5 rounded-md border-0 bg-transparent text-12-regular text-text-strong hover:bg-[rgba(0,0,0,0.04)] data-[expanded]:bg-[rgba(0,0,0,0.04)] transition-colors text-left cursor-default"

export const { use: useScratchMode, provider: ScratchModeProvider } = createSimpleContext({
  name: "ScratchMode",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const platform = usePlatform()
    const layout = useLayout()
    const [scratchChatDir, setScratchChatDir] = createSignal<string | undefined>(undefined)

    void platform.ensureScratchChatDir?.()
      .then((dir) => setScratchChatDir(dir))
      .catch(() => undefined)

    const isScratchProject = (worktree: string) => {
      if (!worktree) return false
      const scratch = scratchChatDir()
      return isScratchSessionPath(worktree, scratch)
    }

    const inScratchMode = createMemo(() => {
      const root = sdk.directory || sync.project?.worktree
      return !!root && isScratchProject(root)
    })

    const newSessionProject = createMemo(() => {
      const root = sdk.directory || sync.project?.worktree
      if (!root || isScratchProject(root)) return undefined
      const list = layout.projects.list()
      const target = pathKey(root)
      const matched = list.find((project) => pathKey(project.worktree) === target)
      if (matched) {
        const name = matched.name?.trim() || getFilename(matched.worktree)
        if (name) return { name, path: matched.worktree }
      }
      const name = sync.project?.name?.trim() || getFilename(root)
      if (name) return { name, path: root }
      return undefined
    })

    const isGitProject = createMemo(() => {
      if (inScratchMode()) return false
      if (!newSessionProject()) return false
      if (sync.data.vcs?.git_installed !== true) return false
      if (sync.data.vcs?.local_git !== true) return false
      return true
    })

    return { inScratchMode, isGitProject, newSessionProject, isScratchProject, scratchChatDir, setScratchChatDir }
  },
})

function useExecutionModeMenu() {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const [balanceOpen, setBalanceOpen] = createSignal(false)
  const [balanceEntitlements, { refetch: refetchBalanceEntitlements }] = createResource(
    () => (balanceOpen() ? true : undefined),
    () => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] }),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["entitlements", "status"],
    onChange: () => {
      if (balanceOpen()) void refetchBalanceEntitlements()
    },
  })
  const balanceEntitlement = createMemo(() =>
    selectActiveEntitlement(balanceEntitlements.latest?.items ?? [], "wanlaicode"),
  )
  const quotaPercent = (window: SoftwareEntitlementWindow | null | undefined) => {
    if (balanceEntitlements.loading) return "--"
    const limit = windowLimit(window)
    if (limit <= 0) return "--"
    return `${Math.min(100, Math.round((windowRemaining(window) / limit) * 100))}%`
  }
  const quotaRefillTime = (window: SoftwareEntitlementWindow | null | undefined) => {
    if (balanceEntitlements.loading) return "--"
    if (!window?.next_refill_at) return "--"
    const date = new Date(window.next_refill_at)
    if (Number.isNaN(date.getTime())) return window.next_refill_at
    return new Intl.DateTimeFormat(language.intl(), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  }
  const openUserCenter = (tab?: TabID) => {
    openUserCenterOverlay(tab)
  }

  return {
    language,
    balanceOpen,
    setBalanceOpen,
    balanceEntitlement,
    quotaPercent,
    quotaRefillTime,
    openUserCenter,
  }
}

function useBranchPicker(onNewSessionWorktreeCreate?: () => void) {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const { isGitProject } = useScratchMode()

  const currentBranchName = createMemo(() => {
    const v = sync.data.vcs
    return v?.branch || v?.default_branch || "main"
  })

  const [branchSearch, setBranchSearch] = createSignal("")
  const [branches, setBranches] = createSignal<string[]>([])
  const [uncommittedCount, setUncommittedCount] = createSignal<number | undefined>(undefined)
  const [branchSwitching, setBranchSwitching] = createSignal<string | undefined>(undefined)

  const refreshBranches = async () => {
    if (!isGitProject()) {
      setBranches([])
      setUncommittedCount(undefined)
      return
    }
    const [branchRes, diffRes] = await Promise.allSettled([
      sdk.client.vcs.listBranches(),
      sdk.client.vcs.diff({ mode: "unstaged" }),
    ])
    if (branchRes.status === "fulfilled") {
      setBranches(Array.from(new Set(branchRes.value.data?.branches ?? [])))
    } else {
      setBranches([])
    }
    if (diffRes.status === "fulfilled") {
      setUncommittedCount(diffRes.value.data?.length ?? 0)
    } else {
      setUncommittedCount(undefined)
    }
  }

  const ric = requestIdleCallback ?? ((cb: IdleRequestCallback) => setTimeout(cb, 1))
  const cic = cancelIdleCallback ?? clearTimeout
  let branchesPrimed = false
  const idleId = ric(() => {
    branchesPrimed = true
    void refreshBranches()
  })
  onCleanup(() => cic(idleId))

  createEffect(
    on(
      () => [isGitProject(), sdk.directory, currentBranchName()] as const,
      () => {
        if (branchesPrimed) void refreshBranches()
      },
    ),
  )

  let branchRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefreshBranches = () => {
    if (branchRefreshTimer) clearTimeout(branchRefreshTimer)
    branchRefreshTimer = setTimeout(() => {
      branchRefreshTimer = undefined
      void refreshBranches()
    }, 120)
  }

  const stopBranchWatcher = sdk.event.listen((evt) => {
    if (!isGitProject()) return
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file) return
    const normalized = file.replace(/\\/g, "/")
    if (normalized.includes("/.git/") || normalized.endsWith("/.git") || normalized.startsWith(".git/")) return
    scheduleRefreshBranches()
  })
  onCleanup(() => {
    stopBranchWatcher()
    if (branchRefreshTimer) clearTimeout(branchRefreshTimer)
  })

  const loadBranchSwitchChanges = async (): Promise<BranchSwitchChange[]> => {
    const [unstaged, staged] = await Promise.allSettled([
      sdk.client.vcs.diff({ mode: "unstaged" }),
      sdk.client.vcs.diff({ mode: "staged" }),
    ])
    const map = new Map<string, BranchSwitchChange>()
    for (const res of [unstaged, staged]) {
      if (res.status !== "fulfilled") continue
      for (const row of res.value.data ?? []) {
        const prev = map.get(row.file)
        map.set(row.file, {
          file: row.file,
          additions: (prev?.additions ?? 0) + (row.additions ?? 0),
          deletions: (prev?.deletions ?? 0) + (row.deletions ?? 0),
        })
      }
    }
    return [...map.values()]
  }

  const handleSwitchBranch = async (name: string) => {
    if (!name || name === currentBranchName() || branchSwitching()) return
    setBranchSwitching(name)
    try {
      await sdk.client.vcs.switchBranch({ vcsSwitchBranchInput: { name } })
      void refreshBranches()
    } catch (err: unknown) {
      const message = branchSwitchErrorMessage(err, language.t)
      if (!isBranchSwitchOverwriteError(err, language.t)) {
        showToast({
          title: language.t("session.new.worktree.switchFailed"),
          description: message || formatServerError(err, language.t, language.t("common.requestFailed")),
        })
        return
      }
      const overwriteFiles = parseBranchSwitchOverwriteFiles(message)
      const allChanges = await loadBranchSwitchChanges()
      const conflicting =
        overwriteFiles.length > 0
          ? allChanges.filter((change) => overwriteFiles.includes(change.file))
          : allChanges
      const changes =
        conflicting.length > 0
          ? conflicting
          : overwriteFiles.map((file) => ({ file, additions: 0, deletions: 0 }))
      if (changes.length === 0) {
        showToast({ title: language.t("session.new.worktree.switchFailed"), description: message })
        return
      }
      dialog.show(() => (
        <DialogBranchSwitch
          targetBranch={name}
          changes={changes}
          onSwitched={() => void refreshBranches()}
        />
      ))
    } finally {
      setBranchSwitching(undefined)
    }
  }

  const branchMatchesSearch = (name: string) => {
    const q = branchSearch().trim().toLowerCase()
    if (!q) return true
    return name.toLowerCase().includes(q)
  }

  const uncommittedLabel = () => {
    const n = uncommittedCount()
    if (!n || n <= 0) return ""
    return language.t("session.new.worktree.uncommitted", { count: n })
  }

  return {
    language,
    isGitProject,
    currentBranchName,
    branchSearch,
    setBranchSearch,
    branches,
    branchSwitching,
    refreshBranches,
    handleSwitchBranch,
    branchMatchesSearch,
    uncommittedLabel,
    onNewSessionWorktreeCreate,
  }
}

export const ExecutionModeControl: Component<{ variant: ControlVariant }> = (props) => {
  const {
    language,
    balanceOpen,
    setBalanceOpen,
    balanceEntitlement,
    quotaPercent,
    quotaRefillTime,
    openUserCenter,
  } = useExecutionModeMenu()
  const placement = () => (props.variant === "menu" ? "right-start" : "top-start")
  const [open, setOpen] = createSignal(false)

  return (
    <DropdownMenu placement={placement()} gutter={4} open={open()} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        as={props.variant === "menu" ? "button" : Button}
        type="button"
        variant={props.variant === "menu" ? undefined : "ghost"}
        class={props.variant === "menu" ? menuTriggerClass : footerTriggerClass}
        data-action="prompt-execution-mode"
        aria-label={language.t("prompt.execution.label")}
      >
        <Icon name="computer" size="small" class="shrink-0" style="width:17px;height:17px" viewBox="0 0 1024 1024" />
        <span class="truncate">{language.t("prompt.execution.mode")}</span>
        <Show
          when={props.variant === "menu"}
          fallback={
            <Icon
              name={open() ? "chevron-up" : "chevron-down"}
              size="small"
              class="shrink-0 ml-auto"
            />
          }
        >
          <Icon name="chevron-right" {...envRowEndIconProps(true, "ml-auto rotate-90")} />
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class={
            props.variant === "menu"
              ? `${envControlsMenuClass} [&_[data-slot=dropdown-menu-item]]:pl-1`
              : "codex-chat-menu [&_[data-slot=dropdown-menu-item]]:pl-1"
          }
        >
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="!px-1 !py-1">
              {language.t("prompt.execution.label")}
            </DropdownMenu.GroupLabel>
            <DropdownMenu.Item disabled>
              <div class="flex size-5 shrink-0 items-center justify-center">
                <Icon name="terminal" size="small" class="text-icon-weak" />
              </div>
              <DropdownMenu.ItemLabel>{language.t("prompt.execution.local")}</DropdownMenu.ItemLabel>
              <Icon name={envRowEndCheckName(props.variant === "menu")} {...envRowEndIconProps(props.variant === "menu", "text-icon-weak ml-auto self-center")} />
            </DropdownMenu.Item>
            <DropdownMenu.Item closeOnSelect={false} onSelect={() => setBalanceOpen((v) => !v)}>
              <div class="flex size-5 shrink-0 items-center justify-center">
                <Icon name="status" size="small" class="text-icon-weak" />
              </div>
              <DropdownMenu.ItemLabel>{language.t("sidebar.account.balance")}</DropdownMenu.ItemLabel>
              <Icon
                name="chevron-right"
                {...envRowEndIconProps(props.variant === "menu", "text-icon-weak ml-auto self-center")}
                classList={{ "rotate-90": balanceOpen() }}
              />
            </DropdownMenu.Item>
            <Show when={balanceOpen()}>
              <div class="grid gap-1 py-1">
                <div class="flex items-center gap-2 h-8 pl-9 pr-3 text-13-regular">
                  <span class="flex-1 text-text-base">{language.t("sidebar.account.balance.fiveHours")}</span>
                  <span class="text-text-weak">
                    {language.t("users.quota.remaining", {
                      value: quotaPercent(balanceEntitlement()?.usage?.five_hour),
                    })}
                  </span>
                  <span class="text-text-weak">{quotaRefillTime(balanceEntitlement()?.usage?.five_hour)}</span>
                </div>
                <div class="flex items-center gap-2 h-8 pl-9 pr-3 text-13-regular">
                  <span class="flex-1 text-text-base">{language.t("sidebar.account.balance.sevenDays")}</span>
                  <span class="text-text-weak">
                    {language.t("users.quota.remaining", {
                      value: quotaPercent(balanceEntitlement()?.usage?.seven_day),
                    })}
                  </span>
                  <span class="text-text-weak">{quotaRefillTime(balanceEntitlement()?.usage?.seven_day)}</span>
                </div>
              </div>
              <DropdownMenu.Item class="!pl-9 !pr-3" onSelect={() => openUserCenter("quota")}>
                <DropdownMenu.ItemLabel>{language.t("sidebar.account.balance.learnMore")}</DropdownMenu.ItemLabel>
                <Icon
                  name="chevron-right"
                  {...envRowEndIconProps(props.variant === "menu", "text-icon-weak ml-auto self-center")}
                />
              </DropdownMenu.Item>
            </Show>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export const BranchPickerControl: Component<{
  variant: ControlVariant
  onNewSessionWorktreeCreate?: () => void
}> = (props) => {
  const picker = useBranchPicker(props.onNewSessionWorktreeCreate)
  const placement = () => (props.variant === "menu" ? "right-start" : "top-start")
  const [open, setOpen] = createSignal(false)

  return (
    <Show when={picker.isGitProject()}>
      <DropdownMenu
        placement={placement()}
        gutter={4}
        onOpenChange={(open) => {
          setOpen(open)
          if (open) void picker.refreshBranches()
          else picker.setBranchSearch("")
        }}
      >
        <DropdownMenu.Trigger
          as={props.variant === "menu" ? "button" : Button}
          type="button"
          variant={props.variant === "menu" ? undefined : "ghost"}
          class={props.variant === "menu" ? menuTriggerClass : branchFooterTriggerClass}
          data-action="prompt-branch-picker"
          aria-label={picker.language.t("session.new.worktree.label")}
          onClick={(e: MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerDown={(e: PointerEvent) => {
            e.stopPropagation()
          }}
        >
          <Icon {...envBranchIconProps} />
          <span class="truncate">{picker.currentBranchName()}</span>
          <Show
            when={props.variant === "menu"}
            fallback={
              <Icon
                name={open() ? "chevron-up" : "chevron-down"}
                size="small"
                class="shrink-0 ml-auto"
              />
            }
          >
            <Icon name="chevron-right" {...envRowEndIconProps(true, "ml-auto rotate-90")} />
          </Show>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            class={
              props.variant === "menu"
                ? `${envControlsMenuClass} flex max-h-[min(420px,calc(100vh-24px))] min-w-[280px] flex-col overflow-hidden`
                : "codex-chat-menu flex max-h-[min(420px,calc(100vh-24px))] min-w-[280px] flex-col overflow-hidden"
            }
          >
            <div class="shrink-0 px-2 py-1.5">
              <div class="flex items-center gap-1.5 px-2 h-7 rounded-[8px] bg-surface-base-hover focus-within:bg-surface-base-active">
                <Icon name="magnifying-glass" size="small" class="shrink-0 text-icon-weak" />
                <input
                  type="text"
                  value={picker.branchSearch()}
                  onInput={(e) => picker.setBranchSearch(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === "Enter") e.preventDefault()
                  }}
                  placeholder={picker.language.t("session.new.worktree.search")}
                  class="flex-1 min-w-0 bg-transparent border-0 outline-none text-13-regular text-text-base placeholder:text-text-weak"
                />
              </div>
            </div>
            <DropdownMenu.Group class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-color:rgba(0,0,0,0.24)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:border-0 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(0,0,0,0.24)]">
              <DropdownMenu.GroupLabel class="!px-3 !py-1 text-12-regular text-text-weak">
                {picker.language.t("session.new.worktree.branches")}
              </DropdownMenu.GroupLabel>
              <For
                each={picker
                  .branches()
                  .filter((b) => picker.branchMatchesSearch(b))
                  .toSorted((a, b) =>
                    a === picker.currentBranchName() ? -1 : b === picker.currentBranchName() ? 1 : a.localeCompare(b),
                  )}
              >
                {(name) => (
                  <DropdownMenu.Item
                    class="!items-start !py-1.5"
                    disabled={!!picker.branchSwitching()}
                    onSelect={() => void picker.handleSwitchBranch(name)}
                  >
                    <Icon {...envBranchIconProps} class="shrink-0 text-icon-weak mt-0.5" />
                    <div class="flex flex-col min-w-0 flex-1">
                      <DropdownMenu.ItemLabel class="truncate">{name}</DropdownMenu.ItemLabel>
                      <Show when={name === picker.currentBranchName() && picker.uncommittedLabel()}>
                        <span class="text-12-regular text-text-weak truncate">{picker.uncommittedLabel()}</span>
                      </Show>
                    </div>
                    <Show when={name === picker.currentBranchName()}>
                      <Icon
                        name={envRowEndCheckName(props.variant === "menu")}
                        {...envRowEndIconProps(props.variant === "menu", "text-icon-weak ml-auto self-center")}
                      />
                    </Show>
                  </DropdownMenu.Item>
                )}
              </For>
              <Show when={picker.branches().length === 0 && picker.branchMatchesSearch(picker.currentBranchName())}>
                <DropdownMenu.Item disabled class="!items-start !py-1.5">
                  <Icon {...envBranchIconProps} class="shrink-0 text-icon-weak mt-0.5" />
                  <div class="flex flex-col min-w-0 flex-1">
                    <DropdownMenu.ItemLabel class="truncate">{picker.currentBranchName()}</DropdownMenu.ItemLabel>
                    <Show when={picker.uncommittedLabel()}>
                      <span class="text-12-regular text-text-weak truncate">{picker.uncommittedLabel()}</span>
                    </Show>
                  </div>
                  <Icon
                    name={envRowEndCheckName(props.variant === "menu")}
                    {...envRowEndIconProps(props.variant === "menu", "text-icon-weak ml-auto self-center")}
                  />
                </DropdownMenu.Item>
              </Show>
            </DropdownMenu.Group>
            <DropdownMenu.Separator class="shrink-0" />
            <DropdownMenu.Item class="shrink-0" onSelect={() => props.onNewSessionWorktreeCreate?.()}>
              <Icon name="plus-small" size="small" class="text-icon-weak" />
              <DropdownMenu.ItemLabel>{picker.language.t("session.new.worktree.create")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
