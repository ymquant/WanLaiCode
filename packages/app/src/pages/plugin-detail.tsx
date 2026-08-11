import { createMemo, createSignal, For, Show, type ComponentProps, type JSX } from "solid-js"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { showToast } from "@opencode-ai/ui/toast"
import type {
  AddonAvailable,
  AddonDetail,
  AddonMcpServer,
  AddonSkill,
  RegistryPluginDetail,
} from "@opencode-ai/sdk/v2"
import { DialogInstallAddon } from "@/components/dialog-install-addon"
import { useRegistryNamespaceGate } from "@/components/dialog-registry-namespace"
import { RegistryManageVersionsButton, RegistryVersionsDialog } from "@/components/registry-version-manager"
import { PluginSocial } from "@/components/plugin-social"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { formatServerError } from "@/utils/server-errors"
import { finiteNum, formatInstallCount, formatReviewCount, mockStatsFor } from "@/utils/marketplace-stats"
import { pluginCategoryLabel } from "@/utils/plugin-category"
import { buildPluginMention } from "@opencode-ai/core/util/mention"
import { addonMentionKey } from "@/utils/plugin-migration"

type IconName = ComponentProps<typeof Icon>["name"]

const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

function displayName(info: AddonAvailable | AddonDetail): string {
  return info.display_name?.trim() || info.name || info.key
}

function addonNamespaceFromKey(addonKey: string): string | undefined {
  const marketStart = addonKey.lastIndexOf("@")
  if (marketStart < 0) return undefined
  const namespaceStart = addonKey.indexOf("/", marketStart + 1)
  if (namespaceStart < 0) return undefined
  return addonKey.slice(namespaceStart + 1).trim() || undefined
}

// Information 区 link 行展示用 —— 拿 host 名比完整 URL 更易读;
// URL 解析失败(罕见,但 marketplace 元数据来源不可信)落回原字符串。
function hostOf(href: string): string {
  try {
    return new URL(href).host
  } catch {
    return href
  }
}

export default function PluginDetail() {
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const queryClient = useQueryClient()
  const platform = usePlatform()
  const layout = useLayout()
  const params = useParams<{ key: string }>()
  const [searchParams] = useSearchParams<{ source?: string; namespace?: string; slug?: string }>()

  // Detect registry source
  const isRegistry = () => searchParams.source === "registry" && !!searchParams.namespace && !!searchParams.slug
  const registryNamespace = () => searchParams.namespace ?? ""
  const registrySlug = () => searchParams.slug ?? ""

  // 路由参数是 encodeURIComponent 后的 <addon>@<marketplace>/<namespace>
  const addonKey = createMemo(() => decodeURIComponent(params.key))

  // 与 plugins.tsx 共用同一份 query cache —— 列表页已经预热过，详情直读不再触发请求。
  // 始终启用：registry 详情也要据此判断官方插件是否已安装。
  const list = createQuery(() => ({
    queryKey: ["addon", "available", "global", language.locale()],
    queryFn: async () => {
      const result = await sdk.client.addon.available({ locale: language.locale() })
      return result.data ?? []
    },
  }))

  const available = createMemo<AddonAvailable | undefined>(() => list.data?.find((p) => p.key === addonKey()))

  // installed 后才有运行时 detail（mcp_servers / skills / hooks 列表）
  const detail = createQuery(() => ({
    queryKey: ["addon", "detail", addonKey()],
    enabled: !isRegistry() && !!available()?.installed,
    queryFn: async () => {
      const result = await sdk.client.addon.get({ key: addonKey() })
      return result.data
    },
  }))

  // Registry plugin detail query (only when source=registry)
  const registryDetail = createQuery(() => ({
    queryKey: ["registry", "plugin", registryNamespace(), registrySlug(), language.locale()],
    enabled: isRegistry(),
    queryFn: async () => {
      const res = await sdk.client.registry.getPlugin({
        namespace: registryNamespace(),
        slug: registrySlug(),
        locale: language.locale(),
      })
      if (res.error) throw res.error
      return res.data ?? null
    },
  }))

  const registryMe = createQuery(() => ({
    queryKey: ["registry", "me"],
    enabled: isRegistry() || available()?.marketplace_name === "personal",
    retry: false,
    queryFn: async () => {
      const res = await sdk.client.registry.me()
      if (res.error) throw res.error
      return res.data ?? null
    },
  }))

  const personalRegistryTarget = createMemo(() => {
    const info = available()
    if (isRegistry() || info?.marketplace_name !== "personal" || !registryMe.data?.namespace) return undefined
    return { namespace: registryMe.data.namespace, slug: info.name }
  })

  const personalRegistryDetail = createQuery(() => ({
    queryKey: ["registry", "plugin", personalRegistryTarget()?.namespace, personalRegistryTarget()?.slug, language.locale()],
    enabled: !!personalRegistryTarget(),
    retry: false,
    queryFn: async () => {
      const target = personalRegistryTarget()
      if (!target) return null
      const res = await sdk.client.registry.getPlugin({
        namespace: target.namespace,
        slug: target.slug,
        locale: language.locale(),
      })
      if (res.error) throw res.error
      return res.data ?? null
    },
  }))

  // macOS 折叠 sidebar 时左侧让位浮动 chrome（与 plugins.tsx 同算法）
  const leadingPad = () => {
    const isMac = platform.platform === "desktop" && platform.os !== "windows"
    if (!isMac) return 8
    return layout.sidebar.opened() ? 8 : 252
  }

  // refetchType:"all" 让 inactive 页(如未挂载的 Manage 页)也立即后台重拉,而非只标 stale。
  const invalidateAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["addon", "available", "global"], refetchType: "all" }),
      queryClient.invalidateQueries({ queryKey: ["addon", "list", "global"], refetchType: "all" }),
      queryClient.invalidateQueries({ queryKey: ["addon", "detail", addonKey()], refetchType: "all" }),
    ])

  const dialog = useDialog()
  const ensureRegistryNamespace = useRegistryNamespaceGate()
  const [openingVersionManager, setOpeningVersionManager] = createSignal(false)
  const onOpenInstall = () => {
    const info = available()
    if (!info) return
    dialog.show(() => <DialogInstallAddon addon={info} onInstalled={() => invalidateAll()} />)
  }

  const uninstall = useMutation(() => ({
    mutationFn: async () => sdk.client.addon.uninstall({ addonInstallRequest: { addon_key: addonKey() } }),
    onSuccess: () => invalidateAll(),
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.uninstall.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const uploadPlugin = useMutation(() => ({
    mutationFn: async () => {
      const res = await sdk.client.registry.publish({ registryPublishRequest: { addon_key: addonKey() } })
      if (res.error) throw new Error(String((res.error as { error?: string }).error ?? res.error))
      return res.data
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["registry", "plugins"], refetchType: "all" })
      queryClient.invalidateQueries({ queryKey: ["registry", "myPlugins"], refetchType: "all" })
      const target = personalRegistryTarget()
      if (target) {
        queryClient.invalidateQueries({
          queryKey: ["registry", "plugin", target.namespace, target.slug, language.locale()],
          refetchType: "all",
        })
        const res = await sdk.client.registry.getPlugin({
          namespace: target.namespace,
          slug: target.slug,
          locale: language.locale(),
        })
        if (res.data) queryClient.setQueryData(["registry", "plugin", target.namespace, target.slug, language.locale()], res.data)
      }
      showToast({ variant: "success", title: language.t("plugins.detail.upload.success") })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.detail.upload.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const uploadCurrentPlugin = async () => {
    try {
      const namespace = await ensureRegistryNamespace()
      if (!namespace) return
      uploadPlugin.mutate()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("plugins.namespace.checkFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    }
  }

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
      queryClient.invalidateQueries({
        queryKey: ["registry", "plugin"],
        refetchType: "all",
      })
      queryClient.invalidateQueries({ queryKey: ["registry", "plugins"], refetchType: "all" })
      showToast({ variant: "success", title: language.t("plugins.detail.versions.deleteSuccess") })
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.detail.versions.deleteFailed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  // 官方市场插件安装：下载并装入本地 addon 体系；装好后 available() 会出现 slug@wanlaicode 已安装项。
  const installRegistry = useMutation(() => ({
    mutationFn: async () => {
      const res = await sdk.client.registry.install({
        registryInstallRequest: { namespace: registryNamespace(), slug: registrySlug() },
      })
      if (res.error) throw res.error
    },
    onSuccess: () => {
      showToast({ variant: "success", title: language.t("plugins.install.success") })
      void invalidateAll()
    },
    onError: (err) =>
      showToast({
        variant: "error",
        title: language.t("plugins.install.failed"),
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      }),
  }))

  const registryName = () => registryDetail.data?.display_name ?? `${registryNamespace()}/${registrySlug()}`
  const versionManageTarget = createMemo(() => {
    if (isRegistry()) return { namespace: registryNamespace(), slug: registrySlug(), detail: registryDetail.data ?? null }
    const target = personalRegistryTarget()
    if (!target) return undefined
    return { ...target, detail: personalRegistryDetail.data ?? null }
  })
  const canManageRegistryVersions = () => {
    const target = versionManageTarget()
    if (!target) return false
    return registryMe.data?.namespace === target.namespace || registryMe.data?.role === "admin"
  }
  const showVersionManagerButton = () =>
    canManageRegistryVersions() && (isRegistry() || personalRegistryDetail.isLoading || !!personalRegistryDetail.data)
  const openVersionManager = async () => {
    if (openingVersionManager()) return
    const target = versionManageTarget()
    if (!target || !canManageRegistryVersions()) return
    setOpeningVersionManager(true)
    try {
      const res = await sdk.client.registry.getPlugin({
        namespace: target.namespace,
        slug: target.slug,
        locale: language.locale(),
      })
      if (res.error || !res.data) {
        showToast({
          variant: "error",
          title: language.t("plugins.detail.versions.openFailed"),
          description: formatServerError(
            res.error ?? personalRegistryDetail.error ?? registryDetail.error,
            language.t,
            language.t("common.requestFailed"),
          ),
        })
        return
      }
      queryClient.setQueryData(["registry", "plugin", target.namespace, target.slug, language.locale()], res.data)
      dialog.show(() => (
        <RegistryVersionsDialog
          versions={res.data.versions}
          deleting={deleteVersion.isPending}
          onDeleteVersion={async (version) => {
            await deleteVersion.mutateAsync({ namespace: target.namespace, slug: target.slug, version })
          }}
        />
      ))
    } finally {
      setOpeningVersionManager(false)
    }
  }

  // hero prompt pill 点击：与列表页一致——已装则跳散对话并 prefill `[@name](plugin://key) <prompt>`；
  // 未装则触发安装（registry 走下载安装，本地 marketplace 项走安装对话框）。
  const onTryPrompt = (prompt: string) => {
    const info = available()
    if (info?.installed) {
      navigate(`/?prompt=${encodeURIComponent(`${buildPluginMention(info.name, addonMentionKey(info))} ${prompt}`)}`)
      return
    }
    if (isRegistry()) {
      installRegistry.mutate()
      return
    }
    onOpenInstall()
  }
  const showUploadButton = () => available()?.marketplace_name === "personal"

  return (
    // header 不放进 scroll 容器,避免 scrollbar 视觉覆盖右上角 header(与 plugins.tsx 同因)
    <div class="size-full flex flex-col min-h-0">
      {/* header 设 no-drag(与 session.tsx 一致):drag 区会在折叠 sidebar 时盖住左上 chrome 按钮致其失效;
          拖窗交给 layout.tsx 顶部全局拖拽条。 */}
      <div
        class="shrink-0 z-20 bg-background-stronger pr-3 h-12 flex items-center justify-between"
        style={
          {
            "padding-left": `${leadingPad()}px`,
            "-webkit-app-region": "no-drag",
          } as Record<string, string>
        }
      >
        <Show
          when={isRegistry()}
          fallback={
            <Breadcrumb
              name={available() ? displayName(available()!) : addonKey()}
              onBack={() => navigate("/plugins")}
            />
          }
        >
          <Breadcrumb name={registryName()} onBack={() => navigate("/plugins")} />
        </Show>
        <Show when={!isRegistry()}>
          <div class="flex items-center gap-2" style={NO_DRAG}>
            <DetailUploadButton
              visible={showUploadButton()}
              uploading={uploadPlugin.isPending}
              onUpload={() => void uploadCurrentPlugin()}
            />
            <RegistryManageVersionsButton
              visible={showVersionManagerButton()}
              loading={personalRegistryDetail.isLoading || openingVersionManager()}
              onManage={() => void openVersionManager()}
            />
            <PrimaryAction
              available={available()}
              installing={false}
              uninstalling={uninstall.isPending}
              onInstall={onOpenInstall}
              onUninstall={() => uninstall.mutate()}
            />
          </div>
        </Show>
        <Show when={isRegistry()}>
          <div class="flex items-center gap-2" style={NO_DRAG}>
            <DetailUploadButton
              visible={showUploadButton()}
              uploading={uploadPlugin.isPending}
              onUpload={() => void uploadCurrentPlugin()}
            />
            <RegistryManageVersionsButton
              visible={showVersionManagerButton()}
              loading={registryDetail.isLoading || openingVersionManager()}
              onManage={() => void openVersionManager()}
            />
            <Show
              when={available()?.installed}
              fallback={
                <button
                  type="button"
                  class="h-8 px-3 rounded-full bg-text-strong text-background-stronger text-14-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
                  disabled={installRegistry.isPending}
                  onClick={() => installRegistry.mutate()}
                >
                  <Show when={!installRegistry.isPending} fallback={language.t("plugins.installing")}>
                    {language.t("plugins.detail.add")}
                  </Show>
                </button>
              }
            >
              {/* 已安装：复用 PrimaryAction 的「已安装 ▾ → 卸载」下拉（registry 装入后 key 同为 slug@wanlaicode） */}
              <PrimaryAction
                available={available()}
                installing={false}
                uninstalling={uninstall.isPending}
                onInstall={() => {}}
                onUninstall={() => uninstall.mutate()}
              />
            </Show>
          </div>
        </Show>
      </div>

      {/* scrollbar-gutter: stable 让 scroll 容器在 scrollbar 出现/消失时不挤压内容宽度,
          macOS 设置为"始终显示滚动条"时,以及 mouse hover 触发 overlay scrollbar 时都不抖动 */}
      <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        <div class="mx-auto w-full max-w-4xl px-6 pb-16">
          {/* Registry plugin detail branch */}
          <Show when={isRegistry()}>
            <Show when={registryDetail.isLoading}>
              <DetailSkeleton />
            </Show>
            <Show when={registryDetail.isError}>
              <div class="mt-8 px-4 py-3 rounded-md bg-surface-base text-13-regular text-text-danger break-all">
                {registryDetail.error instanceof Error ? registryDetail.error.message : String(registryDetail.error)}
              </div>
            </Show>
            <Show when={registryDetail.data}>
              {(data) => (
                <RegistryBody
                  data={data()}
                  namespace={registryNamespace()}
                  slug={registrySlug()}
                  onTry={onTryPrompt}
                />
              )}
            </Show>
          </Show>

          {/* Installed/marketplace addon branch */}
          <Show when={!isRegistry()}>
            <Show when={list.isLoading}>
              <DetailSkeleton />
            </Show>
            <Show when={!list.isLoading && !available()}>
              <NotFound onBack={() => navigate("/plugins")} />
            </Show>
            <Show when={available()}>
              {(info) => <Body info={info()} detail={detail.data ?? undefined} onTry={onTryPrompt} />}
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}

function Breadcrumb(props: { name: string; onBack: () => void }): JSX.Element {
  const language = useLanguage()
  return (
    <div class="flex items-center gap-1 text-14-regular text-text-weak">
      <button
        type="button"
        class="px-2 h-8 rounded-md hover:bg-surface-base text-text-base"
        style={NO_DRAG}
        onClick={props.onBack}
      >
        {language.t("plugins.page.title")}
      </button>
      <Icon name="chevron-right" size="small" class="text-text-weaker" />
      <span class="px-2 h-8 inline-flex items-center text-text-strong truncate max-w-xs" style={NO_DRAG}>
        {props.name}
      </span>
    </div>
  )
}

function PrimaryAction(props: {
  available: AddonAvailable | undefined
  installing: boolean
  uninstalling: boolean
  onInstall: () => void
  onUninstall: () => void
}): JSX.Element {
  const language = useLanguage()
  const info = () => props.available
  const notInstallable = () => info()?.installation === "NOT_AVAILABLE" && !info()?.installed
  return (
    <Show
      when={info()?.installed}
      fallback={
        <button
          type="button"
          class="h-8 px-3 rounded-full bg-text-strong text-background-stronger text-14-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          style={NO_DRAG}
          disabled={!info() || props.installing || notInstallable()}
          onClick={props.onInstall}
          title={notInstallable() ? language.t("plugins.install.unavailable") : undefined}
        >
          <Show when={!props.installing} fallback={language.t("plugins.installing")}>
            {language.t("plugins.detail.add")}
          </Show>
        </button>
      }
    >
      <DropdownMenu placement="bottom-end" gutter={4}>
        <DropdownMenu.Trigger
          class="h-8 px-3 rounded-full bg-surface-base hover:bg-surface-base-hover text-14-medium text-text-strong inline-flex items-center gap-1.5"
          style={NO_DRAG}
        >
          <Icon name="check-small" size="small" />
          <span>{language.t("plugins.detail.installed")}</span>
          <Icon name="chevron-down" size="small" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="codex-chat-menu min-w-44">
            <DropdownMenu.Item onSelect={props.onUninstall} disabled={props.uninstalling}>
              <Icon name="trash" size="small" class="text-icon-weak" />
              <DropdownMenu.ItemLabel>{language.t("plugins.detail.uninstall")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}

function DetailUploadButton(props: { visible: boolean; uploading: boolean; onUpload: () => void }): JSX.Element {
  const language = useLanguage()
  return (
    <Show when={props.visible}>
      <Tooltip
        placement="bottom"
        value={
          props.uploading ? language.t("plugins.detail.upload.uploading") : language.t("plugins.detail.upload.action")
        }
      >
        <button
          type="button"
          class="size-8 rounded-full hover:bg-surface-base text-text-strong disabled:opacity-50 inline-flex items-center justify-center"
          style={NO_DRAG}
          disabled={props.uploading}
          aria-label={language.t("plugins.detail.upload.action")}
          onClick={props.onUpload}
        >
          <Icon name="cloud-upload" size="small" class="text-icon-weak" />
        </button>
      </Tooltip>
    </Show>
  )
}

// Registry plugin detail body — renders manifest info + social panel
function RegistryBody(props: {
  data: RegistryPluginDetail
  namespace: string
  slug: string
  onTry: (prompt: string) => void
}): JSX.Element {
  const theme = useTheme()
  const language = useLanguage()
  const isDark = () => theme.mode() === "dark"
  const manifest = () => props.data.manifest
  const heroPrompt = () => manifest()?.default_prompts?.[0] ?? props.data.short_description ?? ""

  return (
    <div class="mt-8 flex flex-col gap-8">
      {/* Header */}
      <div class="flex flex-col items-start gap-3">
        <Show
          when={props.data.logo_url}
          fallback={
            <div
              class="size-12 rounded-xl flex items-center justify-center text-text-strong bg-surface-base"
              style={manifest()?.brand_color ? { "background-color": manifest().brand_color } : undefined}
            >
              <Icon name="mcp" size="small" />
            </div>
          }
        >
          <img
            src={props.data.logo_url}
            alt={props.data.display_name}
            class="size-12 rounded-xl object-cover bg-surface-base"
          />
        </Show>
        <h1
          class="text-text-strong tracking-tight"
          style={{ "font-size": "24px", "font-weight": 600, "line-height": "1.2" }}
        >
          {props.data.display_name}
        </h1>
        <NamespaceLine namespace={props.namespace} />
        <Show when={props.data.short_description}>
          <div class="text-15-regular text-text-base">{props.data.short_description}</div>
        </Show>
        {/* Real stats from registry */}
        <div class="flex items-center gap-4 text-13-regular text-text-weak">
          <span class="inline-flex items-center gap-1.5">
            <Icon name="download" size="small" class="text-icon-weak" />
            {formatInstallCount(finiteNum(props.data.download_count))}
          </span>
          <span class="text-text-weaker">·</span>
          <span class="inline-flex items-center gap-1">
            <Stars rating={finiteNum(props.data.rating_avg)} />
            <span class="ml-1 text-text-base">{finiteNum(props.data.rating_avg).toFixed(1)}</span>
            <span class="text-text-weaker">({formatReviewCount(finiteNum(props.data.rating_count))})</span>
          </span>
        </div>
      </div>

      {/* Hero banner with first default prompt */}
      <Show when={manifest()?.default_prompts?.length > 0 || props.data.short_description}>
        <div class="relative h-40 overflow-hidden select-none" style={{ "border-radius": "24px" }}>
          <div
            class="absolute inset-0 bg-cover bg-center pointer-events-none"
            style={{ "background-image": "url('/plugins-hero.png')" }}
          />
          <div
            class="absolute inset-0 pointer-events-none"
            style={{ "background-color": isDark() ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.6)" }}
          />
          <div class="absolute inset-0 flex items-center justify-center px-6">
            <div
              class="flex items-center gap-2 pl-2 pr-4 h-10 rounded-full shadow-sm max-w-[90%] cursor-pointer hover:shadow-md transition-shadow"
              style={{ "background-color": isDark() ? "#000" : "#FFFFFF" }}
              role="button"
              tabindex={0}
              onClick={() => props.onTry(heroPrompt())}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  props.onTry(heroPrompt())
                }
              }}
            >
              <Show
                when={props.data.logo_url}
                fallback={
                  <div
                    class="size-5 rounded-md flex items-center justify-center text-11-medium shrink-0"
                    style={{ "background-color": manifest()?.brand_color ?? "#18181B", color: "#FFFFFF" }}
                  >
                    {(props.data.display_name?.[0] ?? "?").toUpperCase()}
                  </div>
                }
              >
                <img
                  src={props.data.logo_url}
                  alt={props.data.display_name}
                  class="size-5 rounded-md shrink-0 object-cover"
                  draggable={false}
                />
              </Show>
              <span class="text-13-medium" style={{ color: manifest()?.brand_color ?? "#18181B" }}>
                {props.data.display_name}
              </span>
              <span class="text-13-regular truncate" style={{ color: isDark() ? "#FFFFFF" : "#18181B" }}>
                {heroPrompt()}
              </span>
            </div>
          </div>
        </div>
      </Show>

      {/* Long description：优先顶层 long_description(locale 协商)，回退 manifest(单语言)/short */}
      <Show
        when={
          props.data.long_description ||
          manifest()?.long_description ||
          manifest()?.short_description ||
          props.data.short_description
        }
      >
        <div class="text-14-regular text-text-base whitespace-pre-line">
          {props.data.long_description ||
            manifest()?.long_description ||
            manifest()?.short_description ||
            props.data.short_description}
        </div>
      </Show>

      {/* Skills from manifest */}
      <Show when={manifest()?.skills?.length > 0}>
        <section class="flex flex-col gap-3">
          <div class="text-16-medium text-text-strong">{language.t("plugins.detail.skills")}</div>
          <div class="border border-border-weak-base rounded-xl divide-y divide-border-weak-base overflow-hidden">
            <For each={manifest().skills}>
              {(skill) => (
                <div class="flex items-center gap-3 px-4 py-3 bg-background-stronger">
                  <div class="size-9 rounded-lg bg-surface-base flex items-center justify-center text-text-base shrink-0">
                    <Icon name="prompt" size="small" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-13-regular text-text-strong inline-flex items-center gap-2">
                      <span class="truncate">{skill.name}</span>
                      <span class="text-12-regular text-text-weak shrink-0">
                        {language.t("plugins.detail.includes.skill")}
                      </span>
                    </div>
                    <Show when={skill.description}>
                      <div class="text-12-regular text-text-weak truncate">{skill.description}</div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>

      {/* Screenshots */}
      <Show when={manifest()?.screenshots?.length > 0}>
        <section class="flex flex-col gap-3">
          <div class="text-16-medium text-text-strong">{language.t("plugins.detail.screenshots")}</div>
          <div class="flex gap-3 overflow-x-auto -mx-6 px-6 pb-2">
            <For each={manifest().screenshots}>
              {(src) => (
                <img
                  src={src}
                  alt=""
                  class="h-48 rounded-xl object-cover border border-border-weak-base shrink-0"
                  loading="lazy"
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      {/* Information section */}
      <section class="flex flex-col gap-3">
        <div class="text-16-medium text-text-strong">{language.t("plugins.detail.info")}</div>
        <div class="border border-border-weak-base rounded-xl divide-y divide-border-weak-base overflow-hidden">
          <RegistryInfoRow label={language.t("plugins.detail.info.namespace")} value={props.namespace} />
          <Show when={manifest()?.category}>
            <RegistryInfoRow
              label={language.t("plugins.detail.info.category")}
              value={pluginCategoryLabel(manifest().category, language.t)}
            />
          </Show>
          <Show when={manifest()?.developer_name}>
            <RegistryInfoRow label={language.t("plugins.detail.info.developer")} value={manifest().developer_name} />
          </Show>
          <Show when={props.data.latest_version}>
            <RegistryInfoRow
              label={language.t("plugins.detail.info.latestVersion")}
              value={props.data.latest_version}
            />
          </Show>
          <Show when={manifest()?.capabilities?.length > 0}>
            <RegistryInfoRow
              label={language.t("plugins.detail.info.capabilities")}
              value={manifest().capabilities.join(", ")}
            />
          </Show>
          <Show when={manifest()?.website_url}>
            <RegistryInfoLinkRow label={language.t("plugins.detail.info.website")} href={manifest().website_url} />
          </Show>
          <Show when={manifest()?.privacy_policy_url}>
            <RegistryInfoLinkRow
              label={language.t("plugins.detail.info.privacy")}
              href={manifest().privacy_policy_url}
            />
          </Show>
          <Show when={manifest()?.terms_of_service_url}>
            <RegistryInfoLinkRow
              label={language.t("plugins.detail.info.terms")}
              href={manifest().terms_of_service_url}
            />
          </Show>
        </div>
      </section>

      {/* Rating + comment panel */}
      <PluginSocial namespace={props.namespace} slug={props.slug} />
    </div>
  )
}

function RegistryInfoRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="flex items-center gap-4 px-4 py-3 bg-background-stronger">
      <div class="w-32 shrink-0 text-13-regular text-text-weak">{props.label}</div>
      <div class="flex-1 text-13-regular text-text-strong break-all">{props.value}</div>
    </div>
  )
}

function RegistryInfoLinkRow(props: { label: string; href: string }): JSX.Element {
  return (
    <div class="flex items-center gap-4 px-4 py-3 bg-background-stronger">
      <div class="w-32 shrink-0 text-13-regular text-text-weak">{props.label}</div>
      <a
        href={props.href}
        target="_blank"
        rel="noopener noreferrer"
        class="flex-1 min-w-0 inline-flex items-center gap-1.5 text-13-regular text-link hover:underline"
      >
        <span class="truncate">{hostOf(props.href)}</span>
        <Icon name="square-arrow-top-right" size="small" class="shrink-0" />
      </a>
    </div>
  )
}

function NamespaceLine(props: { namespace: string | undefined }): JSX.Element {
  const language = useLanguage()
  return (
    <Show when={props.namespace}>
      {(namespace) => (
        <div class="inline-flex items-center gap-1.5 text-13-regular text-text-weak">
          <span>{language.t("plugins.detail.info.namespace")}</span>
          <span class="text-text-base break-all">{namespace()}</span>
        </div>
      )}
    </Show>
  )
}

function Body(props: {
  info: AddonAvailable
  detail: AddonDetail | undefined
  onTry: (prompt: string) => void
}): JSX.Element {
  return (
    <div class="mt-8 flex flex-col gap-8">
      <Header info={props.info} />
      <Hero info={props.info} onTry={props.onTry} />
      <Description info={props.info} />
      <Includes info={props.info} detail={props.detail} />
      <Screenshots info={props.info} />
      <Information info={props.info} detail={props.detail} />
    </div>
  )
}

function Header(props: { info: AddonAvailable }): JSX.Element {
  const iconStyle = () => (props.info.brand_color ? { "background-color": props.info.brand_color } : undefined)
  return (
    <div class="flex flex-col items-start gap-3">
      <Show
        when={props.info.logo}
        fallback={
          <div
            class="size-12 rounded-xl flex items-center justify-center text-text-strong bg-surface-base"
            style={iconStyle()}
          >
            <Icon name="mcp" size="small" />
          </div>
        }
      >
        <img
          src={props.info.logo}
          alt={displayName(props.info)}
          class="size-12 rounded-xl object-cover bg-surface-base"
        />
      </Show>
      <h1
        class="text-text-strong tracking-tight"
        style={{ "font-size": "24px", "font-weight": 600, "line-height": "1.2" }}
      >
        {displayName(props.info)}
      </h1>
      <NamespaceLine namespace={addonNamespaceFromKey(props.info.key)} />
      <Show when={props.info.description}>
        <div class="text-15-regular text-text-base">{props.info.description}</div>
      </Show>
      {/* 按来源三分：builtin/registry→mock；本地/personal→全 0 */}
      <DetailStats addonKey={props.info.key} marketplaceName={props.info.marketplace_name} />
    </div>
  )
}

// 三分规则:builtin→mock；wanlaicode registry→mock 兜底(真实值在 RegistryBody 已由 registryDetail 提供)；本地/personal→全 0
function detailStatsFor(
  addonKey: string,
  marketplaceName: string | undefined,
): { installs: number; rating: number; reviewCount: number } {
  const mn = marketplaceName ?? ""
  if (mn.startsWith("openai-")) return mockStatsFor(addonKey)
  if (mn === "wanlaicode") return mockStatsFor(addonKey)
  // 本地 / personal / sideload → 全 0
  return { installs: 0, rating: 0, reviewCount: 0 }
}

function DetailStats(props: { addonKey: string; marketplaceName: string | undefined }): JSX.Element {
  const language = useLanguage()
  const stats = createMemo(() => detailStatsFor(props.addonKey, props.marketplaceName))
  return (
    <div class="flex items-center gap-4 text-13-regular text-text-weak">
      <span class="inline-flex items-center gap-1.5">
        <Icon name="download" size="small" class="text-icon-weak" />
        {language.t("plugins.detail.stats.installs", { count: formatInstallCount(stats().installs) })}
      </span>
      <span class="text-text-weaker">·</span>
      <span class="inline-flex items-center gap-1">
        <Stars rating={stats().rating} />
        <span class="ml-1 text-text-base">{stats().rating.toFixed(1)}</span>
        <span class="text-text-weaker">({formatReviewCount(stats().reviewCount)})</span>
      </span>
    </div>
  )
}

// 5 颗星,按评分填充。半星用半透明近似(无需独立 svg)
function Stars(props: { rating: number }): JSX.Element {
  return (
    <span class="inline-flex items-center" aria-label={`${props.rating.toFixed(1)}/5`}>
      <For each={[0, 1, 2, 3, 4]}>
        {(i) => {
          const fill = Math.max(0, Math.min(1, props.rating - i))
          return (
            <span
              class="text-text-base leading-none"
              style={{
                opacity: fill === 0 ? 0.25 : fill < 1 ? 0.55 : 1,
              }}
            >
              ★
            </span>
          )
        }}
      </For>
    </span>
  )
}

function pickHeroPrompt(info: AddonAvailable): string | undefined {
  const prompts = info.default_prompt
  if (prompts && prompts.length > 0) return prompts[0]
  return info.description?.trim() || undefined
}

// Hero 区 —— 与 plugins.tsx 列表页 Hero 同视觉语言，但只展示当前插件的提示卡
function Hero(props: { info: AddonAvailable; onTry: (prompt: string) => void }): JSX.Element {
  const language = useLanguage()
  const theme = useTheme()
  const isDark = () => theme.mode() === "dark"
  const promptText = () => pickHeroPrompt(props.info) ?? language.t("plugins.hero.fallbackDescription")
  return (
    <div class="relative h-40 overflow-hidden select-none" style={{ "border-radius": "24px" }}>
      <div
        class="absolute inset-0 bg-cover bg-center pointer-events-none"
        style={{ "background-image": "url('/plugins-hero.png')" }}
      />
      <div
        class="absolute inset-0 pointer-events-none"
        style={{ "background-color": isDark() ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.6)" }}
      />
      <div class="absolute inset-0 flex items-center justify-center px-6">
        <div
          class="flex items-center gap-2 pl-2 pr-4 h-10 rounded-full shadow-sm max-w-[90%] cursor-pointer hover:shadow-md transition-shadow"
          style={{ "background-color": isDark() ? "#000" : "#FFFFFF" }}
          role="button"
          tabindex={0}
          onClick={() => props.onTry(promptText())}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              props.onTry(promptText())
            }
          }}
        >
          <Show
            when={props.info.logo}
            fallback={
              <div
                class="size-5 rounded-md flex items-center justify-center text-11-medium shrink-0"
                style={{ "background-color": props.info.brand_color ?? "#18181B", color: "#FFFFFF" }}
              >
                {(props.info.name?.[0] ?? "?").toUpperCase()}
              </div>
            }
          >
            <img
              src={props.info.logo}
              alt={displayName(props.info)}
              class="size-5 rounded-md shrink-0 object-cover"
              draggable={false}
            />
          </Show>
          <span class="text-13-medium" style={{ color: props.info.brand_color ?? "#18181B" }}>
            {displayName(props.info)}
          </span>
          <span class="text-13-regular truncate" style={{ color: isDark() ? "#FFFFFF" : "#18181B" }}>
            {promptText()}
          </span>
        </div>
      </div>
    </div>
  )
}

function Description(props: { info: AddonAvailable }): JSX.Element {
  const language = useLanguage()
  const text = () =>
    props.info.long_description?.trim() ||
    props.info.description?.trim() ||
    language.t("plugins.detail.descriptionFallback", { name: displayName(props.info) })
  return <div class="text-14-regular text-text-base whitespace-pre-line">{text()}</div>
}

// Includes 区 —— 每行对应一个 App / MCP server / Skill / Hook，名字 / 描述精确到具体条目。
// installed:用 AddonDetail 的运行时数据（含 server 命令、skill 路径等更准字段）;但 App 类目 AddonDetail 暂无,继续用 manifest_apps
// uninstalled:全部用 AddonAvailable 的 manifest_apps / manifest_mcp_servers / manifest_skills（marketplace 端预读 .app.json + .mcp.json + skills/*/agents/openai.yaml）
function Includes(props: { info: AddonAvailable; detail: AddonDetail | undefined }): JSX.Element {
  const language = useLanguage()
  const appRows = createMemo<Array<{ name: string }>>(() => props.info.manifest_apps ?? [])
  const mcpRows = createMemo<Array<{ name: string; description?: string }>>(() => {
    if (props.detail) {
      return Object.entries(props.detail.mcp_servers ?? {}).map(([name, server]) => ({
        name,
        description:
          server.type === "local" ? (server.command?.join(" ") ?? "") : server.type === "remote" ? server.url : "",
      }))
    }
    return (props.info.manifest_mcp_servers ?? []).map((a) => ({ name: a.name }))
  })
  const skillRows = createMemo<Array<{ name: string; display_name?: string; description?: string }>>(() => {
    if (props.detail) {
      return (props.detail.skills ?? []).map((s) => ({
        name: s.name,
        display_name: s.display_name,
        description: s.description,
      }))
    }
    return [...(props.info.manifest_skills ?? [])]
  })
  const hookRows = createMemo<string[]>(() => {
    if (props.detail) return [...(props.detail.hooks ?? [])]
    // 未安装时不知道具体 hook 名字，只知道是否声明 —— 退化为一条占位
    return props.info.has_hooks ? [language.t("plugins.detail.includes.hook")] : []
  })
  const empty = () =>
    appRows().length === 0 && mcpRows().length === 0 && skillRows().length === 0 && hookRows().length === 0
  return (
    <Show when={!empty()}>
      <section class="flex flex-col gap-3">
        <div class="text-16-medium text-text-strong">{language.t("plugins.detail.includes")}</div>
        <div class="border border-border-weak-base rounded-xl divide-y divide-border-weak-base overflow-hidden">
          <For each={appRows()}>
            {(row) => <IncludesRow icon="mcp" label={row.name} kind={language.t("plugins.detail.includes.app")} />}
          </For>
          <For each={mcpRows()}>
            {(row) => (
              <IncludesRow
                icon="mcp"
                label={row.name}
                kind={language.t("plugins.detail.includes.mcp")}
                description={row.description}
              />
            )}
          </For>
          <For each={skillRows()}>
            {(row) => (
              <IncludesRow
                icon="prompt"
                label={row.display_name ?? row.name}
                kind={language.t("plugins.detail.includes.skill")}
                description={row.description}
              />
            )}
          </For>
          <For each={hookRows()}>
            {(label) => <IncludesRow icon="terminal" label={label} kind={language.t("plugins.detail.includes.hook")} />}
          </For>
        </div>
      </section>
    </Show>
  )
}

function Screenshots(props: { info: AddonAvailable }): JSX.Element {
  const language = useLanguage()
  const shots = createMemo(() => props.info.screenshots ?? [])
  return (
    <Show when={shots().length > 0}>
      <section class="flex flex-col gap-3">
        <div class="text-16-medium text-text-strong">{language.t("plugins.detail.screenshots")}</div>
        <div class="flex gap-3 overflow-x-auto -mx-6 px-6 pb-2">
          <For each={shots()}>
            {(src) => (
              <img
                src={src}
                alt=""
                class="h-48 rounded-xl object-cover border border-border-weak-base shrink-0"
                loading="lazy"
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

function IncludesRow(props: { icon: IconName; label: string; kind: string; description?: string }): JSX.Element {
  return (
    <div class="flex items-center gap-3 px-4 py-3 bg-background-stronger">
      <div class="size-9 rounded-lg bg-surface-base flex items-center justify-center text-text-base shrink-0">
        <Icon name={props.icon} size="small" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-13-regular text-text-strong inline-flex items-center gap-2">
          <span class="truncate">{props.label}</span>
          <span class="text-12-regular text-text-weak shrink-0">{props.kind}</span>
        </div>
        <Show when={props.description}>
          <div class="text-12-regular text-text-weak truncate">{props.description}</div>
        </Show>
      </div>
    </div>
  )
}

type InfoRow = { kind: "text"; label: string; value: string } | { kind: "link"; label: string; href: string }

function Information(props: { info: AddonAvailable; detail: AddonDetail | undefined }): JSX.Element {
  const language = useLanguage()
  const rows = createMemo<InfoRow[]>(() => {
    const info = props.info
    const xs: InfoRow[] = []
    const namespace = addonNamespaceFromKey(info.key)
    if (namespace) {
      xs.push({ kind: "text", label: language.t("plugins.detail.info.namespace"), value: namespace })
    }
    if (info.category) {
      xs.push({
        kind: "text",
        label: language.t("plugins.detail.info.category"),
        value: pluginCategoryLabel(info.category, language.t),
      })
    }
    if (info.developer_name) {
      xs.push({
        kind: "text",
        label: language.t("plugins.detail.info.developer"),
        value: info.developer_name,
      })
    }
    if (props.detail?.version) {
      xs.push({ kind: "text", label: language.t("plugins.detail.info.version"), value: props.detail.version })
    }
    if (info.capabilities?.length) {
      xs.push({
        kind: "text",
        label: language.t("plugins.detail.info.capabilities"),
        value: info.capabilities.join(", "),
      })
    }
    if (info.website_url) {
      xs.push({ kind: "link", label: language.t("plugins.detail.info.website"), href: info.website_url })
    }
    if (info.privacy_policy_url) {
      xs.push({
        kind: "link",
        label: language.t("plugins.detail.info.privacy"),
        href: info.privacy_policy_url,
      })
    }
    if (info.terms_of_service_url) {
      xs.push({
        kind: "link",
        label: language.t("plugins.detail.info.terms"),
        href: info.terms_of_service_url,
      })
    }
    if (info.keywords?.length) {
      xs.push({
        kind: "text",
        label: language.t("plugins.detail.info.keywords"),
        value: info.keywords.join(", "),
      })
    }
    return xs
  })
  return (
    <section class="flex flex-col gap-3">
      <div class="text-16-medium text-text-strong">{language.t("plugins.detail.info")}</div>
      <div class="border border-border-weak-base rounded-xl divide-y divide-border-weak-base overflow-hidden">
        <For each={rows()}>
          {(row) => (
            <div class="flex items-center gap-4 px-4 py-3 bg-background-stronger">
              <div class="w-32 shrink-0 text-13-regular text-text-weak">{row.label}</div>
              <Show
                when={row.kind === "link"}
                fallback={
                  <div class="flex-1 text-13-regular text-text-strong break-all">
                    {row.kind === "text" ? row.value : ""}
                  </div>
                }
              >
                <a
                  href={row.kind === "link" ? row.href : "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex-1 min-w-0 inline-flex items-center gap-1.5 text-13-regular text-link hover:underline"
                >
                  <span class="truncate">{row.kind === "link" ? hostOf(row.href) : ""}</span>
                  <Icon name="square-arrow-top-right" size="small" class="shrink-0" />
                </a>
              </Show>
            </div>
          )}
        </For>
      </div>
    </section>
  )
}

function DetailSkeleton(): JSX.Element {
  return (
    <div class="mt-8 flex flex-col gap-6">
      <div class="size-12 rounded-xl bg-surface-base animate-pulse" />
      <div class="h-6 w-40 bg-surface-base rounded animate-pulse" />
      <div class="h-4 w-72 bg-surface-base rounded animate-pulse" />
      <div class="h-40 rounded-3xl bg-surface-base animate-pulse" />
      <div class="h-3 w-full bg-surface-base rounded animate-pulse" />
      <div class="h-3 w-5/6 bg-surface-base rounded animate-pulse" />
    </div>
  )
}

function NotFound(props: { onBack: () => void }): JSX.Element {
  const language = useLanguage()
  return (
    <div class="mt-24 flex flex-col items-center gap-3">
      <div class="text-16-medium text-text-strong">{language.t("plugins.detail.notFound.title")}</div>
      <div class="text-14-regular text-text-weak">{language.t("plugins.detail.notFound.description")}</div>
      <button
        type="button"
        class="mt-2 h-9 px-4 rounded-full bg-surface-base hover:bg-surface-base-hover text-14-medium text-text-strong"
        onClick={props.onBack}
      >
        {language.t("plugins.detail.notFound.back")}
      </button>
    </div>
  )
}
