import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { AddonAvailable, AddonInfo, AddonSkillListItem, McpManagementItem, RegistryPluginOut } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { formatServerError } from "@/utils/server-errors"
import { swallowNextClick } from "@/utils/swallow-click"
import { authenticateMcp } from "@/utils/mcp-connection"
import { pickLocalPluginArchive, resolveDroppedLocalPluginArchive } from "@/utils/local-plugin-archive"
import { PluginsActions } from "@/components/plugins-actions"
import {
  skillMention,
  SkillDetailDialog,
  type AppSkillItem,
  type SkillDirectoryItem,
} from "@/components/skill-detail-dialog"
import { useRegistryNamespaceGate } from "@/components/dialog-registry-namespace"
import { DialogLocalPluginArchive } from "@/components/dialog-local-plugin-archive"
import { RegistryManageVersionsButton, RegistryVersionsDialog } from "@/components/registry-version-manager"
import {
  groupManagedMcps,
  initialManageTab,
  managedMcpListState,
  mcpOAuthAction,
  mcpDetailPath,
  visibleManageTabs,
  type ManageTab,
  type ManageTabCounts,
} from "./plugins-manage-model"
import { ManagePageHeader } from "./plugins-manage-header"

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

// 内置(由万来 Code 维护)的几个 openai-* marketplace —— 用户视角不可配 / 不可删,
// Manage 页只列用户自己加的 marketplace。与 plugins.tsx 的 isBuiltinMarketplace 同规则。
function isBuiltinMarketplace(name: string): boolean {
  return name.startsWith("openai-")
}

// 与 plugins.tsx 同算法：macOS 折叠 sidebar 时左侧让位 252px 给浮动 chrome 按钮组
function useLeadingPad() {
  const platform = usePlatform()
  const layout = useLayout()
  return () => {
    const isMac = platform.platform === "desktop" && platform.os !== "windows"
    if (!isMac) return 8
    return layout.sidebar.opened() ? 8 : 252
  }
}

function pluginDisplayName(info: AddonInfo, meta?: AddonAvailable) {
  return meta?.display_name?.trim() || info.display_name?.trim() || info.name || info.key
}

function pluginDescription(info: AddonInfo, meta?: AddonAvailable) {
  return info.error ?? meta?.description ?? info.description ?? info.marketplace_name
}

function pluginSortLabel(info: AddonInfo, meta?: AddonAvailable) {
  return `${pluginDisplayName(info, meta)}\u0000${info.key}`
}

function sortSkills(items: AddonSkillListItem[]) {
  return [...items].sort((a, b) =>
    `${a.display_name?.trim() || a.namespaced_name}\u0000${a.namespaced_name}`.localeCompare(
      `${b.display_name?.trim() || b.namespaced_name}\u0000${b.namespaced_name}`,
    ),
  )
}

function sortBuiltinSkills(items: AppSkillItem[]) {
  return [...items].sort((a, b) =>
    `${a.displayName?.trim() || a.name}\u0000${a.name}`.localeCompare(
      `${b.displayName?.trim() || b.name}\u0000${b.name}`,
    ),
  )
}

export default function PluginsManage() {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams<{ tab?: ManageTab }>()
  const leadingPad = useLeadingPad()
  const ensureRegistryNamespace = useRegistryNamespaceGate()
  const comingSoon = (label: string) => showToast({ title: label, description: language.t("plugins.comingSoon") })

  const [tab, setTab] = createSignal<ManageTab>(initialManageTab(searchParams.tab))
  const [search, setSearch] = createSignal("")
  const [archiveDragOver, setArchiveDragOver] = createSignal(false)
  let pageRef: HTMLDivElement | undefined

  // 全局 QueryClient 配了 refetchOnMount:false(见 app.tsx),意味着回到本页时即便缓存已 stale
  // 也不会自动重拉 —— 安装/卸载发生在别的页面时,本页 query 处于 inactive,只能依赖写入口主动
  // invalidate,这条链路存在缓存/时序竞态(query 不在 cache 时 invalidate 是空操作、或后台重拉
  // 与导航竞态),会出现"刚装的插件看不到、必须 toggle 才刷新"。Manage 是管理页,应始终反映
  // 系统当前真实状态,故这几个 query 一律 refetchOnMount:"always",每次进入页面无条件重拉。

  // installed addons - drive plugins / apps / mcps tab + counts
  const installed = createQuery(() => ({
    queryKey: ["addon", "list", "global"],
    queryFn: async () => (await sdk.client.addon.list()).data ?? [],
    refetchOnMount: "always",
  }))

  // available addons - 含 logo / brand_color / manifest_apps 等元数据,
  // 与 plugins.tsx 共享同一份 cache,无重复请求
  const available = createQuery(() => ({
    queryKey: ["addon", "available", "global", language.locale()],
    queryFn: async () => (await sdk.client.addon.available({ locale: language.locale() })).data ?? [],
    refetchOnMount: "always",
  }))

  // skills 列表(addon.skills 已 namespaced)
  const skills = createQuery(() => ({
    queryKey: ["addon", "skills", "global"],
    queryFn: async () => (await sdk.client.addon.skills()).data ?? [],
    refetchOnMount: "always",
  }))

  // app.skills 返回所有来源的 skill(含 builtin);此处只取 builtin,与 addon.skills 合并展示。
  const allSkills = createQuery(() => ({
    queryKey: ["app", "skills", "global"],
    queryFn: async () => (await sdk.client.app.skills()).data ?? [],
  }))

  const builtinSkills = createMemo(() => (allSkills.data ?? []).filter((s) => s.source === "builtin"))

  const managedMcps = createQuery(() => ({
    queryKey: ["mcp", "management", "global"],
    queryFn: async () => {
      const response = await sdk.client.mcp.management.list()
      if (response.error) throw response.error
      return response.data ?? []
    },
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status.status === "connecting") ? 2000 : false,
  }))

  // 把 AddonInfo 与 AddonAvailable 按 key 关联拿 logo / brand color / description
  const installedEnriched = createMemo(() => {
    const list = installed.data ?? []
    const avail = available.data ?? []
    const availByKey = new Map(avail.map((a) => [a.key, a]))
    return list
      .map((info) => ({ info, meta: availByKey.get(info.key) }))
      .sort((a, b) => pluginSortLabel(a.info, a.meta).localeCompare(pluginSortLabel(b.info, b.meta)))
  })

  const counts = createMemo(() => {
    const list = installed.data ?? []
    const avail = available.data ?? []
    const installedKeys = new Set(list.map((item) => item.key))
    // Marketplace 计数排除内置(openai-*),只算用户加的;与下面 filteredMarketplaces 同口径
    const marketplaceNames = new Set(
      avail.map((a) => a.marketplace_name).filter((n): n is string => !!n && !isBuiltinMarketplace(n)),
    )
    return {
      plugins: list.length,
      apps: avail
        .filter((item) => installedKeys.has(item.key) && item.installed && !item.disabled)
        .reduce((total, item) => total + (item.manifest_apps?.length ?? 0), 0),
      mcps: managedMcps.data?.length ?? 0,
      skills: (skills.data ?? []).filter((item) => item.installed ?? true).length,
      marketplace: marketplaceNames.size,
    }
  })

  const visibleTabs = createMemo(() => visibleManageTabs(counts()))
  // 当前选中 tab 若因计数归零被隐藏,自动切到第一个可见 tab
  createEffect(() => {
    if (installed.isPending || available.isPending || skills.isPending || managedMcps.isPending) return
    const vis = visibleTabs()
    if (!vis.includes(tab())) setTab(vis[0] ?? "mcps")
  })

  createEffect(() => {
    setTab(initialManageTab(searchParams.tab))
  })

  const selectTab = (next: ManageTab) => {
    setTab(next)
    setSearchParams({ ...searchParams, tab: next })
  }

  const invalidateMcpQueries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mcp", "management", "global"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp", "status", "global"] }),
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === "mcp" }),
    ])

  const mcpToggle = useMutation(() => ({
    mutationFn: async (input: { name: string; enabled: boolean }) => {
      const response = await sdk.client.mcp.management.toggle({
        name: input.name,
        mcpManagementToggleInput: input,
      })
      if (response.error) throw response.error
    },
    onSuccess: () => void invalidateMcpQueries(),
    onError: (err) => {
      void managedMcps.refetch()
      showToast({
        variant: "error",
        title: language.t("plugins.manage.toggle.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    },
  }))

  const mcpAuthenticate = useMutation(() => ({
    mutationFn: (name: string) =>
      authenticateMcp(
        sdk.client,
        name,
        managedMcps.data?.find((item) => item.name === name)?.status.status === "connected",
      ),
    onSettled: () => invalidateMcpQueries(),
    onError: (err) => {
      void managedMcps.refetch()
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    },
  }))

  const addonToggle = useMutation(() => ({
    mutationFn: async (input: { addonKey: string; enabled: boolean }) =>
      sdk.client.addon.toggle({
        addonToggleRequest: {
          addon_key: input.addonKey,
          enabled: input.enabled,
        },
      }),
    // 禁用 addon 会连带其 skill / MCP 一并增减,顺手失效这几个列表保持 UI 一致;
    // available 列表带 disabled 字段,聊天框 @ 插件列表依赖它,必须一并失效才能让禁用即时反映。
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addon", "list", "global"] })
      queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"] })
      queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"] })
      queryClient.invalidateQueries({ queryKey: ["mcp", "status", "global"] })
      queryClient.invalidateQueries({ queryKey: ["mcp", "management", "global"] })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.manage.toggle.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  // 卸载插件(与列表页/详情页一致):成功后失效相关 addon 列表。
  // refetchType:"all" 与安装路径对齐,让 inactive 页(列表 / 聊天 @ 列表等)也立即后台重拉。
  const uninstall = useMutation(() => ({
    mutationFn: async (addonKey: string) =>
      sdk.client.addon.uninstall({ addonInstallRequest: { addon_key: addonKey } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addon", "list", "global"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["mcp", "status", "global"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["mcp", "management", "global"], refetchType: "all" })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.uninstall.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const installLocalArchive = useMutation(() => ({
    mutationFn: async (archivePath: string) => {
      const res = await sdk.client.addon.installArchive({
        addonLocalArchiveInstallRequest: { archive_path: archivePath },
      })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data
    },
    onSuccess: () => {
      setTab("plugins")
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["addon", "list", "global"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["mcp", "status", "global"], refetchType: "all" }),
      ])
      showToast({ variant: "success", title: language.t("plugins.install.success") })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const previewInstall = (archivePath: string) => installLocalArchive.mutateAsync(archivePath).then(() => undefined)

  const previewLocalArchive = useMutation(() => ({
    mutationFn: async (archivePath: string) => {
      const res = await sdk.client.addon.previewArchive({
        addonLocalArchivePreviewRequest: { archive_path: archivePath, locale: language.locale() },
      })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      if (!res.data) throw new Error(language.t("plugins.install.failed"))
      return res.data
    },
    onSuccess: (preview, archivePath) => {
      dialog.show(() => (
        <DialogLocalPluginArchive
          preview={preview}
          onConfirm={() => previewInstall(archivePath)}
        />
      ))
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const chooseLocalArchive = async () => {
    const archivePath = await pickLocalPluginArchive(platform, language.t("plugins.manage.installLocalArchive"))
    if (!archivePath) return
    previewLocalArchive.mutate(archivePath)
  }

  const handleArchiveDragOver = (event: DragEvent) => {
    if (!platform.getPathForFile || !event.dataTransfer?.types.includes("Files")) return
    event.preventDefault()
    setArchiveDragOver(true)
  }

  const handleArchiveDragLeave = (event: DragEvent) => {
    if (event.relatedTarget instanceof Node && pageRef?.contains(event.relatedTarget)) return
    setArchiveDragOver(false)
  }

  const handleArchiveDrop = (event: DragEvent) => {
    if (!platform.getPathForFile || !event.dataTransfer?.types.includes("Files")) return
    event.preventDefault()
    event.stopPropagation()
    setArchiveDragOver(false)
    const archivePath = resolveDroppedLocalPluginArchive({
      files: event.dataTransfer.files,
      getPathForFile: platform.getPathForFile,
    })
    if (!archivePath) {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: language.t("plugins.installLocalArchive.invalidDrop"),
      })
      return
    }
    previewLocalArchive.mutate(archivePath)
  }

  const uploadPlugin = useMutation(() => ({
    mutationFn: async (addonKey: string) => {
      const res = await sdk.client.registry.publish({ registryPublishRequest: { addon_key: addonKey } })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["registry", "plugins"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["registry", "myPlugins"], refetchType: "all" })
      showToast({ variant: "success", title: language.t("plugins.detail.upload.success") })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.detail.upload.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const skillToggle = useMutation(() => ({
    mutationFn: async (input: { addonKey: string; name: string; enabled: boolean }) =>
      sdk.client.addon.skillToggle({
        addonSkillToggleRequest: {
          addon_key: input.addonKey,
          name: input.name,
          enabled: input.enabled,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"] })
      queryClient.invalidateQueries({ queryKey: ["app", "skills", "global"] })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.manage.toggle.failed"),
        description: err instanceof Error ? err.message : String(err),
      }),
  }))

  const skillInstall = useMutation(() => ({
    mutationFn: async (input: { item: AddonSkillListItem; installed: boolean }) =>
      sdk.client.addon.skillInstall({
        addonSkillInstallRequest: {
          addon_key: input.item.addon_key,
          name: input.item.name,
          installed: input.installed,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"] })
      queryClient.invalidateQueries({ queryKey: ["app", "skills", "global"] })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.uninstall.failed"),
        description: err instanceof Error ? err.message : String(err),
      }),
  }))

  const filteredPlugins = createMemo(() => {
    const q = search().trim().toLowerCase()
    const list = installedEnriched()
    if (!q) return list
    return list.filter(({ info, meta }) => {
      const text = `${info.name} ${pluginDisplayName(info, meta)} ${pluginDescription(info, meta)}`.toLowerCase()
      return text.includes(q)
    })
  })

  const filteredSkills = createMemo<AddonSkillListItem[]>(() => {
    const q = search().trim().toLowerCase()
    const list = sortSkills((skills.data ?? []).filter((item) => item.installed ?? true))
    if (!q) return list
    return list.filter((s) => {
      const text = `${s.namespaced_name} ${s.display_name ?? ""} ${s.description ?? ""}`.toLowerCase()
      return text.includes(q)
    })
  })

  const filteredBuiltinSkills = createMemo(() => {
    const q = search().trim().toLowerCase()
    const list = sortBuiltinSkills(builtinSkills())
    if (!q) return list
    return list.filter((s) => {
      const text = `${s.name} ${s.displayName ?? ""} ${s.description ?? ""}`.toLowerCase()
      return text.includes(q)
    })
  })

  const currentSkillDetailItem = (item: SkillDirectoryItem): SkillDirectoryItem => {
    if (item.kind === "system") {
      const current = builtinSkills().find((skill) => skill.name === item.item.name)
      return current ? { kind: "system", item: current } : item
    }
    const current = (skills.data ?? []).find((skill) => skill.namespaced_name === item.item.namespaced_name)
    return current ? { kind: "addon", item: current } : item
  }

  const openSkillDetail = (item: SkillDirectoryItem) =>
    dialog.show(() => (
      <SkillDetailDialog
        item={() => currentSkillDetailItem(item)}
        pending={
          item.kind === "addon" &&
          ((skillToggle.isPending &&
            skillToggle.variables?.addonKey === item.item.addon_key &&
            skillToggle.variables?.name === item.item.name) ||
            (skillInstall.isPending &&
              skillInstall.variables?.item.addon_key === item.item.addon_key &&
              skillInstall.variables?.item.name === item.item.name))
        }
        onToggle={(skill, enabled) => skillToggle.mutate({ addonKey: skill.addon_key, name: skill.name, enabled })}
        onInstall={(skill, installed) => skillInstall.mutate({ item: skill, installed })}
        onTry={(name, title) => navigate(`/?prompt=${encodeURIComponent(skillMention(title, name))}`)}
      />
    ))

  const groupedMcps = createMemo(() =>
    groupManagedMcps(managedMcps.data ?? [], search(), {
      custom: language.t("plugins.manage.mcp.source.custom"),
      addon: language.t("plugins.manage.mcp.source.addon"),
      local: language.t("mcp.editor.type.stdio"),
      remote: language.t("mcp.editor.type.http"),
    }),
  )
  const managedMcpsState = createMemo(() =>
    managedMcpListState(managedMcps.data, managedMcps.error, managedMcps.isPending),
  )

  // marketplace 行: 每个唯一 marketplace_name + 它下面有几个 plugin。
  // 内置 openai-* 不出现在这里(等价于「Built by WanLaiCode」系列,不需要用户管理)。
  const filteredMarketplaces = createMemo(() => {
    const avail = available.data ?? []
    const byName = new Map<string, number>()
    for (const a of avail) {
      if (!a.marketplace_name) continue
      if (isBuiltinMarketplace(a.marketplace_name)) continue
      byName.set(a.marketplace_name, (byName.get(a.marketplace_name) ?? 0) + 1)
    }
    const list = [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))
    const q = search().trim().toLowerCase()
    if (!q) return list
    return list.filter(([name]) => name.toLowerCase().includes(q))
  })

  const uploadAddon = async (addonKey: string) => {
    try {
      const namespace = await ensureRegistryNamespace()
      if (!namespace) return
      uploadPlugin.mutate(addonKey)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("plugins.namespace.checkFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    }
  }

  const openPublished = (plugin: RegistryPluginOut) =>
    navigate(
      `/plugins/${encodeURIComponent(`${plugin.slug}@wanlaicode`)}?source=registry&namespace=${encodeURIComponent(plugin.namespace)}&slug=${encodeURIComponent(plugin.slug)}`,
    )

  return (
    <div
      ref={(element) => (pageRef = element)}
      data-page="plugins-manage"
      class="size-full flex flex-col min-h-0 relative bg-background-base"
      onDragOver={handleArchiveDragOver}
      onDragLeave={handleArchiveDragLeave}
      onDrop={handleArchiveDrop}
    >
      <Show when={archiveDragOver()}>
        <div class="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.06)] border-2 border-dashed border-icon-info-active rounded-lg pointer-events-none">
          <div class="px-4 py-2 rounded-lg bg-bg-base text-14-medium text-text-base shadow-lg">
            {language.t("plugins.installLocalArchive.dropHint")}
          </div>
        </div>
      </Show>
      <Show when={tab() !== "mcps"}>
        {/* 顶部 header: 面包屑(Plugins > Manage) 左,Create + ··· 右。
            MCP 管理页使用 Codex 风格页面壳层，不叠加此旧式顶栏。 */}
        <div
          class="shrink-0 z-20 bg-background-stronger pr-3 h-12 flex items-center justify-between"
          style={
            {
              "padding-left": `${leadingPad()}px`,
            } as Record<string, string>
          }
        >
          <div class="flex items-center gap-1 text-14-regular text-text-weak">
            <button
              type="button"
              class="px-2 h-8 rounded-md hover:bg-surface-base text-text-base"
              style={NO_DRAG}
              onClick={() => navigate("/plugins")}
            >
              {language.t("plugins.page.title")}
            </button>
            <Icon name="chevron-right" size="small" class="text-text-weaker" />
            <span class="px-2 h-8 inline-flex items-center text-text-strong truncate max-w-xs" style={NO_DRAG}>
              {language.t("plugins.manage.title")}
            </span>
          </div>
          <div class="flex items-center gap-1" style={NO_DRAG}>
            <Show when={platform.openFilePickerDialog}>
              <button
                type="button"
                class="size-8 rounded-md flex items-center justify-center text-text-base hover:bg-surface-base disabled:opacity-50 disabled:pointer-events-none"
                aria-label={language.t("plugins.manage.installLocalArchive")}
                title={language.t("plugins.manage.installLocalArchive")}
                disabled={installLocalArchive.isPending || previewLocalArchive.isPending}
                onClick={() => void chooseLocalArchive()}
              >
                <Icon name="archive" size="small" />
              </button>
            </Show>
            <button
              type="button"
              class="size-8 rounded-md flex items-center justify-center text-text-base hover:bg-surface-base"
              aria-label={language.t("plugins.published.title")}
              title={language.t("plugins.published.title")}
              onClick={() => dialog.show(() => <DialogPublishedPlugins onOpen={openPublished} />)}
            >
              <Icon name="cloud-upload" size="small" />
            </button>
            <PluginsActions
              refreshAs="menu"
              onRefresh={() => {
                void Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["addon", "list", "global"] }),
                  queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"] }),
                  queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"] }),
                  queryClient.invalidateQueries({ queryKey: ["mcp", "status", "global"] }),
                  queryClient.invalidateQueries({ queryKey: ["mcp", "management", "global"] }),
                ])
              }}
              primaryAction={tab() === "skills" ? "skill" : "plugin"}
              onCreatePlugin={() =>
                navigate(`/?prompt=${encodeURIComponent(language.t("plugins.createPlugin.prompt"))}`)
              }
              onCreateSkill={() =>
                navigate(`/?prompt=${encodeURIComponent(language.t("plugins.createSkill.prompt"))}`)
              }
              onRecordSkill={() => comingSoon(language.t("plugins.menu.recordSkill"))}
            />
          </div>
        </div>
      </Show>
      {/* scrollbar-gutter: stable 让 scroll 容器在 scrollbar 出现/消失时不挤压内容宽度,
          macOS 设置为"始终显示滚动条"时,以及 mouse hover 触发 overlay scrollbar 时都不抖动 */}
      <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        <Show when={tab() === "mcps"}>
          <McpManageView
            language={language}
            counts={counts}
            visibleTabs={visibleTabs}
            tab={tab}
            selectTab={selectTab}
            search={search}
            setSearch={setSearch}
            groups={groupedMcps}
            state={managedMcpsState}
            error={managedMcps.error}
            onRetry={() => void managedMcps.refetch()}
            onAdd={() => navigate("/plugins/manage/mcp/new")}
            onToggle={(name, enabled) => mcpToggle.mutate({ name, enabled })}
            toggling={(name) => mcpToggle.isPending && mcpToggle.variables?.name === name}
            onAuthenticate={(name) => mcpAuthenticate.mutate(name)}
            authenticating={(name) => mcpAuthenticate.isPending && mcpAuthenticate.variables === name}
            onOpen={(name) => navigate(mcpDetailPath(name))}
          />
        </Show>
        <Show when={tab() !== "mcps"}>
          <div class="mx-auto w-full max-w-[1040px] px-5 pb-16 pt-[85px]">
            <ManagePageHeader
              language={language}
              counts={counts}
              visibleTabs={visibleTabs}
              tab={tab}
              selectTab={selectTab}
              search={search}
              setSearch={setSearch}
              placeholder={language.t("plugins.manage.search.placeholder")}
            />

            {/* 内容区 —— 按 tab 渲染不同的列表 */}
            <div class="mt-14 flex flex-col">
              <Show when={tab() === "plugins"}>
                <Show
                  when={filteredPlugins().length > 0}
                  fallback={<EmptyRow text={emptyTextFor(search(), language.t(`plugins.manage.empty.plugins`))} />}
                >
                  <For each={filteredPlugins()}>
                    {({ info, meta }) => (
                      <PluginRow
                        info={info}
                        meta={meta}
                        pending={addonToggle.isPending && addonToggle.variables?.addonKey === info.key}
                        onToggle={(enabled) => addonToggle.mutate({ addonKey: info.key, enabled })}
                        onOpen={() => navigate(`/plugins/${encodeURIComponent(info.key)}`)}
                        onUpload={info.marketplace_name === "personal" ? () => void uploadAddon(info.key) : undefined}
                        uploading={uploadPlugin.isPending && uploadPlugin.variables === info.key}
                        onUninstall={() => uninstall.mutate(info.key)}
                        uninstalling={uninstall.isPending && uninstall.variables === info.key}
                      />
                    )}
                  </For>
                </Show>
              </Show>

              <Show when={tab() === "apps"}>
                <EmptyRow text={language.t("plugins.manage.empty.apps")} />
              </Show>

              <Show when={tab() === "skills"}>
                <Show
                  when={filteredSkills().length > 0 || filteredBuiltinSkills().length > 0}
                  fallback={<EmptyRow text={emptyTextFor(search(), language.t(`plugins.manage.empty.skills`))} />}
                >
                  <For each={filteredSkills()}>
                    {(s) => (
                      <SkillRow
                        skill={s}
                        pending={skillToggle.isPending}
                        onOpen={() => openSkillDetail({ kind: "addon", item: s })}
                        onToggle={(next) => skillToggle.mutate({ addonKey: s.addon_key, name: s.name, enabled: next })}
                      />
                    )}
                  </For>
                  <For each={filteredBuiltinSkills()}>
                    {(s) => <BuiltinSkillRow skill={s} onOpen={() => openSkillDetail({ kind: "system", item: s })} />}
                  </For>
                </Show>
              </Show>

              <Show when={tab() === "marketplace"}>
                <Show
                  when={filteredMarketplaces().length > 0}
                  fallback={<EmptyRow text={emptyTextFor(search(), language.t(`plugins.manage.empty.marketplace`))} />}
                >
                  <For each={filteredMarketplaces()}>
                    {([name, count]) => (
                      <div class="group mx-1 flex h-[94px] items-center gap-4 rounded-xl px-4 transition-colors cursor-pointer hover:bg-surface-base">
                        <div class="size-[52px] rounded-xl flex items-center justify-center shrink-0 bg-surface-base text-text-strong">
                          <Icon name="folder-outline" size="small" />
                        </div>
                        <div class="flex-1 min-w-0">
                          <div class="text-[16px] leading-5 text-text-strong truncate">{name}</div>
                          <div class="mt-1 text-[16px] leading-5 text-text-weak truncate">
                            {count} {count === 1 ? "plugin" : "plugins"}
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

function emptyTextFor(query: string, baseText: string) {
  return query.trim() ? "" : baseText
}

function McpManageView(props: {
  language: ReturnType<typeof useLanguage>
  counts: () => ManageTabCounts
  visibleTabs: () => ManageTab[]
  tab: () => ManageTab
  selectTab: (tab: ManageTab) => void
  search: () => string
  setSearch: (value: string) => void
  groups: () => { custom: McpManagementItem[]; addon: McpManagementItem[] }
  state: () => ReturnType<typeof managedMcpListState>
  error: unknown
  onRetry: () => void
  onAdd: () => void
  onToggle: (name: string, enabled: boolean) => void
  toggling: (name: string) => boolean
  onAuthenticate: (name: string) => void
  authenticating: (name: string) => boolean
  onOpen: (name: string) => void
}): JSX.Element {
  const empty = () => emptyTextFor(props.search(), props.language.t("plugins.manage.empty.mcps"))

  return (
    <div class="mx-auto w-full max-w-[1040px] px-5 pb-16 pt-[85px]">
      <ManagePageHeader
        language={props.language}
        counts={props.counts}
        visibleTabs={props.visibleTabs}
        tab={props.tab}
        selectTab={props.selectTab}
        search={props.search}
        setSearch={props.setSearch}
        placeholder={props.language.t("plugins.manage.mcp.search")}
      />

      <div class="mt-14 flex items-center justify-between gap-4">
        <h2 class="text-[18px] font-normal leading-6 text-text-strong">
          {props.language.t("plugins.manage.mcp.servers")}
        </h2>
        <button
          type="button"
          class="inline-flex h-9 items-center gap-2 rounded-[12px] bg-surface-base px-3.5 text-[18px] leading-6 text-text-strong transition-colors hover:bg-surface-base-active"
          style={NO_DRAG}
          onClick={props.onAdd}
        >
          <Icon name="plus-small" size="small" />
          {props.language.t("plugins.manage.mcp.add")}
        </button>
      </div>

      <Show when={props.state().showError}>
        <div
          role="alert"
          class="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border-weak-base bg-surface-raised-base px-4 py-3"
        >
          <span class="min-w-0 break-words text-13-regular text-text-danger">
            {formatServerError(props.error, props.language.t, props.language.t("common.requestFailed"))}
          </span>
          <button
            type="button"
            class="h-8 shrink-0 rounded-lg px-3 text-13-medium text-text-strong hover:bg-surface-base"
            style={NO_DRAG}
            onClick={props.onRetry}
          >
            {props.language.t("common.retry")}
          </button>
        </div>
      </Show>

      <Show when={props.state().content === "loading"}>
        <div class="mt-4 rounded-[20px] border border-border-weaker-base py-16 text-center text-14-regular text-text-weak">
          {props.language.t("common.loading")}
        </div>
      </Show>

      <Show when={props.state().content !== "error" && props.state().content !== "loading"}>
        <div class="mt-4 flex flex-col overflow-hidden rounded-[20px] border border-border-weaker-base bg-background-stronger [&>div:not(:last-child)]:relative [&>div:not(:last-child)]:after:pointer-events-none [&>div:not(:last-child)]:after:absolute [&>div:not(:last-child)]:after:inset-x-5 [&>div:not(:last-child)]:after:bottom-0 [&>div:not(:last-child)]:after:h-[0.5px] [&>div:not(:last-child)]:after:bg-border-weaker-base [&>div:not(:last-child)]:after:content-['']">
          <Show
            when={props.groups().custom.length > 0}
            fallback={<div class="py-16 text-center text-14-regular text-text-weak">{empty()}</div>}
          >
            <For each={props.groups().custom}>
              {(item) => (
                <CodexMcpServerRow
                  item={item}
                  toggling={props.toggling(item.name)}
                  onToggle={(enabled) => props.onToggle(item.name, enabled)}
                  onOpen={() => props.onOpen(item.name)}
                />
              )}
            </For>
          </Show>
        </div>

        <Show when={props.groups().addon.length > 0}>
          <h2 class="mt-10 text-[18px] font-normal leading-6 text-text-strong">
            {props.language.t("plugins.manage.mcp.fromPlugins")}
          </h2>
          <div class="mt-4 flex flex-col overflow-hidden rounded-[20px] border border-border-weaker-base bg-background-stronger [&>div:not(:last-child)]:relative [&>div:not(:last-child)]:after:pointer-events-none [&>div:not(:last-child)]:after:absolute [&>div:not(:last-child)]:after:inset-x-5 [&>div:not(:last-child)]:after:bottom-0 [&>div:not(:last-child)]:after:h-[0.5px] [&>div:not(:last-child)]:after:bg-border-weaker-base [&>div:not(:last-child)]:after:content-['']">
            <For each={props.groups().addon}>
              {(item) => (
                <CodexMcpPluginRow
                  item={item}
                  authenticating={props.authenticating(item.name)}
                  onAuthenticate={() => props.onAuthenticate(item.name)}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function CodexMcpServerRow(props: {
  item: McpManagementItem
  toggling: boolean
  onToggle: (enabled: boolean) => void
  onOpen: () => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <div class="flex min-h-[68px] items-center justify-between gap-6 px-4 py-3">
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left text-[16px] leading-5 text-text-strong"
        style={NO_DRAG}
        onClick={props.onOpen}
      >
        {props.item.name}
      </button>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="flex size-8 items-center justify-center rounded-md text-text-weak transition-colors hover:bg-surface-base hover:text-text-strong"
          style={NO_DRAG}
          aria-label={language.t("plugins.manage.mcp.settings")}
          onClick={props.onOpen}
        >
          <Icon name="settings-gear" size="small" />
        </button>
        <Switch
          class="switch-pill"
          checked={props.item.enabled}
          disabled={props.toggling}
          onChange={props.onToggle}
          aria-label={props.item.enabled ? language.t("plugins.skills.disable") : language.t("plugins.skills.enable")}
        />
      </div>
    </div>
  )
}

function CodexMcpPluginRow(props: {
  item: McpManagementItem
  authenticating: boolean
  onAuthenticate: () => void
}): JSX.Element {
  const language = useLanguage()
  const action = () => mcpOAuthAction(props.item)
  const authLabel = () => {
    if (props.authenticating) return language.t("plugins.manage.mcp.authenticating")
    if (props.item.status.status === "connected") return language.t("plugins.manage.mcp.reauthenticate")
    return language.t("plugins.manage.mcp.authenticate")
  }
  return (
    <div class="flex min-h-[55px] items-center justify-between gap-6 px-4 py-3">
      <span class="min-w-0 flex-1 truncate text-[16px] leading-5 text-text-strong">
        {props.item.name}
      </span>
      <Show when={action() === "authenticate"}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          style={NO_DRAG}
          disabled={props.authenticating}
          onClick={props.onAuthenticate}
        >
          {authLabel()}
        </Button>
      </Show>
    </div>
  )
}

function PluginLogo(props: { logo?: string; brandColor?: string; fallback: string; class?: string }): JSX.Element {
  return (
    <Show
      when={props.logo}
      fallback={
        <div
          class={`${props.class ?? "size-11"} rounded-xl flex items-center justify-center shrink-0 text-text-strong text-14-medium bg-surface-base`}
          style={props.brandColor ? { "background-color": props.brandColor, color: "#FFFFFF" } : undefined}
        >
          {props.fallback}
        </div>
      }
    >
      <img
        src={props.logo}
        alt=""
        class={`${props.class ?? "size-11"} rounded-xl shrink-0 object-cover bg-surface-base`}
        loading="lazy"
      />
    </Show>
  )
}

function formatRegistryCount(value: number | "NaN" | "Infinity" | "-Infinity") {
  return typeof value === "number" ? String(value) : "0"
}

export function DialogPublishedPlugins(props: {
  onOpen: (plugin: RegistryPluginOut) => void
}): JSX.Element {
  const sdk = useGlobalSDK()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const ensureRegistryNamespace = useRegistryNamespaceGate()
  const [openingPublishedVersionManager, setOpeningPublishedVersionManager] = createSignal<string>()

  const published = createQuery(() => ({
    queryKey: ["registry", "myPlugins", language.locale()],
    queryFn: async () => {
      const res = await sdk.client.registry.myPlugins({ locale: language.locale() })
      if (res.error) throw res.error
      return res.data
    },
    refetchOnMount: "always",
  }))

  const deleteVersion = useMutation(() => ({
    mutationFn: async (input: { namespace: string; slug: string; version: string }) => {
      const res = await sdk.client.registry.deleteVersion({
        namespace: input.namespace,
        slug: input.slug,
        version: input.version,
      })
      if (res.error) throw res.error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["registry", "plugins"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["registry", "myPlugins"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["registry", "plugin"], refetchType: "all" })
      showToast({ variant: "success", title: language.t("plugins.detail.versions.deleteSuccess") })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.detail.versions.deleteFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const openPublishedVersionManager = async (plugin: RegistryPluginOut) => {
    const key = `${plugin.namespace}/${plugin.slug}`
    if (openingPublishedVersionManager()) return
    setOpeningPublishedVersionManager(key)
    try {
      const res = await sdk.client.registry.getPlugin({
        namespace: plugin.namespace,
        slug: plugin.slug,
        locale: language.locale(),
      })
      if (res.error || !res.data) {
        showToast({
          variant: "error",
          title: language.t("plugins.detail.versions.openFailed"),
          description: formatServerError(res.error, language.t, language.t("common.requestFailed")),
        })
        return
      }
      queryClient.setQueryData(["registry", "plugin", plugin.namespace, plugin.slug, language.locale()], res.data)
      dialog.push(() => (
        <RegistryVersionsDialog
          versions={res.data.versions}
          deleting={deleteVersion.isPending}
          onDeleteVersion={async (version) => {
            await deleteVersion.mutateAsync({ namespace: plugin.namespace, slug: plugin.slug, version })
          }}
        />
      ))
    } finally {
      setOpeningPublishedVersionManager(undefined)
    }
  }

  const registerNamespace = async () => {
    try {
      const namespace = await ensureRegistryNamespace()
      if (!namespace) return
      queryClient.invalidateQueries({ queryKey: ["registry", "myPlugins"], refetchType: "all" })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("plugins.namespace.checkFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    }
  }

  const namespace = () => published.data?.user.namespace ?? undefined
  const plugins = () => published.data?.plugins ?? []

  return (
    <Dialog title={language.t("plugins.published.title")} class="w-full max-w-[620px]" fit>
      <div class="px-5 pb-5 flex flex-col gap-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-13-regular text-text-weak truncate inline-flex items-center gap-1">
              <Tooltip
                placement="right"
                value={
                  <div class="max-w-64 flex flex-col gap-1 text-12-regular leading-relaxed">
                    <span>{language.t("plugins.namespace.dialog.description")}</span>
                  </div>
                }
              >
                <span class="inline-flex items-center text-icon-weak">
                  <Icon name="info-circle" size="small" />
                </span>
              </Tooltip>
              <span>{language.t("plugins.published.namespace")}</span>
              <span>{": "}</span>
              <Show
                when={namespace()}
                fallback={
                  published.isLoading ? language.t("common.loading") : language.t("plugins.published.namespaceNotSet")
                }
              >
                {namespace()}
              </Show>
            </div>
          </div>
          <Show when={!namespace() && !published.isLoading}>
            <button
              type="button"
              class="h-8 px-3 rounded-full bg-text-strong text-background-stronger text-13-medium hover:opacity-90 shrink-0"
              onClick={() => void registerNamespace()}
            >
              {language.t("plugins.published.setNamespace")}
            </button>
          </Show>
        </div>

        <Show when={published.error}>
          <div class="text-13-regular text-text-danger break-all">
            {formatServerError(published.error, language.t, language.t("common.requestFailed"))}
          </div>
        </Show>

        <Show
          when={namespace()}
          fallback={
            <Show when={!published.isLoading && !published.error}>
              <div class="py-8 text-center text-14-regular text-text-weak">
                {language.t("plugins.published.namespaceMissing")}
              </div>
            </Show>
          }
        >
          <Show
            when={plugins().length > 0}
            fallback={
              <Show when={!published.isLoading && !published.error}>
                <div class="py-8 text-center text-14-regular text-text-weak">{language.t("plugins.published.empty")}</div>
              </Show>
            }
          >
            <div>
              <For each={plugins()}>
                {(plugin) => (
                  <PublishedPluginRow
                    plugin={plugin}
                    managingVersions={openingPublishedVersionManager() === `${plugin.namespace}/${plugin.slug}`}
                    onOpen={() => {
                      dialog.close()
                      props.onOpen(plugin)
                    }}
                    onManageVersions={() => void openPublishedVersionManager(plugin)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}

function PublishedPluginRow(props: {
  plugin: RegistryPluginOut
  managingVersions: boolean
  onOpen: () => void
  onManageVersions: () => void
}): JSX.Element {
  const language = useLanguage()
  const title = () => props.plugin.display_name?.trim() || props.plugin.slug
  const subtitle = () => props.plugin.short_description ?? props.plugin.long_description ?? `${props.plugin.namespace}/${props.plugin.slug}`
  return (
    <div
      class="group flex items-center gap-4 py-3 -mx-2 px-2 rounded-lg cursor-pointer hover:bg-surface-base transition-colors"
      role="button"
      tabindex={0}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          props.onOpen()
        }
      }}
    >
      <PluginLogo
        logo={props.plugin.logo_url ?? undefined}
        brandColor={undefined}
        fallback={(title().charAt(0) || "?").toUpperCase()}
      />
      <div class="flex-1 min-w-0">
        <div class="text-14-medium text-text-strong truncate">{title()}</div>
        <div class="text-13-regular text-text-weak truncate">{subtitle()}</div>
      </div>
      <div class="hidden sm:flex flex-col items-end shrink-0 text-12-regular text-text-weak">
        <span>{props.plugin.latest_version ? `v${props.plugin.latest_version}` : language.t("plugins.published.noVersion")}</span>
        <span>
          {language.t("plugins.published.downloads", {
            count: formatRegistryCount(props.plugin.download_count),
          })}
        </span>
      </div>
      <div class="opacity-0 group-hover:opacity-100 transition-opacity" onClick={(event) => event.stopPropagation()}>
        <RegistryManageVersionsButton
          visible
          loading={props.managingVersions}
          onManage={props.onManageVersions}
        />
      </div>
    </div>
  )
}

function PluginRow(props: {
  info: AddonInfo
  meta: AddonAvailable | undefined
  pending: boolean
  onToggle: (enabled: boolean) => void
  onOpen: () => void
  onUpload?: () => void
  uploading: boolean
  onUninstall: () => void
  uninstalling: boolean
}): JSX.Element {
  const language = useLanguage()
  const name = () => pluginDisplayName(props.info, props.meta)
  const subtitle = () => pluginDescription(props.info, props.meta)
  const enabled = () => !props.info.disabled && !props.info.error
  return (
    <div
      class="group mx-1 flex h-[94px] items-center gap-4 rounded-xl px-4 transition-colors cursor-pointer hover:bg-surface-base"
      role="button"
      tabindex={0}
      onClick={() => props.onOpen()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          props.onOpen()
        }
      }}
    >
      <PluginLogo
        logo={props.meta?.logo}
        brandColor={props.meta?.brand_color}
        fallback={(name().charAt(0) || "?").toUpperCase()}
        class="size-[52px]"
      />
      <div class="flex-1 min-w-0">
        <div class="flex min-w-0 items-center gap-2">
          <div class="truncate text-[16px] leading-5 text-text-strong">{name()}</div>
          <Show when={props.info.marketplace_name}>
            <span class="shrink-0 truncate text-[16px] leading-5 text-text-weak">{props.info.marketplace_name}</span>
          </Show>
        </div>
        <div class="mt-1 truncate text-[16px] leading-5 text-text-weak">{subtitle()}</div>
      </div>
      {/* ··· 非常驻:hover 整行才出现;菜单打开时保持可见 */}
      <DropdownMenu placement="bottom-end" gutter={4}>
        <DropdownMenu.Trigger
          class="size-7 rounded-full flex items-center justify-center text-text-weak hover:bg-surface-base-active data-[state=open]:bg-surface-base-active transition-all opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          style={NO_DRAG}
          aria-label={language.t("plugins.card.more")}
          onClick={(e) => e.stopPropagation()}
        >
          <Icon name="ellipsis-horizontal" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="codex-chat-menu min-w-44">
            <Show when={props.onUpload}>
              <DropdownMenu.Item
                onSelect={() => {
                  swallowNextClick()
                  props.onUpload?.()
                }}
                disabled={props.uploading}
              >
                <Icon name="cloud-upload" size="small" class="text-icon-weak" />
                <DropdownMenu.ItemLabel>
                  <Show when={!props.uploading} fallback={language.t("plugins.detail.upload.uploading")}>
                    {language.t("plugins.detail.upload.action")}
                  </Show>
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </Show>
            <DropdownMenu.Item
              onSelect={() => {
                swallowNextClick()
                props.onUninstall()
              }}
              disabled={props.uninstalling}
            >
              <Icon name="trash" size="small" class="text-icon-weak" />
              <DropdownMenu.ItemLabel>{language.t("plugins.detail.uninstall")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
      {/* Switch 阻止冒泡,点开关不触发整行导航 */}
      <div class="ml-auto shrink-0" onClick={(e) => e.stopPropagation()}>
        <Switch
          class="switch-pill"
          checked={enabled()}
          disabled={props.pending}
          onChange={(next) => props.onToggle(next)}
          aria-label={enabled() ? language.t("plugins.skills.disable") : language.t("plugins.skills.enable")}
        />
      </div>
    </div>
  )
}

function SkillRow(props: {
  skill: AddonSkillListItem
  pending: boolean
  onOpen: () => void
  onToggle: (enabled: boolean) => void
}): JSX.Element {
  const language = useLanguage()
  const label = () => props.skill.display_name?.trim() || props.skill.name
  return (
    <div
      class="group mx-1 flex h-[94px] items-center gap-4 rounded-xl px-4 transition-colors cursor-pointer hover:bg-surface-base"
      role="button"
      tabindex={0}
      onClick={() => props.onOpen()}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        props.onOpen()
      }}
    >
      <PluginLogo
        logo={props.skill.logo}
        brandColor={props.skill.brand_color}
        fallback={(label().charAt(0) || "?").toUpperCase()}
        class="size-[52px]"
      />
      <div class="flex-1 min-w-0">
        <div class="text-[16px] leading-5 text-text-strong truncate">{label()}</div>
        <div class="mt-1 text-[16px] leading-5 text-text-weak truncate">
          {props.skill.description || props.skill.namespaced_name}
        </div>
      </div>
      <div class="ml-auto shrink-0" onClick={(e) => e.stopPropagation()}>
        <Switch
          class="switch-pill"
          checked={props.skill.enabled}
          onChange={(next) => props.onToggle(next)}
          disabled={props.pending}
          aria-label={props.skill.enabled ? language.t("plugins.skills.disable") : language.t("plugins.skills.enable")}
        />
      </div>
    </div>
  )
}

function BuiltinSkillRow(props: { skill: AppSkillItem; onOpen: () => void }): JSX.Element {
  const language = useLanguage()
  const title = () => props.skill.displayName?.trim() || props.skill.name
  return (
    <div
      class="group mx-1 flex h-[94px] items-center gap-4 rounded-xl px-4 transition-colors cursor-pointer hover:bg-surface-base"
      role="button"
      tabindex={0}
      onClick={() => props.onOpen()}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        props.onOpen()
      }}
    >
      <Show
        when={props.skill.icon}
        fallback={
          <PluginLogo
            logo={undefined}
            brandColor={undefined}
            fallback={(title().charAt(0) || "?").toUpperCase()}
            class="size-[52px]"
          />
        }
      >
        <img
          src={props.skill.icon}
          alt={title()}
          class="size-[52px] rounded-xl shrink-0 object-cover bg-surface-base"
          loading="lazy"
        />
      </Show>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-[16px] leading-5 text-text-strong truncate">{title()}</span>
          <span class="shrink-0 text-11-regular text-text-weak px-1.5 py-0.5 rounded bg-surface-base">
            {language.t("plugins.skills.badge.builtin")}
          </span>
        </div>
        <div class="mt-1 text-[16px] leading-5 text-text-weak truncate">{props.skill.description}</div>
      </div>
    </div>
  )
}

function EmptyRow(props: { text: string }): JSX.Element {
  return (
    <Show when={props.text}>
      <div class="py-16 text-center text-14-regular text-text-weak">{props.text}</div>
    </Show>
  )
}
