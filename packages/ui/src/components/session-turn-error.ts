import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"

// 识别「Key 轮换过渡期」类错误。后端在管理员改套餐等场景会轮换 API Key：
// 旧 Key 被禁用、新 Key 就绪之间有数十秒窗口，期间请求拿到 API_KEY_DISABLED。
// 客户端已在 fetch 层自动重新拉取新 Key 并重试，这里只是把过渡期偶发的报错
// 替换成「正在重新连接」的友好提示，而不是把吓人的原始报错丢给用户。
//
// 抽成独立的无 UI 依赖模块，便于单测直接导入（不触发 solid 组件的客户端副作用）。
export function isAuthReconnectError(text: string) {
  const normalized = text.toLowerCase()
  return (
    normalized.includes("api_key_disabled") ||
    text.includes("API 密钥已被禁用") ||
    text.includes("密钥已被禁用")
  )
}

// 识别「未授权 / 未开套餐」类后端错误。
// 命中后用友好的开通引导文案替换，避免把 "API key is required" 这类原始报错直接丢给用户。
// 仅作为 resolveError 返回 unknown 时的最后兜底（无 reason 码的旧错误仍能命中）。
//
// 注意：不再匹配 "insufficient balance"。上游通道（如 DeepSeek 账户）余额耗尽会返回
// "Insufficient Balance"，那是「平台侧」计费问题，与用户自身的套餐 / 订阅状态无关。
// 误判成「未开通套餐」会把套餐正常的付费用户引导去「开通套餐 / 改用 DeepSeek」，而
// DeepSeek 恰恰正是当时不可用的模型。此类上游错误应留给契约分类（upstream_error）兜底，
// 或由后端下发对应 reason 码，而不是在此误归为 noPlan。
export function isNoPlanError(text: string) {
  const normalized = text.toLowerCase()
  return (
    normalized.includes("api key is required") ||
    normalized.includes("api_key_required") ||
    normalized.includes("invalid api key") ||
    normalized.includes("unauthorized") ||
    normalized.includes("entitlement") ||
    normalized.includes("not entitled") ||
    normalized.includes("no active subscription") ||
    normalized.includes("subscription_not_found") ||
    text.includes("套餐权益") ||
    text.includes("套餐授权") ||
    text.includes("软件套餐") ||
    text.includes("无可用万来code套餐权益")
  )
}

// 识别「上游线路/套餐不支持所请求模型」类错误。
// 典型：火山方舟编程套餐对非白名单模型返回
// "The requested model does not support the coding plan feature ... select a compatible model"。
// 模型列表由网关控制、用户无从选错，这类错误本质是平台侧账号池 / 路由配置问题，
// 不应把含外部文档链接的上游英文原文直接抛给用户，而是提示切换模型或稍后重试。
export function isUpstreamModelUnsupportedError(text: string) {
  const m = text.toLowerCase()
  if (m.includes("coding plan") || m.includes("compatible model")) return true
  if (m.includes("model") && (m.includes("not support") || m.includes("unsupported"))) return true
  return false
}

// 分类来源：
//   - "contract"：命中 resolveError 的 reason 码契约表，文案来自 errors.category.*，可能带行为按钮。
//   - "reconnecting"：兜底命中 Key 轮换过渡期，用「正在重新连接」文案。
//   - "noPlan"：兜底命中未授权/未开套餐，用开通引导文案。
//   - "upstreamModelUnsupported"：上游线路/套餐不支持该模型，用「切换模型或稍后重试」友好文案。
//   - "raw"：无任何命中，直接展示后端原始文本。
export type AssistantErrorKind = "contract" | "reconnecting" | "noPlan" | "upstreamModelUnsupported" | "raw"

export type ClassifiedAssistantError = {
  kind: AssistantErrorKind
  /** 仅 kind==="contract" 时有意义：errors.category.<category> 的 i18n key。 */
  messageKey?: string
  /** 仅 kind==="contract" 时有意义：契约 category。 */
  category?: string
  /** 行为按钮 action（仅在需要呈现按钮的 action 集合内才用）。 */
  action?: ErrorAction
  /** 是否在通用文案下方附带展示后端原始 message（避免丢失具体信息）。 */
  showRaw: boolean
  /** 附带展示 / 直接展示的原始文本。 */
  rawText: string
}

// category 命中契约但文案偏笼统时，额外附带后端原始 message，避免丢失具体信息。
const RAW_FALLBACK_CATEGORIES = new Set([
  "unknown",
  "invalid_request",
  "upstream_error",
  "service_unavailable",
])

// 需要在错误卡片内渲染行为按钮的 action 集合（与 app 的 ErrorActionView 保持一致）。
// refresh_token / show_message 由调用层或上游自动处理，不呈现按钮。
const ACTION_BUTTON_SET = new Set<ErrorAction>([
  "relogin",
  "open_purchase",
  "show_quota",
  "backoff_retry",
  "show_blocked",
])

export function shouldRenderErrorActionButton(action: ErrorAction | undefined): action is ErrorAction {
  return !!action && ACTION_BUTTON_SET.has(action)
}

// 对一条 assistant 错误做分类，决定展示文案与行为按钮。
//
// 优先级（仅 wanlaicode 网关）：reason 码契约（resolveError）→ 旧字符串匹配兜底。
// 非 wanlaicode provider（用户自配的 OpenAI/Anthropic/DeepSeek 等）一律返回 raw，
// 直接展示后端原始文本、不改写 category 文案、不渲染行为按钮（按钮指向万来 OAuth，对外部 provider 无意义）。
//
// @param error      整个 APIError 对象（含 data.message / data.responseBody），传给 resolveError。
// @param rawText    上层 unwrap 出的后端原始文本（用于附带展示 / 兜底匹配）。
// @param isWanlai   该错误是否来自 wanlaicode 网关；只有此情况下才走契约分类与旧字符串兜底。
export function classifyAssistantError(input: {
  error: unknown
  rawText: string
  isWanlai: boolean
}): ClassifiedAssistantError {
  const { error, rawText, isWanlai } = input

  // 契约分类与旧字符串兜底只对 wanlaicode 网关有意义。
  // 外部 provider 没有万来 reason 码，行为按钮（开通/重新登录万来）对它们无效，
  // 强行改写 category 会压制真实的 provider 错误信息——因此直接跳到 raw 兜底。
  if (isWanlai) {
    // 已 gate isWanlai，担保来自万来网关：opt-in trustHeuristics，
    // 让无 reason 码的裸 5xx/401 也能退 HTTP status 兜底（万来网关上游错误透传场景）。
    const resolved = resolveError(error, { trustHeuristics: true })

    // 上游线路/套餐不支持该模型（如火山编程套餐拒绝 claude，HTTP 400→invalid_request）：
    // 仅当契约落到「会附带展示上游英文原文、且不带行为按钮」的兜底类目（invalid_request / unknown）
    // 时才改写为友好文案——既隐藏含外部文档链接的英文原文，又不压制带行为按钮的精确 reason 码契约
    // （如 quota_exhausted / auth_invalid），保持「契约优先于字符串兜底」的不变量。
    if (
      (resolved.category === "invalid_request" || resolved.category === "unknown") &&
      rawText &&
      isUpstreamModelUnsupportedError(rawText)
    ) {
      return { kind: "upstreamModelUnsupported", showRaw: false, rawText }
    }

    // Key 轮换过渡期优先于契约分类：优先读取结构化 reason，兼容外层 message 把真实码
    // 遮蔽成 Unauthorized 的响应；旧响应仍由 rawText 字符串兜底。
    if (resolved.reason === "API_KEY_DISABLED" || (rawText && isAuthReconnectError(rawText))) {
      return { kind: "reconnecting", showRaw: false, rawText }
    }

    // reason 码优先：命中契约（非 unknown）直接用 category 文案。
    if (resolved.category !== "unknown") {
      return {
        kind: "contract",
        messageKey: resolved.messageKey,
        category: resolved.category,
        action: resolved.action,
        showRaw: RAW_FALLBACK_CATEGORIES.has(resolved.category) && !!rawText,
        rawText,
      }
    }

    // resolveError 返回 unknown：旧字符串匹配兜底（覆盖无 reason 码的旧错误）。
    // 轮换判定已提前到契约分类之前，此处只剩 noPlan 兜底。
    if (rawText && isNoPlanError(rawText)) {
      return { kind: "noPlan", showRaw: false, rawText }
    }

    // wanlaicode 网关但无任何命中 → contract(unknown) + 附带原始文本。
    return {
      kind: "contract",
      messageKey: resolved.messageKey, // errors.category.unknown
      category: resolved.category,
      action: resolved.action,
      showRaw: !!rawText,
      rawText,
    }
  }

  // 非 wanlaicode provider：直接展示后端原始文本，不走任何契约改写。
  return { kind: "raw", showRaw: false, rawText }
}

// —— 无套餐用户「账户余额按量付费」相关错误码（后端 HTTP 403，body 带 code/reason）——
//
// 这些码必须严格区分，避免历史上「余额不足被误显示成升级套餐」之类的错配。
// 以下 5 个码与后端 internal/server/middleware/api_key_auth.go 一一对应（HTTP 403）：
//   - needEnableBalance         无可用套餐但用户未开余额开关 → 弹窗引导开启余额扣费并重试
//   - noPlanNoBalance           既无套餐也无余额            → 引导购买套餐 / 充值
//   - insufficientBalance       余额不足                   → 引导充值
//   - balanceModelUnavailable   该模型不支持余额扣费        → 引导换模型
//   - balanceFallbackUnavailable 余额扣费暂未开放（平台侧）   → 引导稍后重试 / 换模型
export type BalanceErrorKind =
  | "needEnableBalance"
  | "noPlanNoBalance"
  | "insufficientBalance"
  | "balanceModelUnavailable"
  | "balanceFallbackUnavailable"
  | null

// 后端约定的错误码字符串（HTTP 403 响应 body 里的 code / reason 字段）。
const BALANCE_ERROR_CODE_MAP: Record<string, Exclude<BalanceErrorKind, null>> = {
  NEED_ENABLE_BALANCE: "needEnableBalance",
  NO_PLAN_NO_BALANCE: "noPlanNoBalance",
  INSUFFICIENT_BALANCE: "insufficientBalance",
  BALANCE_MODEL_NOT_AVAILABLE: "balanceModelUnavailable",
  BALANCE_FALLBACK_UNAVAILABLE: "balanceFallbackUnavailable",
}

// 从任意（可能多层包裹 / 字符串化）的 JSON 里提取后端错误码字段。
// 后端可能把码放在 code 或 reason；网关再包一层 error.code / error.sub_code，
// responses API 走 error.sub_code（见错误码契约备忘）。这里把这些位置都扫一遍。
function extractBackendCode(input: unknown, depth = 0): string | undefined {
  if (depth > 6 || input == null) return undefined

  if (typeof input === "string") {
    const trimmed = input.trim()
    if (!trimmed) return undefined
    // 命中码字符串本身（例如 message 直接就是 "NEED_ENABLE_BALANCE"）。
    if (BALANCE_ERROR_CODE_MAP[trimmed]) return trimmed
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractBackendCode(JSON.parse(trimmed), depth + 1)
      } catch {
        return undefined
      }
    }
    // message 常被 provider 拼成 "Forbidden: {json}" 这种带前缀的形态，
    // 抽出其中的 {...} 再尝试解析。
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start !== -1 && end > start) {
      try {
        return extractBackendCode(JSON.parse(trimmed.slice(start, end + 1)), depth + 1)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  if (typeof input !== "object" || Array.isArray(input)) return undefined

  const obj = input as Record<string, unknown>
  for (const key of ["code", "reason", "sub_code", "subCode"]) {
    const value = obj[key]
    if (typeof value === "string" && BALANCE_ERROR_CODE_MAP[value.trim()]) return value.trim()
  }
  for (const key of ["error", "data", "body", "detail"]) {
    if (key in obj) {
      const found = extractBackendCode(obj[key], depth + 1)
      if (found) return found
    }
  }
  return undefined
}

// 优先用结构化错误码归类；responseBody 是后端原始 body（最可靠），message 作为兜底。
// 仅在结构化码命中时返回非 null，避免误伤普通错误文案。
export function classifyBalanceError(input: {
  message?: string
  responseBody?: string
}): BalanceErrorKind {
  const code = extractBackendCode(input.responseBody) ?? extractBackendCode(input.message)
  if (!code) return null
  return BALANCE_ERROR_CODE_MAP[code] ?? null
}
