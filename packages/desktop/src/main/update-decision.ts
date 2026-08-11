// 检查更新时的版本决策（纯函数，便于单测）。
//
// 背景 bug：checkUpdate() 早先在 downloadedUpdateVersion 有值时直接短路返回该版本、
// 不再请求远端。于是长时间挂着的桌面 App 一旦后台下过某个中间版本（如 0.0.21），
// 之后即便线上已发布 0.0.22 也永远只提示 0.0.21，表现为「检测不到最新版、只提示一个
// 比当前新但不到最新的版本」。
//
// 修复思路：即使本会话已下载过版本，仍要看远端最新版。latest.yml 始终只描述唯一最新
// 版本，远端「有可用更新」且版本号与已下载的不同，即说明有新版本顶替 —— 丢弃旧下载、
// 改下新版本；相同则沿用已下载缓存，省去重复下载。
export type UpdateDecision =
  | { action: "none" }
  | { action: "use-cached"; version: string }
  | { action: "download"; version: string; supersedes?: string }

export function resolveUpdateDecision(input: {
  /** 本会话内已下载完成、待安装的版本（无则 undefined） */
  downloaded: string | undefined
  /** 远端 latest 清单里的版本 */
  remoteVersion: string | undefined
  /** electron-updater 判定相对当前 App 版本是否有可用更新 */
  remoteAvailable: boolean
}): UpdateDecision {
  const { downloaded, remoteVersion, remoteAvailable } = input

  if (downloaded) {
    // 远端有可用更新且版本与已下载的不同 → 有更新的版本顶替，重新下载它。
    // 仅在 remoteAvailable 为真时顶替，避免「回滚到当前版本」（isUpdateAvailable=false）
    // 误触发一次降级下载。
    if (remoteAvailable && remoteVersion && remoteVersion !== downloaded) {
      return { action: "download", version: remoteVersion, supersedes: downloaded }
    }
    return { action: "use-cached", version: downloaded }
  }

  if (!remoteAvailable || !remoteVersion) return { action: "none" }
  return { action: "download", version: remoteVersion }
}
