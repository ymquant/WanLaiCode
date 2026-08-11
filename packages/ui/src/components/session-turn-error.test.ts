import { describe, test, expect } from "bun:test"

import {
  isAuthReconnectError,
  isNoPlanError,
  isUpstreamModelUnsupportedError,
  classifyAssistantError,
  classifyBalanceError,
  shouldRenderErrorActionButton,
} from "./session-turn-error"

describe("isAuthReconnectError", () => {
  // 后端 Key 轮换过渡期返回的真实报错（中英文 / code）都应被识别为「正在重连」
  test("命中 Key 轮换过渡期的报错", () => {
    expect(isAuthReconnectError("API 密钥已被禁用")).toBe(true)
    expect(isAuthReconnectError("密钥已被禁用")).toBe(true)
    expect(isAuthReconnectError("API_KEY_DISABLED")).toBe(true)
    expect(isAuthReconnectError('{"error":{"code":"api_key_disabled","message":"x"}}')).toBe(true)
  })

  // 其它错误不应被误判，避免把真实失败也当成「正在重连」吞掉
  test("不误判其它错误", () => {
    expect(isAuthReconnectError("invalid api key")).toBe(false)
    expect(isAuthReconnectError("无可用万来code套餐权益")).toBe(false)
    expect(isAuthReconnectError("context length exceeded")).toBe(false)
    expect(isAuthReconnectError("")).toBe(false)
  })
})

describe("isNoPlanError", () => {
  test("命中未授权 / 未开套餐", () => {
    expect(isNoPlanError("API key is required")).toBe(true)
    expect(isNoPlanError("invalid api key")).toBe(true)
    expect(isNoPlanError("无可用万来code套餐权益")).toBe(true)
  })
  test("不误判普通错误", () => {
    expect(isNoPlanError("context length exceeded")).toBe(false)
    expect(isNoPlanError("")).toBe(false)
  })
  // 回归：上游通道余额耗尽（平台侧计费问题）不能判成用户未开通套餐。
  // 真实场景：DeepSeek 账户余额不足返回 "Insufficient Balance"，套餐正常的付费用户
  // 曾被误显为「您还没有开通套餐…新用户可免费使用 DeepSeek」。
  test("不再把上游余额不足误判为未开套餐", () => {
    expect(isNoPlanError("Insufficient Balance")).toBe(false)
    expect(isNoPlanError("insufficient balance")).toBe(false)
    expect(isNoPlanError('{"error":{"message":"Insufficient Balance","type":"server_error"}}')).toBe(false)
  })
})

describe("isUpstreamModelUnsupportedError", () => {
  // 上游线路/套餐不支持所请求模型（如火山方舟编程套餐拒绝 claude）应被识别
  test("命中上游套餐/线路不支持该模型", () => {
    expect(
      isUpstreamModelUnsupportedError(
        "The requested model does not support the coding plan feature. Please refer to the documentation at https://www.volcengine.com/docs/82379/1925114 to select a compatible model.",
      ),
    ).toBe(true)
    expect(isUpstreamModelUnsupportedError("model claude-opus-4-8 is not supported")).toBe(true)
    expect(isUpstreamModelUnsupportedError("Unsupported model")).toBe(true)
  })
  // 不误判平台侧余额、上下文超限等普通错误
  test("不误判其它错误", () => {
    expect(isUpstreamModelUnsupportedError("Insufficient Balance")).toBe(false)
    expect(isUpstreamModelUnsupportedError("context length exceeded")).toBe(false)
    expect(isUpstreamModelUnsupportedError("")).toBe(false)
  })
})

describe("shouldRenderErrorActionButton", () => {
  test("仅 5 个行为 action 呈现按钮", () => {
    expect(shouldRenderErrorActionButton("relogin")).toBe(true)
    expect(shouldRenderErrorActionButton("open_purchase")).toBe(true)
    expect(shouldRenderErrorActionButton("show_quota")).toBe(true)
    expect(shouldRenderErrorActionButton("backoff_retry")).toBe(true)
    expect(shouldRenderErrorActionButton("show_blocked")).toBe(true)
  })
  test("refresh_token / show_message / undefined 不呈现按钮", () => {
    expect(shouldRenderErrorActionButton("refresh_token")).toBe(false)
    expect(shouldRenderErrorActionButton("show_message")).toBe(false)
    expect(shouldRenderErrorActionButton(undefined)).toBe(false)
  })
})

describe("classifyAssistantError", () => {
  // reason 码契约优先：网关 responseBody 里的 sub_code 命中配额，应分类为 quota_exhausted 并呈现「查看额度」按钮
  test("reason 码命中契约 → contract + 行为按钮", () => {
    const error = {
      name: "APIError",
      data: {
        message: "quota",
        statusCode: 429,
        responseBody: JSON.stringify({
          error: { code: "rate_limit_exceeded", sub_code: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" },
        }),
      },
    }
    const r = classifyAssistantError({ error, rawText: "quota", isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("quota_exhausted")
    expect(r.messageKey).toBe("errors.category.quota_exhausted")
    expect(r.action).toBe("show_quota")
    expect(shouldRenderErrorActionButton(r.action)).toBe(true)
    // quota_exhausted 不在 raw 兜底类目里，不附带原始文本
    expect(r.showRaw).toBe(false)
  })

  test("message 前缀 reason 码命中契约 → contract(upgrade_required)", () => {
    const message = "SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available"
    const error = { name: "APIError", data: { message } }
    const r = classifyAssistantError({ error, rawText: message, isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("upgrade_required")
    expect(r.messageKey).toBe("errors.category.upgrade_required")
    expect(r.showRaw).toBe(false)
  })

  test("oauth authorization expired → contract(auth_expired)", () => {
    const message = "WanlaiCode OAuth authorization expired"
    const error = { name: "APIError", data: { message } }
    const r = classifyAssistantError({ error, rawText: message, isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("auth_expired")
    expect(r.messageKey).toBe("errors.category.auth_expired")
    expect(r.action).toBe("relogin")
    expect(shouldRenderErrorActionButton(r.action)).toBe(true)
    expect(r.showRaw).toBe(false)
  })

  // HTTP 401 → auth_invalid → API 密钥无效（无行为按钮）
  test("HTTP status 兜底命中 → contract（auth_invalid）", () => {
    const error = { name: "APIError", data: { message: "unauthorized", statusCode: 401 } }
    const r = classifyAssistantError({ error, rawText: "unauthorized", isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("auth_invalid")
    expect(r.action).toBe("show_message")
    expect(shouldRenderErrorActionButton(r.action)).toBe(false)
  })

  // Key 轮换文本即使只存在于 message 中，也走旧字符串兜底「正在重连」。
  test("wanlai 网关走 Key 轮换字符串兜底 → reconnecting", () => {
    const error = { name: "APIError", data: { message: "API_KEY_DISABLED" } }
    const r = classifyAssistantError({ error, rawText: "API_KEY_DISABLED", isWanlai: true })
    expect(r.kind).toBe("reconnecting")
  })

  test("结构化 API_KEY_DISABLED 不被外层 Unauthorized 文本遮蔽", () => {
    const error = {
      name: "APIError",
      data: {
        message: "Unauthorized",
        statusCode: 401,
        responseBody: JSON.stringify({ error: { code: "API_KEY_DISABLED" } }),
      },
    }
    const r = classifyAssistantError({ error, rawText: "Unauthorized", isWanlai: true })
    expect(r.kind).toBe("reconnecting")
  })

  // resolveError 的 categoryByText 已能命中「无可用万来code套餐权益」→ entitlement_missing（契约优先，优于旧兜底）
  test("套餐权益文本被 resolveError 文本兜底命中 → contract(entitlement_missing)", () => {
    const error = { name: "APIError", data: { message: "无可用万来code套餐权益" } }
    const r = classifyAssistantError({ error, rawText: "无可用万来code套餐权益", isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("entitlement_missing")
    expect(r.action).toBe("open_purchase")
  })

  // resolveError 返回 unknown + wanlaicode 网关 + "API key is required" → 旧字符串兜底「noPlan」
  test("unknown 时 wanlai 网关走旧字符串兜底 → noPlan", () => {
    const error = { name: "APIError", data: { message: "API key is required" } }
    const r = classifyAssistantError({ error, rawText: "API key is required", isWanlai: true })
    expect(r.kind).toBe("noPlan")
  })

  // 非 wanlaicode 网关：即使文本能命中旧匹配，也不走兜底（避免误伤用户自配 provider）
  // 修复 additive-safety bug：非 wanlai provider 一律返回 raw，不改写 category、不渲染按钮
  test("非 wanlai 网关不走任何契约分类，直接返回 raw", () => {
    const error = { name: "APIError", data: { message: "API_KEY_DISABLED" } }
    const r = classifyAssistantError({ error, rawText: "API_KEY_DISABLED", isWanlai: false })
    expect(r.kind).toBe("raw")
    // 不应有 category 或 action（raw kind 不携带按钮）
    expect(r.category).toBeUndefined()
    expect(r.action).toBeUndefined()
    expect(r.rawText).toBe("API_KEY_DISABLED")
  })

  // --- additive-safety 回归测试：锁定非 wanlai provider 不走契约改写 ---

  // 非 wanlai + HTTP 401 + 契约 responseBody → 必须保持 raw，不出 contract category/按钮
  // 场景：用户自配 OpenAI key 错误，statusCode 401 本来会被 categoryByStatus 识别为 auth_invalid，
  //        但该 action（relogin 万来）对用户自配 provider 毫无意义，必须被 gate 住。
  test("非 wanlai provider HTTP 401 保持 raw（无 contract 改写、无按钮）", () => {
    const error = {
      name: "APIError",
      data: {
        message: "Incorrect API key provided",
        statusCode: 401,
        isRetryable: false,
        responseBody: JSON.stringify({ error: { code: "AUTH_INVALID" } }),
      },
    }
    const r = classifyAssistantError({ error, rawText: "Incorrect API key provided", isWanlai: false })
    expect(r.kind).toBe("raw")
    expect(r.category).toBeUndefined()
    expect(r.action).toBeUndefined()
    expect(shouldRenderErrorActionButton(r.action)).toBe(false)
    expect(r.rawText).toBe("Incorrect API key provided")
  })

  // 非 wanlai + message 含 "quota" → 也保持 raw（不触发 categoryByText 的 quota_exhausted）
  // 场景：用户自配 DeepSeek/Anthropic provider 超出配额，message 含 "quota exceeded"，
  //        但我们不应展示「查看万来额度」按钮，必须保留原始文案。
  test("非 wanlai provider quota 文本保持 raw（不走 categoryByText 改写）", () => {
    const error = { name: "APIError", data: { message: "You exceeded your quota", statusCode: 429 } }
    const r = classifyAssistantError({ error, rawText: "You exceeded your quota", isWanlai: false })
    expect(r.kind).toBe("raw")
    expect(r.category).toBeUndefined()
    expect(r.action).toBeUndefined()
    expect(shouldRenderErrorActionButton(r.action)).toBe(false)
    expect(r.rawText).toBe("You exceeded your quota")
  })

  // unknown 且无旧匹配 → contract(unknown) + 附带原始文本
  test("unknown 无任何命中 → contract(unknown)+raw", () => {
    const error = { name: "APIError", data: { message: "some weird backend error" } }
    const r = classifyAssistantError({ error, rawText: "some weird backend error", isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("unknown")
    expect(r.messageKey).toBe("errors.category.unknown")
    expect(r.showRaw).toBe(true)
    expect(shouldRenderErrorActionButton(r.action)).toBe(false)
  })

  // upstream_error（5xx）属于 raw 兜底类目，应附带原始文本
  test("upstream_error 附带原始文本", () => {
    const error = { name: "APIError", data: { message: "internal server error", statusCode: 500 } }
    const r = classifyAssistantError({ error, rawText: "internal server error", isWanlai: true })
    expect(r.category).toBe("upstream_error")
    expect(r.showRaw).toBe(true)
    expect(r.rawText).toBe("internal server error")
  })

  // wanlai 网关透传上游「模型不被套餐支持」（如火山编程套餐拒绝 claude，HTTP 400→invalid_request）：
  // 必须在契约改写前拦截为 upstreamModelUnsupported，给友好提示，且不暴露含外部文档链接的英文原文。
  test("上游线路不支持该模型 → upstreamModelUnsupported（不暴露原始英文）", () => {
    const error = {
      name: "APIError",
      data: {
        message:
          "The requested model does not support the coding plan feature. Please refer to the documentation at https://www.volcengine.com/docs/82379/1925114 to select a compatible model.",
        statusCode: 400,
      },
    }
    const r = classifyAssistantError({ error, rawText: error.data.message, isWanlai: true })
    expect(r.kind).toBe("upstreamModelUnsupported")
    expect(r.showRaw).toBe(false)
  })

  // 不变量：reason 码契约优先于字符串兜底。带行为按钮的精确契约（如 quota_exhausted）
  // 即便 message 含 "model ... not supported"，也不能被 upstreamModelUnsupported 兜底压制。
  test("带 reason 码的契约(quota)文案含 model not supported 时仍保持 contract+按钮", () => {
    const error = {
      name: "APIError",
      data: {
        message: "this model is not supported on your current quota",
        statusCode: 429,
        responseBody: JSON.stringify({
          error: { code: "rate_limit_exceeded", sub_code: "USER_PLATFORM_DAILY_QUOTA_EXHAUSTED" },
        }),
      },
    }
    const r = classifyAssistantError({ error, rawText: error.data.message, isWanlai: true })
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("quota_exhausted")
    expect(r.action).toBe("show_quota")
  })

  // 非 wanlai provider 的「模型不支持」错误不改写，保持 raw（避免误伤用户自配 provider）
  test("非 wanlai provider 模型不支持错误保持 raw", () => {
    const error = { name: "APIError", data: { message: "model gpt-x is not supported", statusCode: 400 } }
    const r = classifyAssistantError({ error, rawText: "model gpt-x is not supported", isWanlai: false })
    expect(r.kind).toBe("raw")
  })

  // 回归：wanlai 网关透传的上游「Insufficient Balance」（无 reason 码）不再误判为 noPlan，
  // 而是落到 contract(unknown)+原始文本，避免把套餐正常的付费用户误导去「开通套餐」。
  test("上游余额不足不再误判为 noPlan", () => {
    const error = { name: "APIError", data: { message: "Insufficient Balance" } }
    const r = classifyAssistantError({ error, rawText: "Insufficient Balance", isWanlai: true })
    expect(r.kind).not.toBe("noPlan")
    expect(r.kind).toBe("contract")
    expect(r.category).toBe("unknown")
    expect(r.showRaw).toBe(true)
  })
})

describe("classifyBalanceError", () => {
  test("从 responseBody 的结构化 code 归类各余额错误码", () => {
    expect(classifyBalanceError({ responseBody: '{"code":"NEED_ENABLE_BALANCE"}' })).toBe("needEnableBalance")
    expect(classifyBalanceError({ responseBody: '{"code":"NO_PLAN_NO_BALANCE"}' })).toBe("noPlanNoBalance")
    expect(classifyBalanceError({ responseBody: '{"code":"INSUFFICIENT_BALANCE"}' })).toBe("insufficientBalance")
    expect(classifyBalanceError({ responseBody: '{"code":"BALANCE_MODEL_NOT_AVAILABLE"}' })).toBe(
      "balanceModelUnavailable",
    )
    expect(classifyBalanceError({ responseBody: '{"code":"BALANCE_FALLBACK_UNAVAILABLE"}' })).toBe(
      "balanceFallbackUnavailable",
    )
  })

  test("容忍 reason 字段、网关多层包裹与字符串化 message", () => {
    expect(classifyBalanceError({ responseBody: '{"reason":"NEED_ENABLE_BALANCE"}' })).toBe("needEnableBalance")
    expect(classifyBalanceError({ responseBody: '{"error":{"sub_code":"NEED_ENABLE_BALANCE"}}' })).toBe(
      "needEnableBalance",
    )
    // message 被 provider 拼成 "Forbidden: {json}" 的形态
    expect(
      classifyBalanceError({ message: 'Forbidden: {"code":"INSUFFICIENT_BALANCE","message":"余额不足"}' }),
    ).toBe("insufficientBalance")
  })

  test("无匹配码时返回 null（不误伤普通错误）", () => {
    expect(classifyBalanceError({ message: "Insufficient Balance", responseBody: undefined })).toBe(null)
    expect(classifyBalanceError({ responseBody: '{"code":"SOMETHING_ELSE"}' })).toBe(null)
    expect(classifyBalanceError({})).toBe(null)
  })
})
