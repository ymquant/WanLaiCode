import { expect, test, describe } from "bun:test"
import { imageErrorDetails } from "@/provider/wanlaicode-image-generation"
import { authenticatedAccountFields, backendErrorReason, oauthReauthenticationRequired } from "./wanlaicode-user-center"

describe("backendErrorReason", () => {
  test("reads reason from envelope body", () => {
    expect(backendErrorReason({ code: 403, message: "x", reason: "SUBSCRIPTION_EXPIRED" })).toBe("SUBSCRIPTION_EXPIRED")
  })
  test("returns undefined when absent", () => {
    expect(backendErrorReason({ code: 1, message: "x" })).toBeUndefined()
    expect(backendErrorReason(null)).toBeUndefined()
  })
})

describe("user center account projection", () => {
  const oauth = {
    type: "oauth" as const,
    access: "",
    refresh: "refresh_123",
    expires: 1,
    accountId: "acct_123",
    accountEmail: "user@example.com",
    accountName: "测试账号",
  }

  test("未认证时不返回本地残留账号资料", () => {
    // refresh token 被判失效后，email/name 不能再让 renderer 误判成已登录。
    expect(authenticatedAccountFields(false, oauth)).toEqual({})
  })

  test("有效 OAuth 认证继续返回账号资料", () => {
    // 正常登录状态保持原协议字段，避免修复陈旧状态时影响账号菜单和问题报告。
    expect(authenticatedAccountFields(true, oauth)).toEqual({
      account_id: "acct_123",
      account_email: "user@example.com",
      account_name: "测试账号",
    })
  })

  test("OAuth 失效时明确要求重新认证但不恢复已登录状态", () => {
    // 该投影只用于解释登录失败原因，不能让失效凭据重新获得用户中心或远控权限。
    expect(oauthReauthenticationRequired(false, oauth)).toBe(true)
    expect(oauthReauthenticationRequired(true, oauth)).toBe(false)
    expect(oauthReauthenticationRequired(false, { type: "api", key: "sk-test" })).toBe(false)
  })
})

describe("imageErrorDetails", () => {
  test("reads OpenAI-compatible nested error body", () => {
    expect(imageErrorDetails('{"error":{"message":"Request failed","type":"upstream_error"}}')).toEqual({
      message: "Request failed",
      reason: "upstream_error",
    })
  })

  test("reads flat backend error body", () => {
    expect(imageErrorDetails('{"message":"busy","reason":"SERVICE_UNAVAILABLE"}')).toEqual({
      message: "busy",
      reason: "SERVICE_UNAVAILABLE",
    })
  })

  test("falls back to plain text without parsing as JSON", () => {
    expect(imageErrorDetails("gateway timeout")).toEqual({ message: "gateway timeout" })
  })
})

describe("image intent model selection", () => {
  test("prefers the current chat model before provider fallbacks", async () => {
    const source = await Bun.file(new URL("./wanlaicode-user-center.ts", import.meta.url)).text()

    expect(source).toContain(".getSmallModel(requestedProviderID)")
    expect(source).toContain(".getModel(requestedProviderID, ModelID.make(payload.model))")
    expect(source).toContain(
      "dedupe([selected, small, fallback]).filter((item) => item.providerID === requestedProviderID)",
    )
    // 每次分类尝试 30 秒，外层再包 60 秒总超时，避免多个候选模型串行时长挂起。
    expect(source).toContain("imageIntentAttemptTimeoutMs = 30_000")
    expect(source).toContain("imageIntentTotalTimeoutMs = 60_000")
    expect(source).toContain("Effect.timeout(imageIntentTotalTimeoutMs)")
  })

  test("treats wanlaicode claude models as a last-resort classifier fallback, not excluded", async () => {
    const source = await Bun.file(new URL("./wanlaicode-user-center.ts", import.meta.url)).text()

    // claude 仍可作为兜底分类模型（排序值最低优先级），不再被 canClassify 硬排除。
    expect(source).toContain(
      'if (item.providerID === ProviderID.make("wanlaicode") && /claude/i.test(item.id)) return 50',
    )
    // canClassify 只看模态能力，不再因 claude 直接返回 false。
    expect(source).toContain("return item.capabilities.input.text && item.capabilities.output.text")
  })

  test("uses a Codex-like tool routing contract for image intent", async () => {
    const source = await Bun.file(new URL("./wanlaicode-user-center.ts", import.meta.url)).text()

    expect(source).toContain("central intent router for a Codex-like chat system")
    expect(source).toContain("Asking for the prompt text of a previous image is chat/none")
    expect(source).toContain("latest user message is only an option number like 8")
    expect(source).toContain("The latest user message decides the action for this turn")
    expect(source).toContain("immediately previous turn as the highest-priority context")
    expect(source).toContain("Do not let prior generated images/cards override the latest user intent")
    expect(source).toContain(
      "Normal follow-up generation is chat/none even when recent context contains a visual image/card",
    )
    expect(source).toContain("再多加几道选择题并做成图片")
    expect(source).toContain("preserve the same visual style/layout")
    expect(source).toContain("current uploaded images are present, they are the primary edit target")
    expect(source).toContain("改成gitee风格")
    expect(source).toContain("user-uploaded screenshots/images")
    expect(source).toContain("改好看点")
    expect(source).toContain("给我一张新的")
    expect(source).toContain("software artifact such as a game")
    expect(source).toContain("Sokoban/推箱子")
    expect(source).toContain("download, preview, open, or display an existing image")
    expect(source).toContain("下载图片按钮")
    expect(source).toContain("你觉得图片该怎么生成")
    expect(source).toContain("Current uploaded image count")
    expect(source).toContain("Current uploaded image filenames")
    expect(source).toContain('name: "image_generation"')
    expect(source).toContain("Route to this tool when the user wants to generate a new image")
    expect(source).toContain('"route":"chat|tool"')
    expect(source).toContain('"tool":"image_generation"')
    expect(source).toContain("image_prompt")
    expect(source).toContain("context_text")
    expect(source).toContain('result.action === "none" ? undefined')
  })

  test("caps recent image intent context with a server-side fallback", async () => {
    const source = await Bun.file(new URL("./wanlaicode-user-center.ts", import.meta.url)).text()

    expect(source).toContain("imageIntentContextMaxChars = 32_000")
    expect(source).toContain("text.length <= imageIntentContextMaxChars")
    expect(source).toContain("Middle context omitted for image intent classification")
    expect(source).not.toContain("text.slice(-4000)")
  })
})

describe("image generation model attribution", () => {
  test("records the user-selected model on the user message, routed image model on the assistant message", async () => {
    const source = await Bun.file(
      new URL("../../../../../provider/wanlaicode-image-generation.ts", import.meta.url),
    ).text()

    // 转接只在内部：user message 用用户实际选中的模型（selected_*，回退到 routed），
    // 避免会话「记住所用模型」把选择改写成出图模型。
    expect(source).toContain("input.selected_provider_id || input.provider_id")
    expect(source).toContain("input.selected_model || input.model")
    expect(source).toContain("providerID: selectedProviderID")
    expect(source).toContain("modelID: selectedModelID")
    // assistant message 仍用出图模型做归因（“Build · gpt-image-2”）。
    expect(source).toContain("const modelID = ModelID.make(input.model)")
  })
})
