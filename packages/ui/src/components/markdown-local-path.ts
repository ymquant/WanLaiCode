export function isHtmlFilePath(path?: string | null) {
  return !!path && /\.html?$/i.test(path)
}

// 平台判定缓存：macOS 用 Cmd 触发系统浏览器，Win/Linux 用 Ctrl。
// macOS 上 Ctrl+点击是右键菜单的等价操作，Win/Linux 上 Meta（Win 键）几乎无意义，
// 因此修饰键必须按平台区分，避免误触发。
let cachedIsMac: boolean | undefined
function isPlatformMac() {
  if (cachedIsMac !== undefined) return cachedIsMac
  const ua = globalThis.navigator?.userAgent || ""
  cachedIsMac = /mac/i.test(ua)
  return cachedIsMac
}

// 是否按下了"系统浏览器"快捷键修饰符：macOS 看 metaKey，其它平台看 ctrlKey。
// platform 仅用于测试注入；生产路径走 navigator 自动判定。
export function isSystemBrowserModifier(
  e: { ctrlKey?: boolean; metaKey?: boolean },
  platform?: { isMac?: boolean },
) {
  const isMac = platform?.isMac ?? isPlatformMac()
  return isMac ? !!e.metaKey : !!e.ctrlKey
}

// 仅供测试重置平台缓存，避免在用例间污染。
export function __resetPlatformCacheForTests() {
  cachedIsMac = undefined
}

// 把本地绝对路径编码为合法的 file:// URL。
// 必须按段 encodeURIComponent：encodeURI 不会编码 `#`/`?` 等 URL 保留字，
// 会让 `/tmp/report#1.html` 里的 `#1.html` 被下游解析为 fragment，
// 主进程扩展名校验只能看到 `/tmp/report` → 误拒合法 HTML，或 fileURLToPath 直接抛错。
// Windows 盘符段（如 `C:`）的冒号在 file URL 里需要保留，单独放行。
export function fileUrlFromAbsolutePath(path: string) {
  const normalized = path.replace(/\\/g, "/")
  const body = normalized.startsWith("/") ? normalized.slice(1) : normalized
  const encoded = body
    .split("/")
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")
  return `file:///${encoded}`
}

export function createMarkdownLocalPathHandler(data: {
  openLocalPath?: (absolutePath: string, kind?: "file" | "directory") => void | Promise<void>
  fileContextMenuActions?: { openInBrowser?: (absPath: string) => void }
}) {
  if (!data.openLocalPath && !data.fileContextMenuActions?.openInBrowser) return undefined
  return Object.assign(
    (path: string, kind?: "file" | "directory") => {
      if (kind !== "directory" && isHtmlFilePath(path) && data.fileContextMenuActions?.openInBrowser) {
        void data.fileContextMenuActions.openInBrowser(path)
        return
      }
      void data.openLocalPath?.(path, kind)
    },
    {
      canOpen: (path: string, kind?: "file" | "directory") => {
        if (data.openLocalPath) return true
        return kind !== "directory" && isHtmlFilePath(path) && !!data.fileContextMenuActions?.openInBrowser
      },
    },
  )
}
