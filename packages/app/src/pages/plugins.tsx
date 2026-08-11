import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { useLocation, useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import type { AddonAvailable, AddonSkillListItem, RegistryPluginOut } from "@opencode-ai/sdk/v2"
import { DialogLocalPluginArchive } from "@/components/dialog-local-plugin-archive"
import { DialogSelectAddon } from "@/components/dialog-select-addon"
import { PluginsActions } from "@/components/plugins-actions"
import {
  directoryItemTitle,
  isPersonalSkill,
  skillMention,
  SkillDetailDialog,
  sortDirectorySkills,
  type AppSkillItem,
  type SkillDirectoryItem,
} from "@/components/skill-detail-dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { finiteNum, formatInstallCount, mockStatsFor } from "@/utils/marketplace-stats"
import { resolveDroppedLocalPluginArchive } from "@/utils/local-plugin-archive"
import { swallowNextClick } from "@/utils/swallow-click"
import { pluginCategoryLabel } from "@/utils/plugin-category"
import {
  addonMentionKey,
  addonNamespaceFromKey,
  isBuiltinMarketplace,
  isAddonSupersededByInstalledRegistry,
  migrationSourceKeysForTarget,
  migrationTargetForAddon,
  REGISTRY_MARKETPLACE,
  registryAddonKey,
} from "@/utils/plugin-migration"
import { buildPluginMention } from "@opencode-ai/core/util/mention"

type Tab = "plugins" | "skills"

type FilterOption = { value: string; label: string }

// dropdown 内部的「全部内置」聚合选项 value —— 与任何 marketplace_name 都不冲突
const BUILTIN_MARKETPLACE_VALUE = "__builtin__"

// 官方市场（WanLaiCode Registry）来源 value
const OFFICIAL_REGISTRY_VALUE = "__wanlai_registry__"

// 「Personal」来源:无 marketplace 归属的本地个人 addon,或来自默认个人 marketplace（name === "personal"）
const SOURCE_PERSONAL_VALUE = "__personal__"

// 默认个人 marketplace 的 name（后端在 <data>/personal 自动加载,见 addon service init）。
// 它的插件应归入「个人」分类,而不是当作外部 marketplace 列出。
const PERSONAL_MARKETPLACE = "personal"

// 一组确定性颜色块，用 addon.name 哈希映射，避免页面跳动并提供视觉差异
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

function displayName(info: AddonAvailable): string {
  return info.display_name?.trim() || info.name || info.key
}

function tabFromSearch(search: string): Tab {
  if (new URLSearchParams(search).get("tab") === "skills") return "skills"
  return "plugins"
}

type StatusKind = "enabled" | "disabled" | "error" | "available"

function statusKind(info: AddonAvailable): StatusKind {
  if (info.error) return "error"
  if (info.disabled) return "disabled"
  if (info.installed) return "enabled"
  return "available"
}

export default function Plugins() {
  const language = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const platform = usePlatform()
  const layout = useLayout()
  const [tab, setTab] = createSignal<Tab>(tabFromSearch(location.search))
  const [query, setQuery] = createSignal("")
  const [archiveDragOver, setArchiveDragOver] = createSignal(false)
  let pageRef: HTMLDivElement | undefined
  // 来源 tab 始终有一项选中(对齐 Codex「By OpenAI」默认选中);默认「By 万来 Code」(内置 + 官方市场)。
  const [marketplaceFilter, setMarketplaceFilter] = createSignal<string | null>(BUILTIN_MARKETPLACE_VALUE)
  const [categoryFilter, setCategoryFilter] = createSignal<string | null>(null)

  // 分类(category)是第三方 marketplace / registry manifest 的自由英文文本,后端不本地化;
  // 这里做尽力翻译,未收录的分类(以及 marketplace_name / 未分类回退值)显示原文。
  const categoryLabel = (raw: string) => pluginCategoryLabel(raw, language.t)

  // macOS 折叠 sidebar 时 main 顶到 left=0，要为左上浮动 chrome 按钮组让位（约 252px）
  // 与 session.tsx 同算法
  const leadingPad = () => {
    const isMac = platform.platform === "desktop" && platform.os !== "windows"
    if (!isMac) return 8
    return layout.sidebar.opened() ? 8 : 252
  }

  createEffect(() => setTab(tabFromSearch(location.search)))

  const list = createQuery(() => ({
    queryKey: ["addon", "available", "global", language.locale()],
    queryFn: async () => {
      const result = await sdk.client.addon.available({ locale: language.locale() })
      return result.data ?? []
    },
  }))

  // 官方市场来源 —— null(全部)/ 官方市场 / 「By 万来 Code」(含官方 registry)时都拉取;
  // 选中具体外部 marketplace 或「个人」时不拉取。
  const showRegistry = () =>
    marketplaceFilter() === OFFICIAL_REGISTRY_VALUE ||
    marketplaceFilter() === BUILTIN_MARKETPLACE_VALUE ||
    marketplaceFilter() === null
  const [registrySearchQuery, setRegistrySearchQuery] = createSignal("")
  // 展示官方市场时用同一搜索词驱动 registry query
  createEffect(() => {
    if (showRegistry()) {
      setRegistrySearchQuery(query().trim())
    }
  })
  const registryList = createQuery(() => ({
    queryKey: ["registry", "plugins", registrySearchQuery(), language.locale()],
    enabled: showRegistry(),
    queryFn: async () => {
      const res = await sdk.client.registry.listPlugins({
        q: registrySearchQuery() || undefined,
        locale: language.locale(),
      })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data?.items ?? []
    },
  }))

  const installRegistry = useMutation(() => ({
    mutationFn: async (p: RegistryPluginOut) => {
      const res = await sdk.client.registry.install({
        registryInstallRequest: { namespace: p.namespace, slug: p.slug },
      })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data
    },
    onSuccess: () => {
      // refetchType:"all" 让 inactive 页(如未挂载的 Manage 页)也立即后台重拉,而非只标 stale。
      void queryClient.invalidateQueries({ queryKey: ["addon"], refetchType: "all" })
      // 与详情页安装一致：成功也给反馈。
      showToast({ variant: "success", title: language.t("plugins.install.success") })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  const migrateRegistry = useMutation(() => ({
    mutationFn: async (input: { target: RegistryPluginOut; oldKeys: string[] }) => {
      const installRes = await sdk.client.registry.install({
        registryInstallRequest: { namespace: input.target.namespace, slug: input.target.slug },
      })
      if (installRes.error) throw new Error(String((installRes.error as { error?: string }).error ?? installRes.error))
      for (const oldKey of input.oldKeys) {
        const uninstallRes = await sdk.client.addon.uninstall({ addonInstallRequest: { addon_key: oldKey } })
        if (uninstallRes.error) {
          throw new Error(String((uninstallRes.error as { error?: string }).error ?? uninstallRes.error))
        }
      }
      return installRes.data
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["addon"], refetchType: "all" })
      showToast({ variant: "success", title: language.t("plugins.migrate.success") })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: language.t("plugins.migrate.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  // 卡片 ··· 菜单卸载：直接调 addon.uninstall，成功后失效 addon 查询。
  // 用 variables.addon_key 标记进行中项,给对应卡片菜单置 disabled。
  const uninstall = useMutation(() => ({
    mutationFn: async (addonKey: string) => {
      const res = await sdk.client.addon.uninstall({ addonInstallRequest: { addon_key: addonKey } })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data
    },
    onSuccess: () => {
      // 与安装路径一致:refetchType:"all" 让 inactive 页(Manage / 聊天 @ 列表等)也立即后台重拉。
      void queryClient.invalidateQueries({ queryKey: ["addon"], refetchType: "all" })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: language.t("plugins.uninstall.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  // 本地插件直接安装(点 Install 即装,不再弹确认对话框);官方市场项仍走 installRegistry。
  const installAddon = useMutation(() => ({
    mutationFn: async (addonKey: string) => {
      const res = await sdk.client.addon.install({ addonInstallRequest: { addon_key: addonKey } })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["addon"], refetchType: "all" })
      showToast({ variant: "success", title: language.t("plugins.install.success") })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
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
      void queryClient.invalidateQueries({ queryKey: ["addon"], refetchType: "all" })
      showToast({ variant: "success", title: language.t("plugins.install.success") })
    },
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
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
    onError: (err: unknown) => {
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

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

  // key（slug@wanlaicode/namespace）→ 原始 registry 项，供卡片的安装/打开按来源分流。
  const registryIndex = createMemo(() => {
    const m = new Map<string, RegistryPluginOut>()
    for (const p of registryList.data ?? []) m.set(registryAddonKey(p), p)
    return m
  })
  const installedRegistryKeys = createMemo(
    () =>
      new Set(
        (list.data ?? [])
          .filter((a) => a.marketplace_name === REGISTRY_MARKETPLACE && a.installed)
          .map((a) => a.key),
      ),
  )
  const migrationTargetFor = (addon: AddonAvailable) => {
    return migrationTargetForAddon({
      addon,
      registryPlugins: registryList.data ?? [],
      installedRegistryKeys: installedRegistryKeys(),
    })
  }

  // 把官方市场插件合成 AddonAvailable，与本地 available() 合并，统一进 filtered()/grouped()。
  // 已安装的官方插件会出现在本地 list 里（key 同为 slug@wanlaicode/namespace），按 key 去重避免重复卡片。
  const combined = createMemo<AddonAvailable[]>(() => {
    const localAll = list.data ?? []
    if (!showRegistry()) return localAll
    // 官方插件优先用 registry 合成项渲染（后端绝对 logo_url + 真实 category），据本地已安装状态标 installed。
    const synthesizedKeys = new Set<string>()
    const synthesized = (registryList.data ?? []).map((p): AddonAvailable => {
      const key = registryAddonKey(p)
      synthesizedKeys.add(key)
      return {
        key,
        name: p.slug,
        display_name: p.display_name,
        // 列表卡片用 short；long 留给详情页。
        description: p.short_description ?? undefined,
        long_description: p.long_description ?? undefined,
        marketplace_name: REGISTRY_MARKETPLACE,
        registry_namespace: p.namespace,
        // 缺分类用英文 sentinel "Other"（而非译文),让 grouped 与 openai 真实 "Other" 类归并,
        // 且统一交给 categoryLabel 翻译——否则同一"其他"会因 key 不同裂成两个分组。
        category: p.category ?? "Other",
        installation: "AVAILABLE",
        installed: installedRegistryKeys().has(key),
        logo: p.logo_url ?? undefined,
      }
    })
    // 本地项：非官方来源全部保留；官方来源仅保留 registry 未返回的（拉取失败或被搜索过滤）——
    // 避免已安装的官方插件在后端不可达时从列表消失、无法卸载。这些项的 logo 已由后端读成 data URI。
    const local = localAll.filter((a) => {
      if (
        isAddonSupersededByInstalledRegistry({
          addon: a,
          registryPlugins: registryList.data ?? [],
          installedRegistryKeys: installedRegistryKeys(),
        })
      )
        return false
      return a.marketplace_name !== REGISTRY_MARKETPLACE || !synthesizedKeys.has(a.key)
    })
    return [...local, ...synthesized]
  })

  const comingSoon = (label: string) =>
    showToast({ title: label, description: language.t("plugins.comingSoon") })

  const onManage = () => navigate("/plugins/manage")
  // 创建插件:跳到聊天并预填 prompt,触发内置 plugin-creator skill 搭脚手架。
  const onCreatePlugin = () =>
    navigate(`/?prompt=${encodeURIComponent(language.t("plugins.createPlugin.prompt"))}`)
  const onCreateSkill = () =>
    navigate(`/?prompt=${encodeURIComponent(language.t("plugins.createSkill.prompt"))}`)
  // 仍未接通的 + 下拉项保留 coming-soon 占位。
  const onAddMarketplace = () => comingSoon(language.t("plugins.menu.addMarketplace"))
  const onRecordSkill = () => comingSoon(language.t("plugins.menu.recordSkill"))
  // Docs 入口暂未在 UI 露出,保留实现待恢复。void 标记防止 noUnusedLocals 报错。
  const onOpenDocs = () => comingSoon(language.t("plugins.menu.docs"))
  void onOpenDocs
  // 把当前 slide 的 prompt 经 ?prompt= 透传给 / —— home.tsx 重定向到散对话路由时保留 query,
  // session.tsx 的 composer 一旦 ready 就读 searchParams.prompt 并 prefill。
  const onTryInChat = (prompt?: string) => {
    if (prompt) navigate(`/?prompt=${encodeURIComponent(prompt)}`)
    else navigate("/")
  }
  const onOpenDetail = (key: string) => {
    const reg = registryIndex().get(key)
    if (reg) {
      navigate(
        `/plugins/${encodeURIComponent(key)}?source=registry&namespace=${encodeURIComponent(reg.namespace)}&slug=${encodeURIComponent(reg.slug)}`,
      )
      return
    }
    navigate(`/plugins/${encodeURIComponent(key)}`)
  }
  // 卡片安装：官方市场项走 registry.install；本地项直接 addon.install(不弹对话框)。
  const onInstallItem = (addon: AddonAvailable) => {
    const reg = registryIndex().get(addon.key)
    if (reg) {
      installRegistry.mutate(reg)
      return
    }
    installAddon.mutate(addon.key)
  }
  // 列表卡片统计(三分规则):
  //   openai-* 内置 marketplace → mockStatsFor(稳定假数据占位)
  //   wanlaicode 官方市场       → 真实 download_count / rating_avg
  //   本地 / personal / sideload → 全 0
  const statsFor = (addon: AddonAvailable): { installs: number; rating: number } => {
    const mn = addon.marketplace_name ?? ""
    if (isBuiltinMarketplace(mn)) return mockStatsFor(addon.key)
    if (mn === REGISTRY_MARKETPLACE) {
      const p = registryIndex().get(addon.key)
      if (p) return { installs: finiteNum(p.download_count), rating: finiteNum(p.rating_avg) }
      return { installs: 0, rating: 0 }
    }
    // 本地 / personal / 无 marketplace
    return { installs: 0, rating: 0 }
  }

  // marketplace / category 选项基于「未应用其它筛选」的全集去重，避免选择 marketplace 后
  // category 列表收窄到死循环（用户改不回来）。
  //
  // 内置（由万来 Code 维护的）三个 openai-* marketplace 在 dropdown 中聚合成一条
  // "由 万来 Code 构建"；后续用户自行添加的 marketplace 各占一条。
  const marketplaceOptions = createMemo<FilterOption[]>(() => {
    const items = list.data ?? []
    const externals = new Set<string>()
    let hasBuiltin = false
    for (const item of items) {
      if (!item.marketplace_name) continue
      if (isBuiltinMarketplace(item.marketplace_name)) hasBuiltin = true
      // 默认个人 marketplace 不作为外部来源列出,归入「个人」分类。
      else if (item.marketplace_name === PERSONAL_MARKETPLACE) continue
      else externals.add(item.marketplace_name)
    }
    const opts: FilterOption[] = []
    // 官方市场选项无条件置顶，不依赖 available() 数据
    opts.push({
      value: OFFICIAL_REGISTRY_VALUE,
      label: language.t("plugins.filter.registry.label"),
    })
    if (hasBuiltin) {
      opts.push({
        value: BUILTIN_MARKETPLACE_VALUE,
        label: language.t("plugins.filter.builtBy.value", {
          name: language.t("plugins.filter.builtBy.builtin"),
        }),
      })
    }
    for (const name of [...externals].sort((a, b) => a.localeCompare(b))) {
      opts.push({
        value: name,
        label: language.t("plugins.filter.builtBy.value", { name }),
      })
    }
    return opts
  })
  const categoryOptions = createMemo<FilterOption[]>(() => {
    const seen = new Set<string>()
    for (const item of list.data ?? []) {
      if (item.category) seen.add(item.category)
    }
    // value 保持原始分类文本(filtered/grouped 按它比较),仅 label 走翻译,并按译名排序。
    return [...seen]
      .map((c) => ({ value: c, label: categoryLabel(c) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  // 已选 marketplace / category 在数据刷新后若不复存在，自动重置，避免空结果死锁。
  // 固定来源桶(By 万来 Code / 官方市场 / 个人)始终是有效 tab,不参与重置;
  // 仅当选中的是「具体外部 marketplace」且其消失时,回退到默认「By 万来 Code」。
  createEffect(() => {
    const m = marketplaceFilter()
    if (
      !m ||
      m === BUILTIN_MARKETPLACE_VALUE ||
      m === OFFICIAL_REGISTRY_VALUE ||
      m === SOURCE_PERSONAL_VALUE
    )
      return
    if (!marketplaceOptions().some((o) => o.value === m)) setMarketplaceFilter(BUILTIN_MARKETPLACE_VALUE)
  })
  createEffect(() => {
    const c = categoryFilter()
    if (c && !categoryOptions().some((o) => o.value === c)) setCategoryFilter(null)
  })

  const filtered = createMemo(() => {
    const all = combined()
    const q = query().trim().toLowerCase()
    const m = marketplaceFilter()
    const c = categoryFilter()
    if (!q && !m && !c) return all
    return all.filter((p) => {
      if (m) {
        if (m === BUILTIN_MARKETPLACE_VALUE) {
          // By 万来 Code = 内置 openai-* + 官方 registry
          if (!isBuiltinMarketplace(p.marketplace_name) && p.marketplace_name !== REGISTRY_MARKETPLACE) return false
        } else if (m === SOURCE_PERSONAL_VALUE) {
          // 个人 = 无 marketplace 归属 或 来自默认个人 marketplace
          if (p.marketplace_name && p.marketplace_name !== PERSONAL_MARKETPLACE) return false
        } else if (m === OFFICIAL_REGISTRY_VALUE) {
          if (p.marketplace_name !== REGISTRY_MARKETPLACE) return false
        } else if (p.marketplace_name !== m) return false
      }
      if (c && p.category !== c) return false
      if (q) {
        const text = [p.name, p.display_name, p.description, ...(p.keywords ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        if (!text.includes(q)) return false
      }
      return true
    })
  })

  const hasActiveFilter = () =>
    Boolean(query() || marketplaceFilter() || categoryFilter())

  const grouped = createMemo(() => {
    const items = filtered()
    const map = new Map<string, AddonAvailable[]>()
    for (const item of items) {
      const k = item.category || item.marketplace_name || language.t("plugins.category.uncategorized")
      const arr = map.get(k) ?? []
      arr.push(item)
      map.set(k, arr)
    }
    return [...map.entries()]
      .map(([category, items]) => ({
        category,
        items: items.sort((a, b) => displayName(a).localeCompare(displayName(b))),
      }))
      .sort((a, b) => categoryLabel(a.category).localeCompare(categoryLabel(b.category)))
  })

  const installedItems = createMemo(() => (list.data ?? []).filter((i) => i.installed))

  const allInstalled = createMemo(() => {
    const items = list.data ?? []
    return items.length > 0 && items.every((i) => i.installed)
  })

  // 进入页面或点刷新时:先让后端失效 addon 缓存(重新发现磁盘上 out-of-band 新建的插件,
  // 如对话里 plugin-creator 直接写盘的个人插件),再失效前端 query 触发后台重拉。
  const doRefresh = async () => {
    try {
      await sdk.client.addon.refresh()
    } catch (err) {
      // 后端失效失败不打断页面:继续展示当前缓存列表,下次进入再试。
      console.warn("addon refresh failed", err)
    }
    void queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"] })
    // 官方市场列表独立的 query key，需一并失效才会重新拉取。
    void queryClient.invalidateQueries({ queryKey: ["registry", "plugins"] })
    void queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"] })
    void queryClient.invalidateQueries({ queryKey: ["app", "skills", "global"] })
  }
  const onRefresh = () => void doRefresh()

  // 每次进入插件页静默后台重新发现一次:先展示缓存列表,扫描完成后列表悄悄更新(无 loading)。
  onMount(() => void doRefresh())

  return (
    // 顶部 header 单独出来不参与 scroll,scrollbar 只显示在下面的内容区,不视觉覆盖 header。
    // 旧实现把 overflow-y-auto 放在最外层,macOS overlay scrollbar 会盖过 sticky header 右上角。
    <div
      ref={(element) => (pageRef = element)}
      class="size-full flex flex-col min-h-0 relative"
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
      {/* 顶部 header —— tabs 在最左，Manage/Create/··· 在最右。
          空白区域交给 layout.tsx 顶部全局拖拽条；具体交互控件各自标 no-drag。 */}
      <div
        class="shrink-0 z-20 bg-background-stronger pr-3 h-12 flex items-center justify-between"
        style={{
          "padding-left": `${leadingPad()}px`,
        } as Record<string, string>}
      >
        <Tabs tab={tab} setTab={setTab} />
        <PluginsActions
          onRefresh={onRefresh}
          onManage={onManage}
          primaryAction={tab() === "skills" ? "skill" : "plugin"}
          onCreatePlugin={onCreatePlugin}
          onCreateSkill={onCreateSkill}
          onAddMarketplace={onAddMarketplace}
          onRecordSkill={onRecordSkill}
        />
      </div>

      {/* scrollbar-gutter: stable 让 scroll 容器在 scrollbar 出现/消失时不挤压内容宽度,
          macOS 设置为"始终显示滚动条"时,以及 mouse hover 触发 overlay scrollbar 时都不抖动 */}
      <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
      <div class="mx-auto w-full max-w-4xl px-6 pb-12">
        <Show
          when={tab() === "plugins"}
          fallback={<SkillsTab />}
        >
          <div class="mt-12 mb-6">
            <h1
              class="text-text-strong tracking-tight"
              style={{ "font-size": "28px", "font-weight": "400", "line-height": "1.2" }}
            >
              {language.t("plugins.page.title")}
            </h1>
            <div class="mt-1 text-15-regular text-text-weak">
              {language.t("plugins.subtitle")}
            </div>
          </div>

          {/* Codex 顺序:搜索框 → Installed → 过滤栏。
              搜索框跟随页面滚动,触顶后 pin 住。 */}
          <div class="sticky top-0 z-10 bg-background-stronger pt-2 pb-4 -mx-6 px-6">
            <SearchBox query={query} setQuery={setQuery} />
          </div>

          <InstalledStrip items={installedItems()} onManage={onManage} onOpen={onOpenDetail} />

          <div class="mt-6">
            <FilterBar
              marketplace={marketplaceFilter}
              setMarketplace={setMarketplaceFilter}
              category={categoryFilter}
              setCategory={setCategoryFilter}
              marketplaces={marketplaceOptions}
              categories={categoryOptions}
            />
          </div>

          {/* 统一内容：本地 available() 与官方市场插件合并(combined)，按分类(grouped)用同一卡片展示 */}
          <Show when={list.isError || (showRegistry() && registryList.isError)}>
            <div class="mt-4 px-4 py-3 rounded-md bg-surface-base text-13-regular text-text-danger break-all">
              {language.t("plugins.error.load")}
              {": "}
              {(() => {
                const e = list.error ?? registryList.error
                if (e instanceof Error) return e.message || e.name
                try {
                  return JSON.stringify(e)
                } catch {
                  return String(e)
                }
              })()}
            </div>
          </Show>

          <Show when={(list.isLoading || (showRegistry() && registryList.isLoading)) && combined().length === 0}>
            <LoadingSkeleton />
          </Show>

          <Show when={!list.isLoading && !list.isError}>
            <Show when={combined().length === 0 && !(showRegistry() && registryList.isLoading)}>
              <EmptyState onManage={onManage} />
            </Show>

            <Show when={(list.data ?? []).length > 0 && allInstalled() && !showRegistry()}>
              <NoMarketplaceHint />
            </Show>


            <div class="mt-10 flex flex-col gap-10">
              <For each={grouped()}>
                {(g) => (
                  <CategorySection
                    label={categoryLabel(g.category)}
                    items={g.items}
                    collapsed={!hasActiveFilter()}
                    onInstall={onInstallItem}
                    onOpen={onOpenDetail}
                    onTryInChat={(item) => {
                      const prefix = `${buildPluginMention(item.name, addonMentionKey(item))} `
                      onTryInChat(prefix)
                    }}
                    onUninstall={(item) => uninstall.mutate(item.key)}
                    uninstallingKey={uninstall.isPending ? uninstall.variables : undefined}
                    migrationTargetFor={migrationTargetFor}
                    onMigrate={(item) => {
                      const target = migrationTargetFor(item)
                      if (target) {
                        migrateRegistry.mutate({
                          target,
                          oldKeys: migrationSourceKeysForTarget({
                            target,
                            addons: list.data ?? [],
                            registryPlugins: registryList.data ?? [],
                          }),
                        })
                      }
                    }}
                    migratingKeys={migrateRegistry.isPending ? migrateRegistry.variables?.oldKeys : undefined}
                    statsFor={statsFor}
                  />
                )}
              </For>
              <Show
                when={
                  combined().length > 0 &&
                  grouped().length === 0 &&
                  !(showRegistry() && registryList.isLoading)
                }
              >
                <div class="text-14-regular text-text-weak py-12 text-center">
                  {language.t("plugins.empty")}
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
      </div>
    </div>
  )
}

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

function Tabs(props: { tab: () => Tab; setTab: (t: Tab) => void }): JSX.Element {
  const language = useLanguage()
  const tabClass = (active: boolean) =>
    `px-3 h-8 inline-flex items-center rounded-md text-14-medium transition-colors ${
      active ? "bg-surface-base text-text-strong" : "text-text-weak hover:text-text-base"
    }`
  return (
    <div class="flex items-center gap-1">
      <button type="button" class={tabClass(props.tab() === "plugins")} style={NO_DRAG} onClick={() => props.setTab("plugins")}>
        {language.t("plugins.tab.plugins")}
      </button>
      <button type="button" class={tabClass(props.tab() === "skills")} style={NO_DRAG} onClick={() => props.setTab("skills")}>
        {language.t("plugins.tab.skills")}
      </button>
    </div>
  )
}

function SourceTabs(props: {
  value: () => string | null
  onChange: (v: string | null) => void
  workspaces: () => FilterOption[]
}): JSX.Element {
  const language = useLanguage()
  const tabCls = (active: boolean) =>
    `h-8 px-3 rounded-full text-14-medium whitespace-nowrap transition-colors ${
      active ? "bg-surface-base text-text-strong" : "text-text-weak hover:text-text-base"
    }`
  const isWorkspace = () => {
    const v = props.value()
    return Boolean(v && props.workspaces().some((w) => w.value === v))
  }
  return (
    <div role="tablist" aria-label="Plugin directory" class="flex items-center gap-2 overflow-x-auto hide-scrollbar">
      <button type="button" role="tab" aria-selected={props.value() === BUILTIN_MARKETPLACE_VALUE}
        class={tabCls(props.value() === BUILTIN_MARKETPLACE_VALUE)} style={NO_DRAG}
        onClick={() => props.onChange(BUILTIN_MARKETPLACE_VALUE)}>
        {language.t("plugins.source.byBuiltin", { name: language.t("plugins.filter.builtBy.builtin") })}
      </button>
      <Show when={props.workspaces().length > 0}>
        <button type="button" role="tab" aria-selected={isWorkspace()}
          class={tabCls(isWorkspace())} style={NO_DRAG}
          onClick={() => props.onChange(props.workspaces()[0]?.value ?? null)}>
          {language.t("plugins.source.byWorkspace")}
        </button>
      </Show>
      <button type="button" role="tab" aria-selected={props.value() === SOURCE_PERSONAL_VALUE}
        class={tabCls(props.value() === SOURCE_PERSONAL_VALUE)} style={NO_DRAG}
        onClick={() => props.onChange(SOURCE_PERSONAL_VALUE)}>
        {language.t("plugins.source.personal")}
      </button>
    </div>
  )
}

// 搜索框单独成块：与 Codex 一致放在标题下、Installed 之上。
function SearchBox(props: { query: () => string; setQuery: (v: string) => void }): JSX.Element {
  const language = useLanguage()
  return (
    <div
      class="flex items-center gap-2 px-4 h-8 bg-background-stronger rounded-full border border-border-weak-base"
      style={NO_DRAG}
    >
      <Icon name="magnifying-glass" size="small" class="text-text-weak shrink-0" />
      <input
        type="text"
        class="flex-1 bg-transparent text-14-regular text-text-base placeholder:text-text-weaker outline-none"
        placeholder={language.t("plugins.search.placeholder")}
        value={props.query()}
        onInput={(e) => props.setQuery(e.currentTarget.value)}
      />
    </div>
  )
}

// 过滤栏(来源 tab + 漏斗分类下拉):与 Codex 一致放在 Installed 之下、分类列表之上。
function FilterBar(props: {
  marketplace: () => string | null
  setMarketplace: (v: string | null) => void
  category: () => string | null
  setCategory: (v: string | null) => void
  marketplaces: () => FilterOption[]
  categories: () => FilterOption[]
}): JSX.Element {
  const language = useLanguage()
  // workspace = 外部 marketplace(排除「By 万来 Code」聚合项与官方 registry)
  const workspaces = () =>
    props.marketplaces().filter(
      (o) => o.value !== BUILTIN_MARKETPLACE_VALUE && o.value !== OFFICIAL_REGISTRY_VALUE,
    )
  return (
    <div class="flex items-center justify-between gap-3">
      <SourceTabs value={props.marketplace} onChange={props.setMarketplace} workspaces={workspaces} />
      <FilterDropdown
        value={props.category}
        options={props.categories}
        onChange={props.setCategory}
        allLabel={language.t("plugins.filter.category.all")}
        emptyLabel={language.t("plugins.filter.category.empty")}
        groupLabel={language.t("plugins.filter.category.label")}
        triggerIcon="filter-funnel"
      />
    </div>
  )
}

// 单选 dropdown：value=null 表示「全部」；options 中的 label 已由父级预格式化好
// （marketplace 会把内置项聚合成「由 万来 Code 构建」，外部项各为「由 X 构建」）。
// 列表为空时 trigger 仍可点开，仅展示一条 emptyLabel 占位。
function FilterDropdown(props: {
  value: () => string | null
  options: () => FilterOption[]
  onChange: (v: string | null) => void
  allLabel: string
  emptyLabel: string
  groupLabel?: string
  triggerIcon?: IconName
}): JSX.Element {
  // RadioGroup 用 "" 表示「全部」（null 不能作为 RadioItem 的 value）。
  const radioValue = () => props.value() ?? ""
  const triggerLabel = () => {
    const v = props.value()
    if (!v) return props.allLabel
    return props.options().find((o) => o.value === v)?.label ?? v
  }
  return (
    <DropdownMenu placement="bottom-end" gutter={4}>
      <Show
        when={props.triggerIcon}
        fallback={
          <DropdownMenu.Trigger
            class="flex items-center gap-1.5 h-10 px-4 rounded-full bg-background-stronger border border-border-weak-base text-14-regular text-text-base hover:bg-surface-base"
            style={NO_DRAG}
          >
            <span>{triggerLabel()}</span>
            <Icon name="chevron-down" size="small" class="text-text-weak" />
          </DropdownMenu.Trigger>
        }
      >
        <DropdownMenu.Trigger
          class={`size-7 rounded-xl flex items-center justify-center transition-colors ${
            props.value()
              ? "bg-surface-base text-text-strong"
              : "text-text-weak hover:bg-surface-base"
          }`}
          style={NO_DRAG}
          aria-label={props.groupLabel}
        >
          <Icon name={props.triggerIcon!} size="small" />
        </DropdownMenu.Trigger>
      </Show>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="codex-chat-menu min-w-48">
          <Show when={props.groupLabel}>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="!px-1 !py-1">
                <span>{props.groupLabel}</span>
              </DropdownMenu.GroupLabel>
            </DropdownMenu.Group>
          </Show>
          <DropdownMenu.RadioGroup
            value={radioValue()}
            onChange={(v) => props.onChange(v === "" ? null : String(v))}
          >
            <DropdownMenu.RadioItem value="">
              <DropdownMenu.ItemLabel>{props.allLabel}</DropdownMenu.ItemLabel>
              <DropdownMenu.ItemIndicator>
                <Icon name="check-small" size="small" class="text-icon-weak" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
            <Show when={props.options().length > 0} fallback={
              <div class="px-3 py-2 text-13-regular text-text-weak">{props.emptyLabel}</div>
            }>
              <For each={props.options()}>
                {(opt) => (
                  <DropdownMenu.RadioItem value={opt.value}>
                    <DropdownMenu.ItemLabel>{opt.label}</DropdownMenu.ItemLabel>
                    <DropdownMenu.ItemIndicator>
                      <Icon name="check-small" size="small" class="text-icon-weak" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                )}
              </For>
            </Show>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function InstalledStrip(props: {
  items: AddonAvailable[]
  onManage: () => void
  onOpen: (key: string) => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <Show when={props.items.length > 0}>
      <section class="mt-2 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3 pb-2 border-b border-border-weak-base">
          <h2 class="text-16-medium text-text-strong">{language.t("plugins.section.installed")}</h2>
          <button
            type="button"
            class="size-7 rounded-lg flex items-center justify-center text-text-weak hover:bg-surface-base transition-colors"
            style={NO_DRAG}
            onClick={props.onManage}
            aria-label={language.t("plugins.action.manage")}
          >
            <Icon name="settings-gear" size="small" />
          </button>
        </div>
        <div class="flex items-start gap-2 flex-wrap pt-1 pb-5">
          <For each={props.items}>
            {(item) => {
              const iconBg = pickIconBg(item.name)
              const iconStyle = item.brand_color ? { "background-color": item.brand_color } : undefined
              return (
                <button
                  type="button"
                  class="group relative shrink-0"
                  style={NO_DRAG}
                  onClick={() => props.onOpen(item.key)}
                  title={displayName(item)}
                  aria-label={displayName(item)}
                >
                  {/* 图标:hover 整组时用 translate 属性上抬(v4 transition-transform 涵盖 translate) */}
                  <span class="block size-9 rounded-xl overflow-hidden border border-border-weak-base shadow-[0_4px_8px_-2px_rgba(0,0,0,0.1)] transition-transform duration-200 ease-out group-hover:[translate:0_-4px]">
                    <Show
                      when={item.logo}
                      fallback={
                        <div
                          class={`size-full flex items-center justify-center text-text-strong ${item.brand_color ? "" : iconBg}`}
                          style={iconStyle}
                        >
                          <Icon name="mcp" size="small" />
                        </div>
                      }
                    >
                      <img src={item.logo} alt={displayName(item)} class="size-full object-cover" loading="lazy" />
                    </Show>
                  </span>
                  {/* 名字:默认隐藏,hover 淡入,绝对定位于图标下方不占布局 */}
                  <span class="pointer-events-none absolute left-1/2 top-full -translate-x-1/2 whitespace-nowrap text-10-regular text-text-weak opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    {displayName(item)}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </section>
    </Show>
  )
}

const COLLAPSE_LIMIT = 6

// 仅当折叠能藏起 ≥3 项时才折叠;总数 ≤8 时全展示。
// 保证 See-more 行预览名恒 2 个、count = hidden-2 恒 ≥1,不会出现「…等另外 0/-1 个」,
// 也避免「为藏 1~2 项而显示 See more」的别扭体验。
function shouldCollapse(total: number): boolean {
  return total - COLLAPSE_LIMIT >= 3
}

function SeeMoreRow(props: { hidden: AddonAvailable[]; onExpand: () => void }): JSX.Element {
  const language = useLanguage()
  const preview = () => props.hidden.slice(0, 3)
  const names = () => props.hidden.slice(0, 2).map((a) => displayName(a)).join(", ")
  const remain = () => props.hidden.length - 2
  return (
    <button
      type="button"
      class="flex items-center gap-3 min-h-[60px] px-2 -mx-2 text-left text-14-regular text-text-weak hover:text-text-base transition-colors"
      aria-expanded={false}
      onClick={props.onExpand}
    >
      <span class="flex shrink-0 items-center">
        <For each={preview()}>
          {(item) => {
            const iconBg = pickIconBg(item.name)
            const iconStyle = item.brand_color ? { "background-color": item.brand_color } : undefined
            return (
              <span class="size-6 rounded-md overflow-hidden border border-border-weak-base bg-background-stronger first:ml-0 -ml-1.5 flex items-center justify-center">
                <Show
                  when={item.logo}
                  fallback={
                    <span class={`size-full flex items-center justify-center text-text-strong ${item.brand_color ? "" : iconBg}`} style={iconStyle}>
                      <Icon name="mcp" size="small" />
                    </span>
                  }
                >
                  <img src={item.logo} alt="" class="size-full object-cover" loading="lazy" />
                </Show>
              </span>
            )
          }}
        </For>
      </span>
      <span>{language.t("plugins.seeMore", { names: names(), count: remain() })}</span>
    </button>
  )
}

function CategorySection(props: {
  label: string
  items: AddonAvailable[]
  collapsed: boolean
  onInstall: (item: AddonAvailable) => void
  onOpen: (key: string) => void
  onTryInChat: (item: AddonAvailable) => void
  onUninstall: (item: AddonAvailable) => void
  uninstallingKey?: string
  migrationTargetFor?: (item: AddonAvailable) => RegistryPluginOut | undefined
  onMigrate?: (item: AddonAvailable) => void
  migratingKeys?: string[]
  statsFor?: (addon: AddonAvailable) => { installs: number; rating: number }
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const collapse = () => props.collapsed && shouldCollapse(props.items.length)
  const visible = createMemo(() => {
    if (!collapse() || expanded()) return props.items
    return props.items.slice(0, COLLAPSE_LIMIT)
  })
  const hidden = createMemo(() =>
    collapse() && !expanded() ? props.items.slice(COLLAPSE_LIMIT) : [],
  )
  return (
    <div class="flex flex-col">
      <div class="text-16-medium text-text-strong">{props.label}</div>
      <div class="mt-3 border-t border-border-weak-base" />
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
        <For each={visible()}>
          {(item) => (
            <PluginCard
              item={item}
              onInstall={() => props.onInstall(item)}
              onOpen={() => props.onOpen(item.key)}
              onTryInChat={() => props.onTryInChat(item)}
              onUninstall={() => props.onUninstall(item)}
              uninstalling={props.uninstallingKey === item.key}
              migrationTarget={props.migrationTargetFor?.(item)}
              onMigrate={() => props.onMigrate?.(item)}
              migrating={props.migratingKeys?.includes(item.key)}
              real={props.statsFor?.(item)}
              namespace={addonNamespaceFromKey(item.key)}
            />
          )}
        </For>
      </div>
      <Show when={hidden().length > 0}>
        <SeeMoreRow hidden={hidden()} onExpand={() => setExpanded(true)} />
      </Show>
    </div>
  )
}

function PluginCard(props: {
  item: AddonAvailable
  onInstall: () => void
  onOpen: () => void
  onTryInChat?: () => void
  onUninstall?: () => void
  uninstalling?: boolean
  migrationTarget?: RegistryPluginOut
  onMigrate?: () => void
  migrating?: boolean
  real: { installs: number; rating: number } | undefined
  namespace: string | undefined
}): JSX.Element {
  const language = useLanguage()
  const kind = () => statusKind(props.item)
  const iconBg = pickIconBg(props.item.name)
  const notInstallable = () =>
    !props.item.installed && props.item.installation === "NOT_AVAILABLE"
  const iconStyle = () =>
    props.item.brand_color ? { "background-color": props.item.brand_color } : undefined
  return (
    <div
      class="flex items-center gap-4 py-2.5 -mx-2 px-2 rounded-lg cursor-pointer hover:bg-surface-base transition-colors"
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
      <Show
        when={props.item.logo}
        fallback={
          <div
            class={`size-11 rounded-xl flex items-center justify-center shrink-0 text-text-strong ${
              props.item.brand_color ? "" : iconBg
            }`}
            style={iconStyle()}
          >
            <Icon name="mcp" size="small" />
          </div>
        }
      >
        <img
          src={props.item.logo}
          alt={displayName(props.item)}
          class="size-11 rounded-xl shrink-0 object-cover bg-surface-base"
          loading="lazy"
        />
      </Show>
      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <div class="flex items-baseline gap-1.5 min-w-0">
          <span class="text-14-medium text-text-strong truncate min-w-0">{displayName(props.item)}</span>
          <Show when={props.namespace}>
            {(namespace) => <span class="text-11-regular text-text-weak truncate shrink-0 max-w-32">@{namespace()}</span>}
          </Show>
        </div>
        <div class="text-13-regular text-text-weak truncate">
          {props.item.error ?? props.item.description ?? props.item.marketplace_name}
        </div>
        {/* 三分规则：builtin→mock；registry→真实；本地/personal→全 0 */}
        <PluginCardStats real={props.real} />
      </div>
      <div class="flex items-center gap-1.5 shrink-0" style={NO_DRAG}>
        <Show when={kind() === "error"}>
          <div
            class="size-7 rounded-full bg-surface-base flex items-center justify-center text-text-danger"
            title={props.item.error}
          >
            <Icon name="alert-circle" size="small" />
          </div>
        </Show>
        <Show when={props.migrationTarget}>
          <Tooltip placement="top" value={language.t("plugins.migrate.tooltip")} contentClass="max-w-64">
            <button
              type="button"
              class="h-7 px-2 rounded-lg border border-border-weak-base bg-background-stronger text-text-strong text-14-medium hover:bg-surface-base-active disabled:opacity-40 transition-colors whitespace-nowrap"
              title={language.t("plugins.migrate.title")}
              disabled={props.migrating}
              onClick={(e) => {
                e.stopPropagation()
                props.onMigrate?.()
              }}
            >
              {language.t("plugins.migrate")}
            </button>
          </Tooltip>
        </Show>
        <Show when={kind() === "enabled"}>
          <button
            type="button"
            class="h-7 px-2 rounded-lg border border-border-weak-base bg-background-stronger text-text-strong text-14-medium hover:bg-surface-base-active transition-colors whitespace-nowrap"
            onClick={(e) => {
              e.stopPropagation()
              props.onTryInChat?.()
            }}
          >
            {language.t("plugins.hero.tryInChat")}
          </button>
          <DropdownMenu placement="bottom-end" gutter={4}>
            <DropdownMenu.Trigger
              class="size-7 rounded-full flex items-center justify-center text-text-weak hover:bg-surface-base-active data-[state=open]:bg-surface-base-active transition-colors"
              aria-label={language.t("plugins.card.more")}
              onClick={(e) => e.stopPropagation()}
            >
              <Icon name="ellipsis-horizontal" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="codex-chat-menu min-w-44">
                <DropdownMenu.Item
                  onSelect={() => {
                    swallowNextClick()
                    props.onUninstall?.()
                  }}
                  disabled={props.uninstalling}
                >
                  <Icon name="trash" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>
                    {language.t("plugins.detail.uninstall")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Show>
        <Show when={kind() === "available" || kind() === "disabled"}>
          <button
            type="button"
            class="h-7 px-2 rounded-lg border border-border-weak-base bg-background-stronger text-text-strong text-14-medium hover:bg-surface-base-active disabled:opacity-40 transition-colors whitespace-nowrap"
            onClick={(e) => {
              e.stopPropagation()
              props.onInstall()
            }}
            disabled={notInstallable()}
            title={notInstallable() ? language.t("plugins.install.unavailable") : undefined}
          >
            {language.t("plugins.install")}
          </button>
        </Show>
      </div>
    </div>
  )
}

function PluginCardStats(props: { real: { installs: number; rating: number } | undefined }): JSX.Element {
  // 卡片紧凑形态:`↓ 12K · ★ 4.7`(评价数留给详情页)。
  // 三分规则：builtin→mock 假数据；registry→真实；本地/personal→全 0。始终显示。
  const stats = () => props.real ?? { installs: 0, rating: 0 }
  return (
    <div class="flex items-center gap-3 text-12-regular text-text-weaker mt-0.5">
      <span class="inline-flex items-center gap-1">
        <Icon name="download" size="small" />
        {formatInstallCount(stats().installs)}
      </span>
      <span class="inline-flex items-center gap-1">
        <span class="text-text-base">★</span>
        {stats().rating.toFixed(1)}
      </span>
    </div>
  )
}

function LoadingSkeleton(): JSX.Element {
  return (
    <div class="mt-6">
      <div class="h-72 rounded-2xl bg-surface-base animate-pulse" />
      <div class="mt-8 flex flex-col gap-3">
        <div class="h-5 w-24 bg-surface-base rounded animate-pulse" />
        <div class="border-t border-border-weak-base" />
        <For each={[0, 1, 2, 3]}>
          {() => (
            <div class="flex items-center gap-3 py-3">
              <div class="size-10 rounded-lg bg-surface-base animate-pulse shrink-0" />
              <div class="flex-1 flex flex-col gap-1">
                <div class="h-4 w-32 bg-surface-base rounded animate-pulse" />
                <div class="h-3 w-64 bg-surface-base rounded animate-pulse" />
              </div>
              <div class="size-8 rounded-full bg-surface-base animate-pulse shrink-0" />
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function EmptyState(props: { onManage: () => void }): JSX.Element {
  const language = useLanguage()
  return (
    <div class="mt-16 flex flex-col items-center gap-4">
      <div class="text-16-medium text-text-strong">{language.t("plugins.empty.title")}</div>
      <div class="text-14-regular text-text-weak text-center max-w-md">
        {language.t("plugins.empty.description")}
      </div>
      <Button icon="settings-gear" size="normal" variant="secondary" onClick={props.onManage}>
        {language.t("plugins.action.manage")}
      </Button>
    </div>
  )
}

function NoMarketplaceHint(): JSX.Element {
  const language = useLanguage()
  return (
    <div class="mt-4 px-4 py-3 rounded-md bg-surface-base text-13-regular text-text-weak">
      <div class="font-medium text-text-base">{language.t("plugins.noMarket.title")}</div>
      <div class="mt-1">{language.t("plugins.noMarket.description")}</div>
    </div>
  )
}

// Skills tab —— 列出所有 enabled addon 的 skills，支持启用/禁用 + 创建本地 skill。
// 分组规则跟 marketplace category 走；缺 category 的归到 "Personal"。
function SkillsTab(): JSX.Element {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const queryClient = useQueryClient()
  const [skillQuery, setSkillQuery] = createSignal("")

  const skills = createQuery(() => ({
    queryKey: ["addon", "skills", "global"],
    queryFn: async () => {
      const result = await sdk.client.addon.skills()
      return result.data ?? []
    },
  }))

  // app.skills 返回所有来源 skill(含 builtin);筛出内置 skill 供「系统」tab 使用。
  const appSkills = createQuery(() => ({
    queryKey: ["app", "skills", "global"],
    queryFn: async () => (await sdk.client.app.skills()).data ?? [],
  }))

  const builtinSkills = createMemo(() =>
    (appSkills.data ?? []).filter((s) => s.source === "builtin"),
  )

  const filteredBuiltin = createMemo(() => {
    const all = builtinSkills()
    const q = skillQuery().trim().toLowerCase()
    if (!q) return all
    return all.filter((s) => {
      const text = `${s.name} ${s.displayName ?? ""} ${s.description ?? ""}`.toLowerCase()
      return text.includes(q)
    })
  })

  const filtered = createMemo(() => {
    const all = skills.data ?? []
    const q = skillQuery().trim().toLowerCase()
    if (!q) return all
    return all.filter((s) => {
      const text = `${s.namespaced_name} ${s.display_name ?? ""} ${s.description ?? ""}`.toLowerCase()
      return text.includes(q)
    })
  })

  const sortSkills = (arr: AddonSkillListItem[]) =>
    [...arr].sort((a, b) =>
      (a.display_name ?? a.namespaced_name).localeCompare(b.display_name ?? b.namespaced_name),
    )

  // 搜索激活时全展开不折叠
  const hasSkillFilter = () => skillQuery().trim().length > 0

  // 已安装 = addon 技能中当前已安装/启用的项,对齐顶部「已安装」区
  const installedSkills = createMemo(() => sortSkills(filtered().filter((item) => item.installed ?? true)))
  const installedDirectorySkills = createMemo(() =>
    installedSkills().map((item): SkillDirectoryItem => ({ kind: "addon", item })),
  )

  // 三个来源视图:全部 / 系统内置 / 个人创建。默认「全部」。
  const [skillTab, setSkillTab] = createSignal<SkillSourceTab>("all")
  const addonDirectorySkills = createMemo(() =>
    sortSkills(filtered()).map((item): SkillDirectoryItem => ({ kind: "addon", item })),
  )
  const personalDirectorySkills = createMemo(() =>
    sortSkills(filtered().filter(isPersonalSkill)).map((item): SkillDirectoryItem => ({ kind: "addon", item })),
  )
  const systemDirectorySkills = createMemo(() =>
    sortDirectorySkills(filteredBuiltin().map((item): SkillDirectoryItem => ({ kind: "system", item }))),
  )
  const allSourceSkills = createMemo(() =>
    sortDirectorySkills([...addonDirectorySkills(), ...systemDirectorySkills()]),
  )

  const toggleSkill = useMutation(() => ({
    mutationFn: async (input: { item: AddonSkillListItem; enabled: boolean }) =>
      sdk.client.addon.skillToggle({
        addonSkillToggleRequest: {
          addon_key: input.item.addon_key,
          name: input.item.name,
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
        title: language.t("plugins.install.failed"),
        description: err instanceof Error ? err.message : String(err),
      }),
  }))

  const installSkill = useMutation(() => ({
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
        title: language.t("plugins.install.failed"),
        description: err instanceof Error ? err.message : String(err),
      }),
  }))

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
          ((toggleSkill.isPending &&
            toggleSkill.variables?.item.namespaced_name === item.item.namespaced_name) ||
            (installSkill.isPending &&
              installSkill.variables?.item.namespaced_name === item.item.namespaced_name))
        }
        onToggle={(addonSkill, enabled) => toggleSkill.mutate({ item: addonSkill, enabled })}
        onInstall={(addonSkill, installed) => installSkill.mutate({ item: addonSkill, installed })}
        onTry={(name, title) => navigate(`/?prompt=${encodeURIComponent(skillMention(title, name))}`)}
      />
    ))

  const onCreate = () => {
    // 优先选已加载且可写的 addon —— 至少要有一个安装好的 addon 才能创建 skill
    const candidates = Array.from(new Set((skills.data ?? []).map((s) => s.addon_key)))
    if (candidates.length === 0) {
      showToast({
        title: language.t("plugins.skills.create.title"),
        description: language.t("plugins.skills.create.noAddon"),
      })
      return
    }
    dialog.show(() => (
      <CreateSkillDialog
        addons={candidates.map((key) => {
          const sample = (skills.data ?? []).find((s) => s.addon_key === key)
          return {
            key,
            display: sample?.addon_display_name ?? sample?.addon_name ?? key,
          }
        })}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["addon", "skills", "global"] })}
      />
    ))
  }
  // 「新建技能」按钮已从技能页移除;onCreate / CreateSkillDialog 保留待未来从别处(如右上角 + 胶囊)重新接入。
  void onCreate

  return (
    <>
      <div class="mt-12 mb-6">
        <h1
          class="text-text-strong tracking-tight"
          style={{ "font-size": "28px", "font-weight": "400", "line-height": "1.2" }}
        >
          {language.t("plugins.skills.title")}
        </h1>
        <div class="mt-1 text-15-regular text-text-weak">
          {language.t("plugins.skills.subtitle")}
        </div>
      </div>

      <div class="sticky top-0 z-10 bg-background-stronger pt-2 pb-4 -mx-6 px-6">
        <div
          class="flex items-center gap-2 px-4 h-8 bg-background-stronger rounded-full border border-border-weak-base"
          style={NO_DRAG}
        >
          <Icon name="magnifying-glass" size="small" class="text-text-weak shrink-0" />
          <input
            type="text"
            class="flex-1 bg-transparent text-14-regular text-text-base placeholder:text-text-weaker outline-none"
            placeholder={language.t("plugins.skills.search.placeholder")}
            value={skillQuery()}
            onInput={(e) => setSkillQuery(e.currentTarget.value)}
          />
        </div>
      </div>

      <Show when={skills.isError}>
        <div class="mt-4 px-4 py-3 rounded-md bg-surface-base text-13-regular text-text-danger break-all">
          {language.t("plugins.skills.error.load")}
          {": "}
          {skills.error instanceof Error ? skills.error.message || skills.error.name : String(skills.error)}
        </div>
      </Show>

      <Show when={skills.isLoading}>
        <LoadingSkeleton />
      </Show>

      <Show when={!skills.isLoading && !skills.isError}>
        <Show when={(skills.data ?? []).length === 0 && builtinSkills().length === 0}>
          <div class="mt-16 flex flex-col items-center gap-3">
            <div class="text-16-medium text-text-strong">{language.t("plugins.skills.empty.title")}</div>
            <div class="text-14-regular text-text-weak text-center max-w-md">
              {language.t("plugins.skills.empty.description")}
            </div>
          </div>
        </Show>

        <Show when={((skills.data ?? []).length > 0 || builtinSkills().length > 0) && filtered().length === 0 && filteredBuiltin().length === 0}>
          <div class="text-14-regular text-text-weak py-12 text-center">
            {language.t("plugins.skills.empty.search")}
          </div>
        </Show>

        <Show when={((skills.data ?? []).length > 0 || builtinSkills().length > 0) && (filtered().length > 0 || filteredBuiltin().length > 0)}>
          <div class="mt-6 flex flex-col gap-10">
            {/* 已安装 —— 全部已安装技能(个人 + 系统内置)汇总 */}
            <div class="flex flex-col">
              <div class="text-16-medium text-text-strong">{language.t("plugins.section.installed")}</div>
              <div class="mt-3 border-t border-border-weak-base" />
              <div class="mt-3">
                <SkillDirectoryGrid
                  items={installedDirectorySkills()}
                  collapsed={!hasSkillFilter()}
                  pendingName={installSkill.variables?.item.namespaced_name ?? toggleSkill.variables?.item.namespaced_name}
                  onInstall={(item) => installSkill.mutate({ item, installed: true })}
                  onOpen={openSkillDetail}
                />
              </div>
            </div>

            {/* 全部 / 系统内置 / 个人创建分来源筛选,三 tab 常驻 */}
            <div class="flex flex-col gap-4">
              <SkillSourceTabs value={skillTab} onChange={setSkillTab} />
              <Show when={skillTab() === "all"}>
                <Show
                  when={allSourceSkills().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-weak py-12 text-center">
                      {language.t("plugins.skills.source.empty")}
                    </div>
                  }
                >
                  <SkillDirectoryGrid
                    items={allSourceSkills()}
                    collapsed={!hasSkillFilter()}
                    pendingName={installSkill.variables?.item.namespaced_name ?? toggleSkill.variables?.item.namespaced_name}
                    onInstall={(item) => installSkill.mutate({ item, installed: true })}
                    onOpen={openSkillDetail}
                  />
                </Show>
              </Show>
              <Show when={skillTab() === "personal"}>
                <Show
                  when={personalDirectorySkills().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-weak py-12 text-center">
                      {language.t("plugins.skills.source.empty")}
                    </div>
                  }
                >
                  <SkillDirectoryGrid
                    items={personalDirectorySkills()}
                    collapsed={!hasSkillFilter()}
                    pendingName={installSkill.variables?.item.namespaced_name ?? toggleSkill.variables?.item.namespaced_name}
                    onInstall={(item) => installSkill.mutate({ item, installed: true })}
                    onOpen={openSkillDetail}
                  />
                </Show>
              </Show>
              <Show when={skillTab() === "system"}>
                <Show
                  when={systemDirectorySkills().length > 0}
                  fallback={
                    <div class="text-14-regular text-text-weak py-12 text-center">
                      {language.t("plugins.skills.source.empty")}
                    </div>
                  }
                >
                  <SkillDirectoryGrid
                    items={systemDirectorySkills()}
                    collapsed={!hasSkillFilter()}
                    onOpen={openSkillDetail}
                  />
                </Show>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </>
  )
}

type SkillSourceTab = "all" | "system" | "personal"

const SKILL_SOURCE_ORDER: SkillSourceTab[] = ["all", "system", "personal"]

function SkillSourceTabs(props: {
  value: () => SkillSourceTab
  onChange: (v: SkillSourceTab) => void
}): JSX.Element {
  const language = useLanguage()
  const label = (t: SkillSourceTab) =>
    t === "all"
      ? language.t("plugins.skills.source.all")
      : t === "system"
        ? language.t("plugins.skills.source.system")
        : language.t("plugins.skills.section.personal")
  const cls = (active: boolean) =>
    `h-8 px-3 rounded-full text-14-medium whitespace-nowrap transition-colors ${
      active ? "bg-surface-base text-text-strong" : "text-text-weak hover:text-text-base"
    }`
  return (
    <div role="tablist" aria-label="Skill directory" class="flex items-center gap-2 overflow-x-auto hide-scrollbar">
      <For each={SKILL_SOURCE_ORDER}>
        {(t) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.value() === t}
            class={cls(props.value() === t)}
            style={NO_DRAG}
            onClick={() => props.onChange(t)}
          >
            {label(t)}
          </button>
        )}
      </For>
    </div>
  )
}

function SkillDirectoryGrid(props: {
  items: SkillDirectoryItem[]
  collapsed: boolean
  pendingName?: string
  onInstall?: (item: AddonSkillListItem) => void
  onOpen?: (item: SkillDirectoryItem) => void
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const collapse = () => props.collapsed && shouldCollapse(props.items.length)
  const visible = createMemo(() =>
    !collapse() || expanded() ? props.items : props.items.slice(0, COLLAPSE_LIMIT),
  )
  const hidden = createMemo(() =>
    collapse() && !expanded() ? props.items.slice(COLLAPSE_LIMIT) : [],
  )
  return (
    <div class="flex flex-col">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
        <For each={visible()}>
          {(entry) =>
            entry.kind === "addon" ? (
              <SkillRow
                item={entry.item}
                pending={props.pendingName === entry.item.namespaced_name}
                onInstall={() => props.onInstall?.(entry.item)}
                onOpen={() => props.onOpen?.(entry)}
              />
            ) : (
              <BuiltinSkillItemRow item={entry.item} onOpen={() => props.onOpen?.(entry)} />
            )
          }
        </For>
      </div>
      <Show when={hidden().length > 0}>
        <SkillDirectorySeeMoreRow hidden={hidden()} onExpand={() => setExpanded(true)} />
      </Show>
    </div>
  )
}

function SkillDirectorySeeMoreRow(props: { hidden: SkillDirectoryItem[]; onExpand: () => void }): JSX.Element {
  const language = useLanguage()
  const names = () => props.hidden.slice(0, 2).map(directoryItemTitle).join(", ")
  const remain = () => props.hidden.length - 2
  return (
    <button
      type="button"
      class="flex items-center min-h-[44px] px-2 -mx-2 text-left text-14-regular text-text-weak hover:text-text-base transition-colors"
      aria-expanded={false}
      onClick={props.onExpand}
    >
      <span>{language.t("plugins.seeMore", { names: names(), count: remain() })}</span>
    </button>
  )
}

function SkillRow(props: {
  item: AddonSkillListItem
  pending?: boolean
  onInstall?: () => void
  onOpen?: () => void
}): JSX.Element {
  const language = useLanguage()
  const iconBg = pickIconBg(props.item.addon_name)
  const iconStyle = () =>
    props.item.brand_color ? { "background-color": props.item.brand_color } : undefined
  const title = () => props.item.display_name?.trim() || props.item.namespaced_name
  const installed = () => props.item.installed ?? true
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onOpen?.()
  }
  return (
    <div
      role="button"
      tabIndex={0}
      class="w-full flex items-center gap-4 py-2.5 text-left rounded-md hover:bg-surface-base/60 transition-colors"
      onClick={props.onOpen}
      onKeyDown={onKeyDown}
    >
      <Show
        when={props.item.logo}
        fallback={
          <div
            class={`size-11 rounded-xl flex items-center justify-center shrink-0 text-text-strong ${
              props.item.brand_color ? "" : iconBg
            }`}
            style={iconStyle()}
          >
            <Icon name="mcp" size="small" />
          </div>
        }
      >
        <img
          src={props.item.logo}
          alt={title()}
          class="size-11 rounded-xl shrink-0 object-cover bg-surface-base"
          loading="lazy"
        />
      </Show>
      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <div class="text-14-medium text-text-strong truncate">{title()}</div>
        <div class="text-13-regular text-text-weak truncate">{props.item.description}</div>
      </div>
      <Show
        when={installed()}
        fallback={
          <button
            type="button"
            class="h-8 px-3 rounded-md bg-surface-base text-13-medium text-text-strong hover:bg-surface-base/80 disabled:opacity-50 shrink-0"
            disabled={props.pending}
            onClick={(event) => {
              event.stopPropagation()
              props.onInstall?.()
            }}
          >
            {language.t("plugins.install")}
          </button>
        }
      >
        {/* 启用状态静态指示(与插件卡片 enabled 态一致):无底色、不可点。 */}
        <Show when={props.item.enabled}>
          <div class="size-9 rounded-full flex items-center justify-center text-text-strong shrink-0">
            <Icon name="check-small" size="small" />
          </div>
        </Show>
      </Show>
    </div>
  )
}

// 单行内置 skill:图标(有则 img,无则首字母占位)+ displayName/name + description + 「内置」标签。
function BuiltinSkillItemRow(props: { item: AppSkillItem; onOpen?: () => void }): JSX.Element {
  const language = useLanguage()
  const title = () => props.item.displayName?.trim() || props.item.name
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onOpen?.()
  }
  return (
    <div
      role="button"
      tabIndex={0}
      class="w-full flex items-center gap-4 py-2.5 text-left rounded-md hover:bg-surface-base/60 transition-colors"
      onClick={props.onOpen}
      onKeyDown={onKeyDown}
    >
      <Show
        when={props.item.icon}
        fallback={
          <div class="size-11 rounded-xl flex items-center justify-center shrink-0 text-text-strong bg-surface-base">
            <span class="text-14-medium">{(title().charAt(0) || "?").toUpperCase()}</span>
          </div>
        }
      >
        <img
          src={props.item.icon}
          alt={title()}
          class="size-11 rounded-xl shrink-0 object-cover bg-surface-base"
          loading="lazy"
        />
      </Show>
      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <div class="flex items-center gap-2">
          <span class="text-14-medium text-text-strong truncate">{title()}</span>
          <span class="shrink-0 text-11-regular text-text-weak px-1.5 py-0.5 rounded bg-surface-base">
            {language.t("plugins.skills.badge.builtin")}
          </span>
        </div>
        <div class="text-13-regular text-text-weak truncate">{props.item.description}</div>
      </div>
    </div>
  )
}

function CreateSkillDialog(props: {
  addons: { key: string; display: string }[]
  onCreated: () => void
}): JSX.Element {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const [addonKey, setAddonKey] = createSignal(props.addons[0]?.key ?? "")
  const [name, setName] = createSignal("")
  const [displayName, setDisplayName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [content, setContent] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  const valid = () =>
    addonKey().length > 0 &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(name().trim()) &&
    description().trim().length > 0

  const onSubmit = async (e: Event) => {
    e.preventDefault()
    if (!valid() || submitting()) return
    setSubmitting(true)
    try {
      const result = await sdk.client.addon.skillCreate({
        addonSkillCreateRequest: {
          addon_key: addonKey(),
          name: name().trim(),
          display_name: displayName().trim() || undefined,
          description: description().trim(),
          content: content().trim() || undefined,
        },
      })
      if (result.error) {
        showToast({
          variant: "error",
          title: language.t("plugins.skills.create.failed"),
          description: (result.error as { error?: string }).error ?? String(result.error),
        })
        return
      }
      showToast({
        title: language.t("plugins.skills.create.succeeded"),
        description: result.data?.namespaced_name,
      })
      props.onCreated()
      dialog.close()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("plugins.skills.create.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="w-[480px] max-w-[90vw] flex flex-col gap-4 p-6">
      <div class="text-16-medium text-text-strong">{language.t("plugins.skills.create.title")}</div>
      <form class="flex flex-col gap-3" onSubmit={onSubmit}>
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("plugins.skills.create.addon")}</span>
          <select
            class="h-9 px-3 rounded-md bg-surface-base border border-border-weak-base text-14-regular text-text-strong outline-none"
            value={addonKey()}
            onChange={(e) => setAddonKey(e.currentTarget.value)}
          >
            <For each={props.addons}>
              {(a) => <option value={a.key}>{a.display}</option>}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("plugins.skills.create.name")}</span>
          <input
            type="text"
            class="h-9 px-3 rounded-md bg-surface-base border border-border-weak-base text-14-regular text-text-strong outline-none"
            placeholder="my-skill"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <span class="text-12-regular text-text-weaker">{language.t("plugins.skills.create.nameHint")}</span>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("plugins.skills.create.displayName")}</span>
          <input
            type="text"
            class="h-9 px-3 rounded-md bg-surface-base border border-border-weak-base text-14-regular text-text-strong outline-none"
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("plugins.skills.create.description")}</span>
          <input
            type="text"
            class="h-9 px-3 rounded-md bg-surface-base border border-border-weak-base text-14-regular text-text-strong outline-none"
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("plugins.skills.create.content")}</span>
          <textarea
            class="h-32 px-3 py-2 rounded-md bg-surface-base border border-border-weak-base text-14-regular text-text-strong outline-none resize-none font-mono"
            placeholder={language.t("plugins.skills.create.contentPlaceholder")}
            value={content()}
            onInput={(e) => setContent(e.currentTarget.value)}
          />
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => dialog.close()} size="normal">
            {language.t("plugins.skills.create.cancel")}
          </Button>
          <Button type="submit" disabled={!valid() || submitting()} size="normal">
            {submitting()
              ? language.t("plugins.skills.create.submitting")
              : language.t("plugins.skills.create.submit")}
          </Button>
        </div>
      </form>
    </div>
  )
}
