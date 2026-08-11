import { REASON_TO_CATEGORY } from "./error-codes"

// 从网关错误体提取机读 reason。
// responses API 在 error.sub_code（error.code 被 OpenAI 风格占用）；
// chat/messages 在 error.code（机读码，如 API_KEY_RATE_5H_EXCEEDED）；
// 鉴权中间件(api_key_auth)的早退错误体是顶层 {code,message}（无嵌套 error），如窗口配额用满。

// 只放行契约内已知 reason（error-codes.json 单一真相表）。
// 不再用大写正则判风格：契约里存在小写码（api_key_in_query_deprecated）会被正则误滤，
// 而契约外的码（含 OpenAI 风格 code/type）一律不采信。
// own-property 判定：`in` 会把原型链继承属性（toString 等）误当契约码。
function isContractReason(code: string): boolean {
  return Object.hasOwn(REASON_TO_CATEGORY, code)
}

export function gatewayReasonFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const obj = body as { error?: unknown; reason?: unknown; code?: unknown }
  const error = obj.error
  if (error && typeof error === "object") {
    const sub = (error as { sub_code?: unknown }).sub_code
    if (typeof sub === "string" && isContractReason(sub)) return sub
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && isContractReason(code)) return code
    // 已是嵌套 error 信封（provider 风格）：不再回退读顶层，避免把自配 provider 顶层字段误采。
    return undefined
  }
  // 无嵌套 error 信封时（鉴权中间件的裸 {code,message}）才读顶层 reason/code，
  // 否则只能退 HTTP 429 → rate_limited，把「额度用完」误显示成「请求过于频繁」。
  // 同样只采信契约内机读码（session-turn-error 的 extractBackendCode 亦读顶层 code，但顺序相反）。
  const topReason = obj.reason
  if (typeof topReason === "string" && isContractReason(topReason)) return topReason
  const topCode = obj.code
  if (typeof topCode === "string" && isContractReason(topCode)) return topCode
  return undefined
}
