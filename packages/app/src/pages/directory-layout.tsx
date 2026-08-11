import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import type { AddonAvailable } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { usePlatform } from "@/context/platform"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { createMarkdownWorkspacePathResolver } from "@/utils/markdown-workspace-path"
import { encodeFilePath } from "@/context/file/path"
import { getOpenExternalLinkHandler } from "@/components/session/browser-tab"
import { decode64 } from "@/utils/base64"
import { getDirectory } from "@opencode-ai/core/util/path"
import { dispatchOpenSkillFile } from "@/utils/open-skill-file"
import { dispatchOpenLocalFile } from "@/utils/open-local-file"
import { createPathOpenerItems } from "@/utils/path-openers"
import { orderOpenersByDefaultEditor } from "@/utils/default-opener"
import { openQuickChat } from "@/utils/quick-chat"
import { QuickChatModelBridge } from "@/components/quick-chat-model-bridge"
import { openUserCenterOverlay } from "@/context/open-user-center"
import { ensurePurchasePlans, purchasePlansQuery } from "@/context/purchase-plans"

function isPathInsideDirectory(input: string, directory: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const target = normalize(input)
  const root = normalize(directory)
  const insensitive = /^[A-Za-z]:\//.test(root) || root.startsWith("//")
  const candidate = insensitive ? target.toLowerCase() : target
  const base = insensitive ? root.toLowerCase() : root
  return candidate === base || candidate.startsWith(`${base}/`)
}

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const sdk = useSDK()
  const platform = usePlatform()
  const queryClient = useQueryClient()
  const language = useLanguage()
  // enabled=false 只订阅全局套餐缓存；真正请求由拒绝卡 miss 或购买页主动加载触发。
  const purchasePlanCatalog = createQuery(() => ({ ...purchasePlansQuery(sdk.client), enabled: false }))
  const slug = createMemo(() => base64Encode(props.directory))

  // plugin chip (`[@name](plugin://addonKey)`) 渲染需要的元数据。直接读 plugins 页 / detail 页
  // 已经 prefetch 的 ["addon","available","global"] 缓存,miss 时返回 undefined,降级到 @name 文本。
  // 没在这里 createQuery 是为了避免「装着但还没访问过 plugins 页」时也强发请求。
  const resolvePluginMeta = (addonKey: string) => {
    const list = queryClient.getQueryData<AddonAvailable[]>(["addon", "available", "global", language.locale()])
    if (!list) return undefined
    const hit = list.find((p) => p.key === addonKey)
    if (!hit) return undefined
    // composer_icon(单色小图)优先用于 chip / 行内 mention,缺省再 fallback 到 logo
    return {
      logo: hit.composer_icon || hit.logo,
      brand_color: hit.brand_color,
      display_name: hit.display_name,
    }
  }

  const resolveMarkdownPath = createMemo(() =>
    createMarkdownWorkspacePathResolver({
      workspace: props.directory,
      exists: async (p) => {
        try {
          const r = await sdk.client.file.exists({ path: p, directory: props.directory })
          return r.data ?? { exists: false }
        } catch {
          return { exists: false }
        }
      },
      findFilePaths: async (query, limit) => {
        try {
          const r = await sdk.client.find.files({
            query,
            type: "file",
            limit,
            directory: props.directory,
          })
          return r.data ?? []
        } catch {
          return []
        }
      },
    }),
  )

  // 当 URL 已经定位到具体的 session 路径时（含会话详情、新建会话页），不要再把 URL
  // 重写到服务端 path API 返回的目录 —— 否则在多项目/多 sandbox 共享同一 git 仓库时，
  // path.get() 会把所有子目录都拉回 git 根项目，导致：
  //   1. 用户在子项目（如 test2）输入消息提交后 URL 被改写到根项目（NP3），session id 丢失
  //   2. 用户主动从 sidebar 进子项目的新建对话页时被跨项目重写
  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    if (location.pathname.startsWith(`/${slug()}/session`)) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createResource(
    // 常驻树下同一 id 也可能随目录切换需要重新同步，source 带上 directory
    () => (params.id ? ([params.id, props.directory] as const) : undefined),
    ([id]) => sync.session.sync(id),
  )
  const [installedOpeners] = createResource(
    () => platform.platform === "desktop" && typeof platform.listInstalledOpeners === "function",
    async (enabled) => {
      if (!enabled) return []
      return (await platform.listInstalledOpeners?.()) ?? []
    },
  )

  // 生图套餐拒绝卡从 UI 包回调到 app，复用带登录态的用户中心购买页。
  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) => navigate(`/${slug()}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}`}
      resolveMarkdownPath={(raw) => resolveMarkdownPath()(raw)}
      openLocalPath={(abs, kind) => {
        if (kind !== "directory" && isPathInsideDirectory(abs, props.directory)) {
          dispatchOpenLocalFile(abs)
          return
        }
        void platform.openPath?.(abs)
      }}
      openSkillFile={(input) =>
        dispatchOpenSkillFile(
          typeof input === "string"
            ? { absolutePath: input }
            : { absolutePath: input.path, name: input.name, displayName: input.displayName },
        )
      }
      openExternalLink={(url) => {
        const handler = getOpenExternalLinkHandler()
        const useBuiltin = handler && (
          /^https?:\/\//i.test(url) ||
          /^file:\/\/.*\.html?$/i.test(url)
        )
        if (useBuiltin) {
          handler(url)
        } else {
          platform.openLink(url)
        }
      }}
      openSystemBrowserLink={(url) => {
        if (platform.openSystemBrowserLink) {
          platform.openSystemBrowserLink(url)
          return
        }
        platform.openLink(url)
      }}
      openPurchasePlans={() => openUserCenterOverlay("purchase")}
      // null 表示本次真实接口请求失败；保留该状态可阻止历史拒绝卡在失败后循环请求。
      purchasePlanCatalog={() => purchasePlanCatalog.data ?? (purchasePlanCatalog.isError ? null : undefined)}
      loadPurchasePlanCatalog={async () => {
        await ensurePurchasePlans(queryClient, sdk.client)
      }}
      fileContextMenuActions={{
        openInVSCode: (absPath) => void platform.openPath?.(absPath, "Code"),
        openInBrowser: (absPath) => {
          const fileUrl = `file://${encodeFilePath(absPath.replace(/\\/g, "/"))}`
          const handler = getOpenExternalLinkHandler()
          if (handler) {
            handler(fileUrl)
          } else {
            platform.openLink(fileUrl)
          }
        },
        openWithDefault: (absPath) => void platform.openPath?.(absPath),
        openInTerminal: (absPath) => {
          const dir = getDirectory(absPath) || absPath
          const termApp = platform.os === "windows" ? "wt.exe" : "Terminal"
          void platform.openPath?.(dir, termApp)
        },
        openInGitBash: (absPath) => {
          const dir = getDirectory(absPath) || absPath
          void platform.openPath?.(dir, "git-bash.exe")
        },
        copyPath: (absPath) => void navigator.clipboard.writeText(absPath),
        copyFileContent: (absPath) => {
          void sdk.client.file.read({ path: absPath }).then((x) => {
            if (x.data?.content) void navigator.clipboard.writeText(x.data.content)
          })
        },
        revealInFolder: (absPath) => {
          const dir = getDirectory(absPath) || absPath
          void platform.openPath?.(dir)
        },
        openFileExplorer: (absPath) => {
          const dir = getDirectory(absPath) || absPath
          void platform.openPath?.(dir)
        },
        // 对话里的文件链接 / 附件右键菜单复用系统已安装 opener，确保首项能显示 Cursor 等真实编辑器。
        openerItems: (absPath) =>
          createPathOpenerItems({
            path: absPath,
            openers: orderOpenersByDefaultEditor(installedOpeners() ?? []),
            platform,
            t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params),
            includeTerminals: false,
          }),
      }}
      resolvePluginMeta={resolvePluginMeta}
      openPluginDetail={(addonKey) => navigate(`/plugins/${encodeURIComponent(addonKey)}`)}
      openConversation={platform.platform === "desktop" ? openQuickChat : undefined}
    >
      <LocalProvider>
        {props.children}
        <QuickChatModelBridge />
      </LocalProvider>
    </DataProvider>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    // 常驻树：不 keyed —— 目录切换只改 directory 信号，providers 与 Session 组件
    // 全部复用（对照 Codex 的单一常驻树 + 换数据），避免整树销毁重建的卡顿
    <Show when={resolved()}>
      <SDKProvider directory={() => resolved()!}>
        <SyncProvider>
          <DirectoryDataProvider directory={resolved()!}>{props.children}</DirectoryDataProvider>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
