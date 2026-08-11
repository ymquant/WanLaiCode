import { mkdir, readFile, rename, rm, writeFile } from "fs/promises"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import path from "path"
import * as tar from "tar"

// Sidecar 文件,落在 marketplace 根目录里,代替 `git rev-parse HEAD` 的作用 ——
// 每次解包后把对应 commit SHA 写进去,下次 upgrade 读它做对比 / 上报给配置。
export const REVISION_FILE = ".wanlaicode-revision"

export class HttpSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HttpSourceError"
  }
}

// 内部 fetch 抽象 —— 测试用 mock 不实现 Bun 自带的 `preconnect`,所以不直接复用 typeof fetch。
export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>

interface ResolvedHttpSource {
  archiveUrls: string[]
  commitsApi: { urls: string[]; pickSha: (json: unknown) => string | undefined } | null
}

// 用户可能直接配 ghfast.top / gh-proxy.com 这种反代前缀的 URL,统一剥掉再走 archive endpoint。
function stripMirrorPrefix(url: string): string {
  return url.replace(/^https?:\/\/(?:ghfast\.top|gh-proxy\.com|ghproxy\.com)\/+(?=https?:\/\/)/, "")
}

// 旧版本 `addon marketplace add git@github.com:owner/repo.git` / `ssh://git@github.com/...`
// 装下来的 marketplace,config 里仍保留 SSH 形式 URL。把它改写成 HTTPS,语义等价,
// 新版下走 tarball 透明。覆盖两种形态:`git@github.com:owner/repo.git` 短形式 + `ssh://`。
function normalizeSshToHttps(url: string): string {
  const m = url.match(
    /^(?:git@github\.com:|ssh:\/\/(?:git@)?github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/,
  )
  return m ? `https://github.com/${m[1]}/${m[2]}` : url
}

function pickGithubSha(json: unknown): string | undefined {
  if (json && typeof json === "object" && "sha" in json) {
    const sha = (json as { sha?: unknown }).sha
    return typeof sha === "string" ? sha : undefined
  }
  return undefined
}

// 当前只支持 GitHub。未来加自建 / 其他后端时,先做 provider 抽象,不要在这里堆 if 分支。
export function resolveHttpSource(rawUrl: string, ref?: string): ResolvedHttpSource | null {
  const cleaned = stripMirrorPrefix(normalizeSshToHttps(rawUrl)).replace(/\.git$/, "").replace(/\/+$/, "")

  const gh = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/)
  if (gh) {
    const [, owner, repo] = gh
    const refSegment = ref ? encodeURIComponent(ref) : ""
    const tarballApi = ref
      ? `https://api.github.com/repos/${owner}/${repo}/tarball/${refSegment}`
      : `https://api.github.com/repos/${owner}/${repo}/tarball`
    const commitsApi = `https://api.github.com/repos/${owner}/${repo}/commits/${ref ? encodeURIComponent(ref) : "HEAD"}`
    // api.github.com 已经 302 → codeload,反代会跟随;独立 codeload 入口需要
    // 知道默认分支名(无 ref 场景拼不出有效 URL),所以不在 fallback 列表里。
    return {
      archiveUrls: [
        tarballApi,
        `https://ghfast.top/${tarballApi}`,
        `https://gh-proxy.com/${tarballApi}`,
      ],
      // commits API 也走反代列表 —— api.github.com 被墙时,GFW 用户即便能通过反代取 tarball
      // 也无法解析 ref→SHA(此处仅做兜底;主路径已经从 tarball 顶层目录名直接抽 SHA)。
      commitsApi: {
        urls: [
          commitsApi,
          `https://ghfast.top/${commitsApi}`,
          `https://gh-proxy.com/${commitsApi}`,
        ],
        pickSha: pickGithubSha,
      },
    }
  }

  return null
}

export async function fetchArchiveResponse(
  urls: string[],
  fetchImpl: FetchImpl,
): Promise<{ response: Response; url: string }> {
  let lastError: Error | null = null
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "wanlaicode-addon",
          Accept: "application/gzip,application/octet-stream,*/*",
        },
        redirect: "follow",
      })
      if (response.ok && response.body) {
        return { response, url }
      }
      // 非 OK 响应:cancel body 释放底层 socket。否则 undici keepalive 池里会
      // 累积 CLOSE_WAIT 状态的半读连接,多个反代轮转后会拖慢后续 fetch。
      await response.body?.cancel().catch(() => undefined)
      lastError = new HttpSourceError(`archive fetch ${url} returned HTTP ${response.status}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new HttpSourceError("archive fetch failed: no candidate URLs")
}

function buildSparseFilter(sparsePaths: string[] | undefined): ((p: string) => boolean) | undefined {
  if (!sparsePaths || sparsePaths.length === 0) return undefined
  const prefixes = sparsePaths.map((p) => p.replace(/^\/+|\/+$/g, ""))
  return (entryPath: string) => {
    // tar 给的 entryPath 包含顶层目录(e.g. "owner-repo-sha/plugins/foo.md"),strip:1 之后才落到磁盘。
    // filter 里我们手动剥掉顶层做匹配,目录条目(以 "/" 结尾)放行,避免子文件因父目录被过滤而没创建。
    const stripped = entryPath.replace(/^[^/]+\/?/, "")
    if (stripped === "") return true
    return prefixes.some((p) => stripped === p || stripped.startsWith(p + "/") || p.startsWith(stripped + "/"))
  }
}

export interface FetchHttpSourceInput {
  url: string
  ref?: string
  sparsePaths?: string[]
  destination: string
  fetchImpl?: FetchImpl
  // 调用方已有的 SHA(例如 refreshHttpSource 先做过 SHA 比对就拿到了)。
  // tarball 顶层解析失败时优先用它写 sidecar,避免再发一次 commits API 请求。
  knownRevision?: string
}

export interface FetchHttpSourceResult {
  revision: string
}

// 流式 tar.extract 到 destination —— strip:1 砍掉 GitHub tarball 顶层 `<owner>-<repo>-<sha>/`,
// 同时从那个顶层目录名里抠出 commit SHA(免一次 commits API)。
//
// tar v7 通过 gzip 魔数自动识别 → 不需要显式 createGunzip;显式 createGunzip 会和反代
// (ghfast/gh-proxy)设置 Content-Encoding: gzip 触发的 undici 自动解压撞车。

// 内部通用解包 helper：接受任意 strip 值。
async function tarExtract(source: Readable | NodeJS.ReadableStream, destination: string, strip: number): Promise<void> {
  await pipeline(
    source as Readable,
    tar.extract({
      cwd: destination,
      strip,
    }),
  )
}

async function extractTarballToDir(
  source: Readable,
  destination: string,
  sparsePaths: string[] | undefined,
): Promise<{ revisionFromTarball: string | null }> {
  let revisionFromTarball: string | null = null
  const captureRevision = (entry: { path: string }) => {
    if (revisionFromTarball) return
    const topdir = entry.path.split("/")[0] ?? ""
    const m = topdir.match(/-([0-9a-f]{7,40})$/i)
    if (m) revisionFromTarball = m[1] ?? null
  }
  await pipeline(
    source,
    tar.extract({
      cwd: destination,
      strip: 1,
      filter: buildSparseFilter(sparsePaths),
      onentry: captureRevision,
    }),
  )
  return { revisionFromTarball }
}

// 远程下载的插件 tar：strip 由调用方按包布局决定（registry 包通常带顶层 <ns>-<slug>/ 壳目录，strip 1）。
export async function extractRemoteTarball(
  stream: NodeJS.ReadableStream,
  destination: string,
  strip: number,
): Promise<void> {
  await mkdir(destination, { recursive: true })
  await tarExtract(stream, destination, strip)
}

// 把远端 git 仓库当 HTTP 资源拉下来 —— GitHub 的 tarball endpoint 流式 tar.extract
// 解到 destination(strip:1 砍掉顶层 owner-repo-sha 目录)。SHA 优先从 tarball 顶层目录名
// (`<owner>-<repo>-<sha>/`)解析,失败再退回 commits API。
// 写 REVISION_FILE sidecar 当 `git rev-parse HEAD` 用。
//
// 长路径:tar 包内的 entry 直接通过 fs.createWriteStream(<destination>/<entry>) 写,绝对路径,
// libuv 在 Windows 上自动加 `\\?\` 前缀,绕过 MAX_PATH。
export async function fetchHttpSource(input: FetchHttpSourceInput): Promise<FetchHttpSourceResult> {
  const resolved = resolveHttpSource(input.url, input.ref)
  if (!resolved) {
    throw new HttpSourceError(
      `unsupported marketplace source URL (only GitHub HTTP supported): ${input.url}`,
    )
  }
  const fetchImpl = input.fetchImpl ?? fetch

  await mkdir(input.destination, { recursive: true })

  const { response } = await fetchArchiveResponse(resolved.archiveUrls, fetchImpl)

  const { revisionFromTarball } = await extractTarballToDir(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    input.destination,
    input.sparsePaths,
  )

  // 1) 优先用 tarball 顶层目录解析出的 SHA —— 免一次网络请求,且在 commits API
  //    限流 / 反代被墙时仍能拿到 revision,不会丢弃已经成功下载的 tarball 内容。
  // 2) 解析失败时复用调用方传入的 knownRevision(refreshHttpSource 已经做过比对)。
  // 3) 两条都失败才退回 commits API。
  // 注:显式类型注解破 TS 对 closure-mutated 变量的初始值窄化。
  let revision: string | null = revisionFromTarball ?? input.knownRevision ?? null
  if (!revision) {
    revision = await getRemoteRevision(input.url, input.ref, fetchImpl)
  }
  await writeSidecar(input.destination, { revision, sparsePaths: input.sparsePaths })
  return { revision }
}

export async function getRemoteRevision(
  url: string,
  ref?: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const resolved = resolveHttpSource(url, ref)
  if (!resolved?.commitsApi) {
    throw new HttpSourceError(`cannot resolve remote revision for ${url}`)
  }
  const { urls, pickSha } = resolved.commitsApi
  let lastError: Error | null = null
  for (const apiUrl of urls) {
    try {
      const r = await fetchImpl(apiUrl, {
        headers: { "User-Agent": "wanlaicode-addon", Accept: "application/json" },
      })
      if (!r.ok) {
        await r.body?.cancel().catch(() => undefined)
        lastError = new HttpSourceError(`commits API ${apiUrl} returned HTTP ${r.status}`)
        continue
      }
      // sniff content-type:反代限流时常返回 HTTP 200 + HTML 反爬页,
      // 直接 r.json() 会抛 SyntaxError 把真实失因(限流 / 抓包)淹没掉。
      const ct = r.headers.get("content-type") ?? ""
      if (!ct.includes("application/json")) {
        await r.body?.cancel().catch(() => undefined)
        lastError = new HttpSourceError(
          `commits API ${apiUrl} returned non-JSON content-type "${ct}"`,
        )
        continue
      }
      const json = await r.json()
      const sha = pickSha(json)
      if (!sha) {
        lastError = new HttpSourceError(`commits API ${apiUrl} returned no SHA`)
        continue
      }
      return sha
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new HttpSourceError(`commits API failed: no candidate URLs for ${url}`)
}

export interface LocalSidecar {
  revision: string
  sparsePaths?: string[]
  // 兼容旧版本 bundled marketplace sidecar；当前版本不再写入该字段。
  bundledFrom?: string
}

// sidecar 兼容两种格式:
//  - 老版本:纯 SHA 文本(40-char hex)
//  - 新版本:JSON `{ revision, sparsePaths?, bundledFrom? }` —— sparse_paths 用于检测配置变化,
//    bundledFrom 仅作为旧缓存兼容字段保留。
export async function readLocalSidecar(dir: string): Promise<LocalSidecar> {
  const content = await readFile(path.join(dir, REVISION_FILE), "utf8")
  const trimmed = content.trim()
  if (!trimmed) throw new HttpSourceError(`empty revision sidecar at ${dir}`)
  if (!trimmed.startsWith("{")) {
    return { revision: trimmed }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new HttpSourceError(`failed to parse sidecar at ${dir}: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object") {
    throw new HttpSourceError(`malformed sidecar at ${dir}`)
  }
  const obj = parsed as { revision?: unknown; sparsePaths?: unknown; bundledFrom?: unknown }
  if (typeof obj.revision !== "string" || !obj.revision) {
    throw new HttpSourceError(`sidecar at ${dir} missing revision field`)
  }
  const sparsePaths =
    Array.isArray(obj.sparsePaths) && obj.sparsePaths.every((p) => typeof p === "string")
      ? (obj.sparsePaths as string[])
      : undefined
  const bundledFrom = typeof obj.bundledFrom === "string" && obj.bundledFrom ? obj.bundledFrom : undefined
  return { revision: obj.revision, sparsePaths, bundledFrom }
}

export async function readLocalRevision(dir: string): Promise<string> {
  return (await readLocalSidecar(dir)).revision
}

async function writeSidecar(dir: string, sidecar: LocalSidecar): Promise<void> {
  const sparsePaths = sidecar.sparsePaths?.filter((p) => p.trim().length > 0)
  const hasSparsePaths = !!sparsePaths && sparsePaths.length > 0
  const hasBundledFrom = !!sidecar.bundledFrom
  // 任何附加字段存在就走 JSON,否则保留旧版纯 SHA 文本 —— 不带任何元数据时与历史 sidecar 二进制一致,
  // 便于回滚 / 与老版本互读。
  let payload: string
  if (hasSparsePaths || hasBundledFrom) {
    const obj: Record<string, unknown> = { revision: sidecar.revision }
    if (hasSparsePaths) obj.sparsePaths = normalizeSparsePaths(sparsePaths!)
    if (hasBundledFrom) obj.bundledFrom = sidecar.bundledFrom
    payload = JSON.stringify(obj)
  } else {
    payload = sidecar.revision
  }
  await writeFile(path.join(dir, REVISION_FILE), payload, "utf8")
}

function normalizeSparsePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  for (const p of paths) {
    seen.add(p.replace(/^\/+|\/+$/g, ""))
  }
  return [...seen].sort()
}

function sparsePathsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = normalizeSparsePaths(a ?? [])
  const bb = normalizeSparsePaths(b ?? [])
  if (aa.length !== bb.length) return false
  return aa.every((x, i) => x === bb[i])
}

// SHA / refs/tags/* / vN.N 形态的 ref 是不可变的;本地若已有内容就是正确的,
// upgrade 时不需要任何网络请求。等价于旧 git 流的 shouldPullRef short-circuit。
export function isImmutableRef(ref?: string): boolean {
  if (!ref) return false
  if (ref.startsWith("refs/tags/")) return true
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return true
  if (/^v?\d+\.\d+/.test(ref)) return true
  return false
}

export interface RefreshHttpSourceInput {
  cwd: string
  url: string
  ref?: string
  sparsePaths?: string[]
  fetchImpl?: FetchImpl
}

export interface RefreshHttpSourceResult {
  revision: string
  changed: boolean
}

// 原 `fetchAndCheckout` 的等价语义:用同一个 cwd 内的内容更新到 ref 的最新 SHA。
// 实现:拉 tarball 到临时目录,原子 rename 替换 cwd —— git fetch 走不动了,简单粗暴但无副作用。
export async function refreshHttpSource(input: RefreshHttpSourceInput): Promise<RefreshHttpSourceResult> {
  const fetchImpl = input.fetchImpl ?? fetch

  // 不可变 ref + sidecar 已存在且 sparse_paths 未变:本地内容就是正确的,直接
  // short-circuit,不发任何网络请求。固定版本部署在离线 / 限流环境下的幂等保证。
  if (isImmutableRef(input.ref)) {
    try {
      const local = await readLocalSidecar(input.cwd)
      if (sparsePathsEqual(local.sparsePaths, input.sparsePaths)) {
        return { revision: local.revision, changed: false }
      }
      // sparse_paths 改了,fall through 重下
    } catch {
      // sidecar 缺失,fall through 走完整流程
    }
  }

  // 浮动 ref:先尝试比 SHA + sparse_paths;均一致就跳过下载。
  // 比对失败(API 限流 / 网络不通)直接走重下兜底。
  let remote: string | null = null
  try {
    remote = await getRemoteRevision(input.url, input.ref, fetchImpl)
  } catch {
    remote = null
  }
  if (remote) {
    try {
      const local = await readLocalSidecar(input.cwd)
      if (local.revision === remote && sparsePathsEqual(local.sparsePaths, input.sparsePaths)) {
        return { revision: remote, changed: false }
      }
    } catch {
      // 没有 sidecar,fall through 重下
    }
  }

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const staging = `${input.cwd}.tmp-${stamp}`
  const backup = `${input.cwd}.bak-${stamp}`

  try {
    const result = await fetchHttpSource({
      url: input.url,
      ref: input.ref,
      sparsePaths: input.sparsePaths,
      destination: staging,
      fetchImpl,
      // 已经取到的 SHA 透传过去,fetchHttpSource 在 tarball 解析失败时直接复用,
      // 不再二次发 commits API(GitHub 匿名 60/h 限流下省一半名额)。
      knownRevision: remote ?? undefined,
    })

    // backup-swap:先把旧目录 rename 到 backup,再把 staging rename 到 cwd。
    // 中途崩溃 / 失败时把 backup 回滚到 cwd,杜绝"cwd 不存在"窗口。
    let backupCreated = false
    try {
      await rename(input.cwd, backup)
      backupCreated = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      // cwd 不存在:refresh 场景通常 cwd 已存在,这里给首启等边界场景留兜底
    }
    try {
      await rename(staging, input.cwd)
    } catch (renameErr) {
      if (backupCreated) {
        await rename(backup, input.cwd).catch(() => undefined)
      }
      throw renameErr
    }
    if (backupCreated) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    }

    return { revision: result.revision, changed: true }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}
