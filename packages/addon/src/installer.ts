import path from "path"
import { createReadStream } from "fs"
import { cp, mkdir, readdir, rename, rm, stat } from "fs/promises"
import os from "os"
import { fileURLToPath } from "url"
import { Readable } from "stream"
import { parseManifest } from "./manifest"
import {
  fetchHttpSource,
  getRemoteRevision as httpRemoteRevision,
  readLocalRevision,
  refreshHttpSource,
  resolveHttpSource,
  extractRemoteTarball,
  fetchArchiveResponse,
  type FetchImpl,
} from "./http-source"
// REVISION_FILE 给 addon 自家测试用,避免硬编码 sidecar 文件名。
export { readLocalSidecar, REVISION_FILE, type LocalSidecar } from "./http-source"
import type { MarketplacePluginSource } from "./marketplace"
import { addonRoot, validAddonSegment } from "./store"
import type { AddonId } from "./user-config"

export class MarketplaceAddError extends Error {
  constructor(
    message: string,
    public readonly kind: "invalid_request" | "internal" = "invalid_request",
  ) {
    super(message)
    this.name = "MarketplaceAddError"
  }
}

export type ParsedMarketplaceSource =
  | { type: "local"; path: string; display: string }
  | { type: "git"; url: string; ref?: string; display: string }

export interface ParseMarketplaceSourceOptions {
  ref?: string
  cwd?: string
  homeDir?: string
}

export function parseMarketplaceSource(
  source: string,
  options: ParseMarketplaceSourceOptions = {},
): ParsedMarketplaceSource {
  const trimmed = source.trim()
  if (!trimmed) throw new MarketplaceAddError("marketplace source must not be empty")

  const { base, parsedRef } = splitSourceRef(trimmed)
  const ref = options.ref ?? parsedRef

  if (looksLikeLocalPath(base)) {
    if (ref !== undefined) {
      throw new MarketplaceAddError("--ref is only supported for git marketplace sources")
    }
    const resolved = resolveLocalSourcePath(base, options)
    return { type: "local", path: resolved, display: resolved }
  }

  if (base.startsWith("file://")) {
    if (ref !== undefined) {
      throw new MarketplaceAddError("--ref is only supported for git marketplace sources")
    }
    const resolved = path.resolve(fileURLToPath(base))
    return { type: "local", path: resolved, display: resolved }
  }

  if (isSshGitUrl(base) || isHttpGitUrl(base)) {
    const url = normalizeGitUrl(base)
    // 当前只支持 GitHub。在 add 入口就拒绝,避免非 GitHub URL 写进 config 后
    // 在后续 upgrade / fetch 时才报错。未来加自建后端时只需扩 resolveHttpSource,
    // parser 不再需要改 —— 单点判断。
    if (!resolveHttpSource(url)) {
      throw new MarketplaceAddError(
        `only GitHub marketplace sources are supported: ${url}`,
      )
    }
    return { type: "git", url, ref, display: ref ? `${url}#${ref}` : url }
  }

  if (looksLikeGithubShorthand(base)) {
    const url = `https://github.com/${base}.git`
    return { type: "git", url, ref, display: ref ? `${url}#${ref}` : url }
  }

  throw new MarketplaceAddError(
    "invalid marketplace source format; expected owner/repo, a GitHub URL, or a local marketplace path",
  )
}

// `cloneGitSource` / `fetchAndCheckout` / `gitRemoteRevision` / `gitRevParseHead` 保留命名但实现已换成
// HTTP tarball ——
// 客户机不再需要装 git。`runner` 测试钩子换成 `fetchImpl`(等同 globalThis.fetch 签名),保留参数
// 名上 git 是为了少动 marketplace.ts 一侧的调用点 + 配置里仍以 source_type: "git" 标记。
export interface CloneGitSourceInput {
  url: string
  ref?: string
  sparsePaths?: string[]
  destination: string
  fetchImpl?: FetchImpl
}

export async function cloneGitSource(input: CloneGitSourceInput): Promise<void> {
  try {
    await fetchHttpSource({
      url: input.url,
      ref: input.ref,
      sparsePaths: input.sparsePaths,
      destination: input.destination,
      fetchImpl: input.fetchImpl,
    })
  } catch (err) {
    throw new MarketplaceAddError(
      `failed to fetch marketplace source ${input.url}: ${err instanceof Error ? err.message : String(err)}`,
      "internal",
    )
  }
}

// Step 1 实测：registry tar 顶层有 <ns>-<slug>/ 壳目录，.codex-plugin/ 在其中 → strip 1。
const DEFAULT_REMOTE_STRIP = 1

export interface CloneRemoteTarInput {
  url: string
  destination: string
  fetchImpl?: FetchImpl
  strip?: number
}

export async function cloneRemoteTar(input: CloneRemoteTarInput): Promise<void> {
  const fetchImpl = input.fetchImpl ?? ((u: string | URL, init?: RequestInit) => fetch(u, init))
  // 复用 http-source 的归档抓取 helper：它在非 OK 响应时 cancel body 释放 socket，
  // 避免 undici keepalive 池里累积 CLOSE_WAIT 半连接（下载失败时尤甚）。
  const { response } = await fetchArchiveResponse([input.url], fetchImpl)
  const nodeStream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
  await extractRemoteTarball(nodeStream, input.destination, input.strip ?? DEFAULT_REMOTE_STRIP)
}

export async function gitRemoteRevision(
  url: string,
  ref?: string,
  fetchImpl?: FetchImpl,
): Promise<string> {
  try {
    return await httpRemoteRevision(url, ref, fetchImpl)
  } catch (err) {
    throw new MarketplaceAddError(
      `failed to resolve remote revision for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "internal",
    )
  }
}

// 旧实现读 `git rev-parse HEAD`;新实现读 fetchHttpSource 写下的 sidecar(.wanlaicode-revision)。
// 调用点(marketplace.ts)在 cloneGitSource / fetchAndCheckout 之后立刻读,sidecar 一定存在。
export async function gitRevParseHead(cwd: string, _fetchImpl?: FetchImpl): Promise<string> {
  try {
    return await readLocalRevision(cwd)
  } catch (err) {
    throw new MarketplaceAddError(
      `failed to read local revision at ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      "internal",
    )
  }
}

export interface FetchAndCheckoutInput {
  cwd: string
  url: string
  ref?: string
  sparsePaths?: string[]
  fetchImpl?: FetchImpl
}

// 旧实现 git fetch + checkout + sparse reapply + ff pull;新实现重下 tarball 原子替换 cwd。
// 远端 SHA 已与本地 sidecar 一致时 short-circuit,不下任何东西。
export async function fetchAndCheckout(input: FetchAndCheckoutInput): Promise<void> {
  try {
    await refreshHttpSource({
      cwd: input.cwd,
      url: input.url,
      ref: input.ref,
      sparsePaths: input.sparsePaths,
      fetchImpl: input.fetchImpl,
    })
  } catch (err) {
    throw new MarketplaceAddError(
      `failed to refresh marketplace source ${input.url}: ${err instanceof Error ? err.message : String(err)}`,
      "internal",
    )
  }
}

export function safeMarketplaceDirName(name: string): string {
  const safe = [...name]
    .map((ch) => (/[A-Za-z0-9._-]/.test(ch) ? ch : "-"))
    .join("")
    .replace(/^\.+|\.+$/g, "")
  if (!safe || safe === "..") {
    throw new MarketplaceAddError(
      `marketplace name '${name}' cannot be used as an install directory`,
    )
  }
  return safe
}

function splitSourceRef(source: string): { base: string; parsedRef?: string } {
  const hashIdx = source.lastIndexOf("#")
  if (hashIdx >= 0) {
    const ref = source.slice(hashIdx + 1).trim()
    return { base: source.slice(0, hashIdx), parsedRef: ref || undefined }
  }
  if (!source.includes("://") && !isSshGitUrl(source)) {
    const atIdx = source.lastIndexOf("@")
    if (atIdx > 0) {
      const ref = source.slice(atIdx + 1).trim()
      return { base: source.slice(0, atIdx), parsedRef: ref || undefined }
    }
  }
  return { base: source }
}

function looksLikeLocalPath(source: string): boolean {
  if (source === "." || source === "..") return true
  if (path.isAbsolute(source)) return true
  if (source.startsWith("./") || source.startsWith("../")) return true
  if (source.startsWith(".\\") || source.startsWith("..\\")) return true
  if (source.startsWith("~/") || source === "~") return true
  // Windows drive letter
  if (/^[A-Za-z]:[\\/]/.test(source)) return true
  if (source.startsWith("\\\\")) return true
  return false
}

function isSshGitUrl(source: string): boolean {
  if (source.startsWith("ssh://")) return true
  if (source.startsWith("git@") && source.includes(":")) return true
  return false
}

function isHttpGitUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://")
}

function normalizeGitUrl(url: string): string {
  const stripped = url.replace(/\/+$/, "")
  if (stripped.startsWith("https://github.com/") && !stripped.endsWith(".git")) {
    return `${stripped}.git`
  }
  return stripped
}

function looksLikeGithubShorthand(source: string): boolean {
  const segments = source.split("/")
  if (segments.length !== 2) return false
  return segments.every((seg) => /^[A-Za-z0-9._-]+$/.test(seg))
}

function expandHome(source: string, homeDir: string): string {
  if (source === "~") return homeDir
  if (source.startsWith("~/")) return path.join(homeDir, source.slice(2))
  return source
}

function resolveLocalSourcePath(source: string, options: ParseMarketplaceSourceOptions): string {
  const home = options.homeDir ?? os.homedir()
  const expanded = expandHome(source, home)
  if (path.isAbsolute(expanded)) return path.resolve(expanded)
  const cwd = options.cwd ?? process.cwd()
  return path.resolve(cwd, expanded)
}

export async function ensureLocalSourceIsDirectory(p: string): Promise<void> {
  let info
  try {
    info = await stat(p)
  } catch (err) {
    throw new MarketplaceAddError(
      `failed to resolve local marketplace source path: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!info.isDirectory()) {
    throw new MarketplaceAddError("local marketplace source must be a directory, not a file")
  }
}

export class AddonManifestMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`addon manifest name mismatch: expected "${expected}", got "${actual}"`)
    this.name = "AddonManifestMismatchError"
  }
}

export class AddonInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AddonInstallError"
  }
}

const DEFAULT_ADDON_VERSION = "local"

export interface MaterializedAddonSource {
  path: string
  cleanup: () => Promise<void>
}

export class LocalAddonArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalAddonArchiveError"
  }
}

function isArchiveFormatError(error: unknown) {
  if (!(error instanceof Error) || !("code" in error)) return false
  const code = String(error.code)
  return code.startsWith("TAR_") || code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR"
}

export async function materializeLocalAddonArchive(input: {
  archivePath: string
  stagingRoot: string
}): Promise<MaterializedAddonSource> {
  if (!path.isAbsolute(input.archivePath)) {
    throw new LocalAddonArchiveError("local addon archive path must be absolute")
  }
  if (!/\.(?:tar|tar\.gz|tgz)$/i.test(input.archivePath)) {
    throw new LocalAddonArchiveError("local addon archive must use .tar, .tar.gz, or .tgz")
  }
  const archive = await stat(input.archivePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!archive?.isFile()) {
    throw new LocalAddonArchiveError("local addon archive must be an existing file")
  }

  const stagingDir = path.join(input.stagingRoot, crypto.randomUUID())
  await mkdir(stagingDir, { recursive: true })
  const cleanup = async () => {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  try {
    await extractRemoteTarball(createReadStream(input.archivePath), stagingDir, 0)
    if (await parseManifest(stagingDir)) return { path: stagingDir, cleanup }

    const entries = (await readdir(stagingDir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    if (entries.length !== 1) {
      throw new LocalAddonArchiveError("local addon archive must contain exactly one plugin")
    }
    const root = path.join(stagingDir, entries[0]!.name)
    if (!(await parseManifest(root))) {
      throw new LocalAddonArchiveError("local addon archive does not contain a plugin manifest")
    }
    return { path: root, cleanup }
  } catch (error) {
    await cleanup()
    if (error instanceof LocalAddonArchiveError) throw error
    if (isArchiveFormatError(error)) {
      throw new LocalAddonArchiveError(
        `failed to extract local addon archive: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    throw error
  }
}

export interface MaterializeAddonSourceInput {
  source: MarketplacePluginSource
  stagingRoot: string
  fetchImpl?: FetchImpl
}

export async function materializeAddonSource(
  input: MaterializeAddonSourceInput,
): Promise<MaterializedAddonSource> {
  const stagingDir = path.join(input.stagingRoot, crypto.randomUUID())
  await mkdir(stagingDir, { recursive: true })

  const cleanup = async () => {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  try {
    if (input.source.type === "local") {
      // Copy into staging so the eventual rename into cache does not move the
      // marketplace's source directory out from under it.
      await cp(input.source.path, stagingDir, { recursive: true })
      return { path: stagingDir, cleanup }
    }

    if (input.source.type === "remote-tar") {
      await cloneRemoteTar({
        url: input.source.url,
        destination: stagingDir,
        strip: input.source.strip,
        fetchImpl: input.fetchImpl,
      })
      return { path: stagingDir, cleanup }
    }

    const ref = input.source.sha ?? input.source.ref
    const sparsePaths = input.source.subdir ? [input.source.subdir] : []
    await cloneGitSource({
      url: input.source.url,
      ref,
      sparsePaths,
      destination: stagingDir,
      fetchImpl: input.fetchImpl,
    })
    const resolved = input.source.subdir ? path.join(stagingDir, input.source.subdir) : stagingDir
    return { path: resolved, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

export interface InstallAddonToCacheInput {
  sourcePath: string
  addonId: AddonId
  cacheRoot: string
  rename?: typeof rename
}

export interface InstallAddonToCacheResult {
  installedPath: string
  version: string
}

function resolveAddonVersion(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_ADDON_VERSION
  if (!validAddonSegment(trimmed)) {
    throw new AddonInstallError(`addon manifest version "${raw}" contains invalid characters`)
  }
  return trimmed
}

export async function installAddonToCache(
  input: InstallAddonToCacheInput,
): Promise<InstallAddonToCacheResult> {
  const renameFn = input.rename ?? rename
  const manifest = await parseManifest(input.sourcePath)
  if (!manifest) {
    throw new AddonInstallError(
      `addon manifest not found at ${input.sourcePath}; expected .wanlaicode-plugin/plugin.json or .codex-plugin/plugin.json`,
    )
  }
  if (manifest.name !== input.addonId.addonName) {
    // parseManifest falls back to basename when the JSON has no "name" field,
    // which would surface as a confusing mismatch against a UUID staging dir.
    // Detect that and report the actual problem.
    const sourceBasename = path.basename(input.sourcePath).replace(/^@/, "")
    if (manifest.name === sourceBasename) {
      throw new AddonInstallError(
        `addon manifest at ${input.sourcePath} is missing the "name" field; expected "${input.addonId.addonName}"`,
      )
    }
    throw new AddonManifestMismatchError(input.addonId.addonName, manifest.name)
  }

  const version = resolveAddonVersion(manifest.version)
  if (!validAddonSegment(input.addonId.addonName)) {
    throw new AddonInstallError(`addon name "${input.addonId.addonName}" contains invalid characters`)
  }
  if (!validAddonSegment(input.addonId.marketplaceName)) {
    throw new AddonInstallError(
      `marketplace name "${input.addonId.marketplaceName}" contains invalid characters`,
    )
  }
  if (input.addonId.registryNamespace && !validAddonSegment(input.addonId.registryNamespace)) {
    throw new AddonInstallError(
      `registry namespace "${input.addonId.registryNamespace}" contains invalid characters`,
    )
  }
  const destination = addonRoot(
    input.cacheRoot,
    input.addonId.marketplaceName,
    input.addonId.addonName,
    version,
    input.addonId.registryNamespace,
  )
  await mkdir(path.dirname(destination), { recursive: true })

  // Backups live outside the <market>/<addon>/ subtree so a leftover backup
  // (after a failed restore) cannot be picked up as a "version" by the loader.
  // The directory name contains "~" which validAddonSegment rejects, so the
  // top-level scan also skips it.
  const backupRoot = path.join(input.cacheRoot, ".tmp~backup")
  await mkdir(backupRoot, { recursive: true })
  const backup = path.join(backupRoot, crypto.randomUUID())
  let backedUp = false
  try {
    await renameFn(destination, backup)
    backedUp = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }

  try {
    await renameFn(input.sourcePath, destination)
    if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    return { installedPath: destination, version }
  } catch (err) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    if (backedUp) {
      try {
        await renameFn(backup, destination)
      } catch (restoreErr) {
        // Surface both errors: original install failure plus the leftover backup
        // path so operators can recover the previous version manually.
        throw new AddonInstallError(
          `addon install failed and previous version could not be restored from backup; ` +
            `original error: ${(err as Error).message}; restore error: ${(restoreErr as Error).message}; ` +
            `backup left at: ${backup}`,
        )
      }
    }
    throw err
  }
}

export interface UninstallAddonFromCacheInput {
  addonId: AddonId
  cacheRoot: string
}

export async function uninstallAddonFromCache(input: UninstallAddonFromCacheInput): Promise<void> {
  if (!validAddonSegment(input.addonId.addonName)) {
    throw new AddonInstallError(`addon name "${input.addonId.addonName}" contains invalid characters`)
  }
  if (!validAddonSegment(input.addonId.marketplaceName)) {
    throw new AddonInstallError(
      `marketplace name "${input.addonId.marketplaceName}" contains invalid characters`,
    )
  }
  if (input.addonId.registryNamespace && !validAddonSegment(input.addonId.registryNamespace)) {
    throw new AddonInstallError(
      `registry namespace "${input.addonId.registryNamespace}" contains invalid characters`,
    )
  }
  const target = input.addonId.registryNamespace
    ? path.join(input.cacheRoot, input.addonId.marketplaceName, input.addonId.registryNamespace, input.addonId.addonName)
    : path.join(input.cacheRoot, input.addonId.marketplaceName, input.addonId.addonName)
  await rm(target, { recursive: true, force: true })
}
