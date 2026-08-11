import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, ProviderListResponse } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import type { FileContextMenuActions } from "../components/file-link-context-menu"
import type { OpenSkillFile } from "./skill-file"

export type MarkdownPathResolution = {
  absolutePath: string
  href: string
  kind: "file" | "directory"
  title: string
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: ProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type PurchasePlanCatalog = {
  enabled?: unknown
  purchase_url?: unknown
  plans?: unknown
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    /** Resolve inline `code` that looks like a path to a workspace file (for links + tooltip). */
    resolveMarkdownPath?: (raw: string) => Promise<MarkdownPathResolution | undefined>
    /** Open a local absolute path (e.g. from a file link click). */
    openLocalPath?: (absolutePath: string, kind?: "file" | "directory") => void | Promise<void>
    /** Open an external URL (e.g. from a code link click) in built-in browser. */
    openExternalLink?: (url: string) => void | Promise<void>
    openSystemBrowserLink?: (url: string) => void | Promise<void>
    /** 打开宿主应用内的套餐购买页；生图套餐拒绝卡优先使用此入口，避免裸链接丢失登录态。 */
    openPurchasePlans?: () => void | Promise<void>
    /** 读取宿主应用的响应式套餐缓存；undefined 表示尚未获取，null 表示真实接口失败，空 plans 表示已确认没有套餐。 */
    purchasePlanCatalog?: () => PurchasePlanCatalog | null | undefined
    /** 套餐缓存缺失时按需获取真实目录；宿主负责并发去重并把成功结果写回缓存。 */
    loadPurchasePlanCatalog?: () => Promise<void>
    /** File path right-click context menu actions. */
    fileContextMenuActions?: FileContextMenuActions
    /** Open a skill's SKILL.md in the host app preview surface. */
    openSkillFile?: OpenSkillFile
    /**
     * Resolve `[@x](plugin://addon@market)` mention 在消息 / composer 里的元数据,
     * 用来给 chip 注入 logo / 品牌色 / display name。返回 undefined 时降级到纯文本 chip。
     */
    resolvePluginMeta?: (addonKey: string) => { logo?: string; brand_color?: string; display_name?: string } | undefined
    /**
     * 点击消息 / composer 里的 plugin mention chip 时跳转到该插件详情页。
     * 未注入时 chip 退化为纯展示(不可点击)。
     */
    openPluginDetail?: (addonKey: string) => void | Promise<void>
    /** Open a quick-chat conversation reference in the host application's floating chat panel. */
    openConversation?: (conversationID: string) => void | Promise<void>
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      resolveMarkdownPath: props.resolveMarkdownPath,
      openLocalPath: props.openLocalPath,
      openExternalLink: props.openExternalLink,
      openSystemBrowserLink: props.openSystemBrowserLink,
      openPurchasePlans: props.openPurchasePlans,
      purchasePlanCatalog: props.purchasePlanCatalog,
      loadPurchasePlanCatalog: props.loadPurchasePlanCatalog,
      fileContextMenuActions: props.fileContextMenuActions,
      openSkillFile: props.openSkillFile,
      resolvePluginMeta: props.resolvePluginMeta,
      openPluginDetail: props.openPluginDetail,
      openConversation: props.openConversation,
    }
  },
})
