import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { Config } from "@/config/config"
import type { MarketplaceConfig } from "@/config/addon"

export function defaultAddonPaths(config?: Config.Info) {
  const paths: string[] = []
  // ~/.codex/plugins/cache 是 Codex CLI 的遗留 addon 缓存目录,默认不再加载——其中绝大多数
  // 插件依赖 ChatGPT connector,我们这边即便扫到也跑不起来,反而污染列表 / 引发误装。
  // 需要时(本机同时跑 Codex CLI 想共享 sideload 缓存)显式打开 env flag。
  if (process.env.WANLAICODE_ENABLE_CODEX_LEGACY_PATHS === "true" || process.env.WANLAICODE_ENABLE_CODEX_LEGACY_PATHS === "1") {
    paths.push(path.join(Global.Path.home, ".codex", "plugins", "cache"))
  }
  paths.push(path.join(Global.Path.data, "addons", "cache"))
  if (config?.addon?.paths) paths.push(...config.addon.paths)
  return paths
}

const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g

export function safeMarketplaceName(name: string): string {
  const replaced = name.replace(SAFE_NAME_RE, "_")
  return replaced.length ? replaced : "_"
}

export function marketplaceInstallRoot(name: string): string {
  return path.join(Global.Path.data, "marketplaces", safeMarketplaceName(name))
}

export function addonsCacheRoot(): string {
  return path.join(Global.Path.data, "addons", "cache")
}

export function addonsStagingRoot(): string {
  return path.join(Global.Path.data, "addons", ".staging")
}

function expandHome(p: string): string {
  if (p === "~") return Global.Path.home
  if (p.startsWith("~/")) return path.join(Global.Path.home, p.slice(2))
  return p
}

export function resolveMarketplaceRoot(name: string, cfg: MarketplaceConfig): string {
  if (cfg.source_type === "local") {
    if (!cfg.source) return marketplaceInstallRoot(name)
    const expanded = expandHome(cfg.source)
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
  }
  return marketplaceInstallRoot(name)
}
