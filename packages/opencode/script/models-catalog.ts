// 模型目录的校验/序列化/新鲜度判断。
//
// generate.ts（构建期取数，决定发布产物内容）与 refresh-models-pinned.ts（刷新入库快照）
// 共用这一套规则：两处校验强度必须一致，否则真正决定产物的那一路反而更松，
// 被截断的响应能骗过构建、却骗不过刷新脚本。

export const MIN_PROVIDERS = 100
export const MUST_HAVE_PROVIDERS = ["anthropic", "openai"]

/**
 * 解析并校验模型目录。挡住三类坏数据：整页错误 HTML、被网络截断的残缺 JSON、
 * 以及目录塌缩成空对象/数组。`what` 用于让报错指明是哪一路数据出的问题。
 */
export function parseCatalog(raw: string, what: string): Record<string, unknown> {
  const data = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch (e) {
      throw new Error(`${what} 不是合法 JSON（疑似错误页或被截断）：${(e as Error).message}`)
    }
  })()
  // typeof [] === "object"，数组必须显式排除，否则会被当成合法 provider map 放行
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${what} 顶层不是对象，期望 provider map`)
  }
  const map = data as Record<string, unknown>
  const count = Object.keys(map).length
  if (count < MIN_PROVIDERS) {
    throw new Error(`${what} 只有 ${count} 个 provider，少于阈值 ${MIN_PROVIDERS}，疑似残缺`)
  }
  for (const key of MUST_HAVE_PROVIDERS) {
    if (!(key in map)) throw new Error(`${what} 缺少必备 provider "${key}"，疑似残缺`)
  }
  return map
}

/**
 * 顶层 key 排序 + 每个 provider 独占一行：让刷新产生的 diff 精确到 provider 级别，
 * 而不是 3MB 单行整体重写。体积与紧凑 JSON 基本相同。
 */
export function serializeCatalog(map: Record<string, unknown>): string {
  const keys = Object.keys(map).sort()
  const lines = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(map[key])}`)
  return `{\n${lines.join(",\n")}\n}\n`
}

/**
 * 取"这次到底是不是正式发版"的 channel。
 *
 * 必须优先读 WANLAICODE_DISPATCH_CHANNEL：publish.yml 的 Prepare/Build 步出于 B-pure 设计
 * （canary 候选用 prod 配置构建，好让 app-update.yml 烤出 path=prod），会在 canary 发版时把
 * WANLAICODE_CHANNEL 强制改写成 "prod"。拿被改写过的值判断发版性质，canary 内测会被模型目录
 * 的 90 天硬失败误伤 —— 与"只拦正式发版"的设计相反。
 *
 * 未传 DISPATCH 时回落 WANLAICODE_CHANNEL：publish-subbrand.yml 固定走 prod，子品牌发布本就
 * 是正式发版，该拦。
 */
export function resolveReleaseChannel(env: Record<string, string | undefined>): string | undefined {
  return env.WANLAICODE_DISPATCH_CHANNEL ?? env.WANLAICODE_CHANNEL ?? env.OPENCODE_CHANNEL
}

export const STALE_WARN_DAYS = 30
export const STALE_FAIL_DAYS = 90

// 拉不到时的自救指引。办公室网络到 models.dev 不通，直接跑刷新脚本同样会失败，
// 所以报错必须把"在能出网的机器上取好再 --from 拷回来"这条路写在操作者眼前，
// 而不是只躺在脚本头部注释里。
// 命令一律写成从仓库根可执行的路径：仓库根另有一个不相关的 script/ 目录，
// 写 `bun script/refresh-models-pinned.ts` 的话，操作者站在仓库根照做会先失败一次。
// 出网机器给一个已知可用的例子（生产服务器实测可直连 models.dev），省掉操作者
// 在被硬拦的当口现找"哪台机器能出网"。
export const REFRESH_HINT =
  `请跑 bun packages/opencode/script/refresh-models-pinned.ts 刷新；` +
  `若本机同样连不上 models.dev，先在能出网的机器上（例如生产服务器）执行 ` +
  `curl -fsS https://models.dev/api.json > /tmp/api.json，把文件拷回来后跑 ` +
  `bun packages/opencode/script/refresh-models-pinned.ts --from /tmp/api.json --source https://models.dev/api.json`

export type Staleness = { known: true; days: number } | { known: false; reason: string }

/**
 * 判断快照新鲜度。fetchedAt 缺失或格式非法时返回 known:false —— 调用方必须把它当成
 * "无法判断"来告警，而不能当成"没过期"放行：Date.parse 失败得到 NaN，而 NaN >= 阈值
 * 恒为 false，一旦直接拿去比较，元数据一坏陈旧检查就恰好失效，比没有检查更危险。
 */
export function staleness(fetchedAt: unknown, now: number): Staleness {
  if (typeof fetchedAt !== "string" || fetchedAt.trim() === "") {
    return { known: false, reason: "meta 缺少 fetchedAt" }
  }
  const parsed = Date.parse(fetchedAt)
  if (Number.isNaN(parsed)) return { known: false, reason: `meta 的 fetchedAt 无法解析：${fetchedAt}` }
  return { known: true, days: Math.floor((now - parsed) / 86_400_000) }
}

export type StaleLevel = "ok" | "warn" | "fail"

/**
 * 把新鲜度归成三档，供构建期（generate.ts）与转正期（check-models-stale.ts）共用同一套阈值。
 * 无法判断时归 warn 而不是 ok/fail：既不能当成"没过期"静默放行，也不该拿一个连日期都读不出来的
 * 元数据去硬拦发版。
 */
export function classifyStaleness(fetchedAt: unknown, now: number): { level: StaleLevel; days?: number; reason?: string } {
  const result = staleness(fetchedAt, now)
  if (!result.known) return { level: "warn", reason: result.reason }
  if (result.days >= STALE_FAIL_DAYS) return { level: "fail", days: result.days }
  if (result.days >= STALE_WARN_DAYS) return { level: "warn", days: result.days }
  return { level: "ok", days: result.days }
}
