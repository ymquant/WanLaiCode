import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { WanlaiCodeImageGeneration } from "@/provider/wanlaicode-image-generation"
import { WanlaiCodeRefreshCoordinator } from "@/provider/wanlaicode-refresh-coordinator"
import {
  ImageGenerationPlanAccessError,
  imageGenerationAllowed,
  imageGenerationPurchaseAccess,
  imageGenerationSupportedPlans,
  imageGenerationUpgradePlans,
  isImageGenerationPlanDowngrade,
  selectImageGenerationEntitlement,
} from "@/provider/wanlaicode-image-generation-plan"

const now = Date.parse("2026-07-11T00:00:00Z")

afterEach(() => {
  // 图片服务与其它入口共享进程级协调器，测试间必须清理 shared/invalid/inflight，避免凭据代次串扰。
  WanlaiCodeRefreshCoordinator.resetForTest()
})

function entitlement(input: Record<string, unknown> = {}) {
  return {
    product_code: "wanlaicode",
    status: "active",
    entitlement_kind: "paid",
    // 默认权益放在足够远的未来，避免真实 Date.now() 的 provider 正向回归随日历时间失效。
    expires_at: "2099-08-11T00:00:00Z",
    allow_image_generation: false,
    software_group_id: 1,
    usage: { thirty_day: { limit_tokens: 800_000_000 } },
    ...input,
  }
}

function plan(input: Record<string, unknown> = {}) {
  return {
    id: "plan-max",
    name: "Wanlai-Max",
    price: 398,
    validityDays: 1,
    validityUnit: "month",
    softwareGroupId: 2,
    softwareProductCodes: ["wanlai_code"],
    softwareTokenLimit5h: 90_000_000,
    softwareTokenLimit7d: 1_000_000_000,
    softwareTokenLimit30d: 4_000_000_000,
    tokenPackId: null,
    allowImageGeneration: true,
    ...input,
  }
}

describe("WanlaiCode 生图套餐能力判断", () => {
  test("只选择 WanlaiCode 产品族权益，不回退到其它软件产品", () => {
    const selected = selectImageGenerationEntitlement(
      [
        entitlement({ product_code: "cursor", allow_image_generation: true }),
        entitlement({ product_code: "wanlai_code", expires_at: "2026-06-01T00:00:00Z" }),
        entitlement({ product_code: "wanlai_codex", software_group_id: 2 }),
      ],
      now,
    )

    expect(selected?.product_code).toBe("wanlai_codex")
  })

  test("授权要求产品、active、未过期和严格 boolean true 同时成立", () => {
    expect(imageGenerationAllowed(entitlement({ allow_image_generation: true }), now)).toBe(true)
    expect(imageGenerationAllowed(entitlement({ allow_image_generation: false }), now)).toBe(false)
    expect(imageGenerationAllowed(entitlement({ allow_image_generation: "true" }), now)).toBe(false)
    expect(imageGenerationAllowed(entitlement({ status: "disabled", allow_image_generation: true }), now)).toBe(false)
    expect(
      imageGenerationAllowed(entitlement({ expires_at: "2026-07-10T23:59:59Z", allow_image_generation: true }), now),
    ).toBe(false)
    expect(imageGenerationAllowed(entitlement({ product_code: "cursor", allow_image_generation: true }), now)).toBe(
      false,
    )
    expect(imageGenerationAllowed(undefined, now)).toBe(false)
  })

  test("拒绝错误保留 group_disabled 原文并分别携带支持与升级套餐", () => {
    const error = new ImageGenerationPlanAccessError({
      purchaseUrl: "https://pay.example.com/pay",
      purchaseEnabled: true,
      supportedPlans: [{ id: "plan-c2", name: "c2", price: 99 }],
      upgradePlans: [],
      planCatalogAvailable: true,
    })

    expect(error.message).toBe("Image generation is not enabled for this group")
    expect(error.purchaseUrl).toBe("https://pay.example.com/pay")
    expect(error.purchaseEnabled).toBe(true)
    expect(error.supportedPlans).toEqual([{ id: "plan-c2", name: "c2", price: 99 }])
    expect(error.upgradePlans).toEqual([])
    expect(error.planCatalogAvailable).toBe(true)
  })

  test("购买开关显式关闭时不暴露入口，缺失时按真实 URL 兜底", () => {
    expect(
      imageGenerationPurchaseAccess({
        purchaseSubscriptionEnabled: false,
        purchaseSubscriptionUrl: "https://pay.example.com/pay",
        fallbackPurchaseUrl: "https://fallback.example.com/pay",
      }),
    ).toEqual({ enabled: false, purchaseUrl: "" })
    expect(
      imageGenerationPurchaseAccess({
        fallbackPurchaseUrl: "https://fallback.example.com/pay",
      }),
    ).toEqual({ enabled: true, purchaseUrl: "https://fallback.example.com/pay" })
  })
})

describe("WanlaiCode 生图升级套餐过滤", () => {
  test("支持生图但额度更低的套餐仍用于说明，但不会进入可升级列表", () => {
    const current = entitlement({ usage: { thirty_day: { limit_tokens: 60_000_000 } } })
    const imagePlan = plan({
      id: "c2",
      name: "c2",
      price: 99,
      softwareTokenLimit30d: 700,
    })

    // 支持能力与购买资格必须分开，避免禁止降级规则把真实支持套餐从用户提示中抹掉。
    expect(imageGenerationSupportedPlans([imagePlan])).toEqual([
      { id: "c2", name: "c2", price: 99, validityDays: 1, validityUnit: "month" },
    ])
    expect(imageGenerationUpgradePlans({ plans: [imagePlan], entitlement: current, now })).toEqual([])
  })

  test("只保留明确开通生图、属于 WanlaiCode、非 token 包且非降级的真实套餐", () => {
    const current = entitlement()
    const result = imageGenerationUpgradePlans({
      entitlement: current,
      now,
      plans: [
        plan(),
        plan({ id: "plan-disabled", allowImageGeneration: false }),
        plan({ id: "plan-lower", softwareGroupId: 7, softwareTokenLimit30d: 100_000_000 }),
        plan({ id: "plan-cursor", softwareProductCodes: ["wanlai_cursor"] }),
        plan({ id: "plan-token", tokenPackId: 9 }),
        plan({ id: "plan-incomplete", name: "" }),
      ],
    })

    expect(result).toEqual([{ id: "plan-max", name: "Wanlai-Max", price: 398, validityDays: 1, validityUnit: "month" }])
  })

  test("仅按 30 天额度判档，0 或缺失仍按无限额度最高档处理", () => {
    const current = entitlement({ usage: { thirty_day: { limit_tokens: 0 } } })
    expect(isImageGenerationPlanDowngrade(plan(), current, now)).toBe(true)
    expect(
      isImageGenerationPlanDowngrade(plan({ softwareTokenLimit5h: 1, softwareTokenLimit30d: 0 }), entitlement(), now),
    ).toBe(false)
  })

  test("trial、失效或已过期权益不限制新购套餐", () => {
    const lower = plan({ softwareGroupId: 7, softwareTokenLimit30d: 100_000_000 })
    expect(isImageGenerationPlanDowngrade(lower, entitlement({ entitlement_kind: "trial" }), now)).toBe(false)
    expect(isImageGenerationPlanDowngrade(lower, entitlement({ status: "disabled" }), now)).toBe(false)
    expect(isImageGenerationPlanDowngrade(lower, entitlement({ expires_at: "2026-07-10T23:59:59Z" }), now)).toBe(false)
  })
})

describe("WanlaiCode 生图套餐门禁边界", () => {
  test("OAuth 套餐拒绝时不会读取或创建 API Key，也不会请求图片接口", async () => {
    const previousFetch = globalThis.fetch
    const requests: string[] = []
    let info: Auth.Info = new Auth.Oauth({
      type: "oauth",
      refresh: "refresh-token",
      access: "",
      expires: Math.floor(now / 1000) + 3600,
    })
    const authLayer = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: () => Effect.succeed(info),
        all: () => Effect.succeed({ wanlaicode: info }),
        set: (_key, next) =>
          Effect.sync(() => {
            info = next
          }),
        remove: () => Effect.void,
      }),
    )

    // 模拟 OAuth 刷新、权益和购买开关三条真实边界，并记录是否误触达 Key/图片/套餐接口。
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(url.pathname)
        if (url.pathname === "/v1/oauth/token") {
          return Response.json({ access_token: "oauth-access", refresh_token: "refresh-token", expires_in: 3600 })
        }
        if (url.pathname === "/api/oauth/profile") return Response.json({ account: { uuid: "acct" } })
        if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
          // 生图只需要软件 JWT；无推理权益时协调器仍完成 token 刷新并返回空 runtime key。
          return Response.json({ error: "no_entitlement" }, { status: 403 })
        }
        if (url.pathname === "/api/v1/software/entitlements") {
          return Response.json({ code: 0, data: { items: [entitlement()] } })
        }
        if (url.pathname === "/api/v1/settings/public") {
          return Response.json({
            code: 0,
            data: {
              purchase_subscription_enabled: false,
              purchase_subscription_url: "https://pay.example.com/pay",
            },
          })
        }
        return Response.json({ message: `unexpected request: ${url.pathname}` }, { status: 500 })
      },
      { preconnect: previousFetch.preconnect },
    )

    try {
      const imageLayer = WanlaiCodeImageGeneration.layer.pipe(Layer.provide(authLayer))
      const request = Effect.runPromise(
        WanlaiCodeImageGeneration.Service.use((service) =>
          service.generate({ model: "gpt-image-2", prompt: "生成一张飞鱼图" }),
        ).pipe(Effect.provide(imageLayer)),
      )

      const error = await request.then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(ImageGenerationPlanAccessError)
      if (error instanceof ImageGenerationPlanAccessError) {
        expect(error.message).toBe("Image generation is not enabled for this group")
        expect(error.purchaseEnabled).toBe(false)
        expect(error.purchaseUrl).toBe("")
        expect(error.planCatalogAvailable).toBe(false)
      }
      expect(requests).toContain("/api/v1/software/entitlements")
      expect(requests).toContain("/api/v1/settings/public")
      expect(requests.some((item) => item.includes("/software/api-keys"))).toBe(false)
      expect(requests.some((item) => item.includes("/images/generations") || item.includes("/images/edits"))).toBe(
        false,
      )
      expect(requests.some((item) => item.includes("/api/subscription-plans"))).toBe(false)
      // 生图刷新由协调器原子保存新 JWT 与新 expires，不能再出现旧 softwareToken 搭配新到期时间。
      expect(info).toMatchObject({ type: "oauth", softwareToken: "oauth-access", refresh: "refresh-token" })
      if (info.type === "oauth") expect(info.expires).toBeGreaterThan(Math.floor(Date.now() / 1000))
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("API Key 登录从 profile.entitlement 判定，拒绝后不请求图片接口", async () => {
    const previousFetch = globalThis.fetch
    const requests: string[] = []
    const info = new Auth.Api({ type: "api", key: "software-api-key" })
    const authLayer = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: () => Effect.succeed(info),
        all: () => Effect.succeed({ wanlaicode: info }),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    )

    // API Key 路径只允许 profile 校验；即使 key 本身有效，能力字段为 false 也必须在图片请求前终止。
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(url.pathname)
        if (url.pathname === "/api/wanlaicode_profile") {
          return Response.json({ entitlement: entitlement() })
        }
        if (url.pathname === "/api/v1/settings/public") return Response.json({ message: "暂时不可用" }, { status: 500 })
        return Response.json({ message: `unexpected request: ${url.pathname}` }, { status: 500 })
      },
      { preconnect: previousFetch.preconnect },
    )

    try {
      const imageLayer = WanlaiCodeImageGeneration.layer.pipe(Layer.provide(authLayer))
      const request = Effect.runPromise(
        WanlaiCodeImageGeneration.Service.use((service) =>
          service.generate({ model: "gpt-image-2", prompt: "生成一张飞鱼图" }),
        ).pipe(Effect.provide(imageLayer)),
      )

      const error = await request.then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(ImageGenerationPlanAccessError)
      if (error instanceof ImageGenerationPlanAccessError) {
        expect(error.message).toBe("Image generation is not enabled for this group")
        // 设置接口失败只能标记未知，不能误报为后台明确关闭购买。
        expect(error.purchaseEnabled).toBeUndefined()
        expect(error.planCatalogAvailable).toBe(false)
      }
      expect(requests).toContain("/api/wanlaicode_profile")
      expect(requests.some((item) => item.includes("/images/generations") || item.includes("/images/edits"))).toBe(
        false,
      )
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("OAuth 升级套餐请求沿用登录 token，且 token 不进入拒绝 metadata", async () => {
    const previousFetch = globalThis.fetch
    const requests: URL[] = []
    const info = new Auth.Oauth({
      type: "oauth",
      refresh: "refresh-token",
      access: "",
      expires: Math.floor(now / 1000) + 3600,
    })
    const authLayer = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: () => Effect.succeed(info),
        all: () => Effect.succeed({ wanlaicode: info }),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    )

    // 推荐链与用户中心保持一致：token 只发送给 pay 用于应用账号购买规则，不写入持久化会话数据。
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(url)
        if (url.pathname === "/v1/oauth/token") {
          return Response.json({ access_token: "oauth-access", refresh_token: "refresh-token", expires_in: 3600 })
        }
        if (url.pathname === "/api/oauth/profile") return Response.json({ account: { uuid: "acct" } })
        if (url.pathname === "/api/oauth/wanlaicode/create_api_key") {
          // 套餐推荐沿用刷新后的 JWT，runtime key 缺失不应阻断购买链。
          return Response.json({ error: "no_entitlement" }, { status: 403 })
        }
        if (url.pathname === "/api/v1/software/entitlements") {
          return Response.json({ code: 0, data: { items: [entitlement()] } })
        }
        if (url.pathname === "/api/v1/settings/public") {
          return Response.json({
            code: 0,
            data: {
              purchase_subscription_enabled: true,
              purchase_subscription_url: "https://pay.example.com/pay",
            },
          })
        }
        if (url.pathname === "/api/subscription-plans") return Response.json({ plans: [plan()] })
        return Response.json({ message: `unexpected request: ${url.pathname}` }, { status: 500 })
      },
      { preconnect: previousFetch.preconnect },
    )

    try {
      const imageLayer = WanlaiCodeImageGeneration.layer.pipe(Layer.provide(authLayer))
      const error = await Effect.runPromise(
        WanlaiCodeImageGeneration.Service.use((service) =>
          service.generate({ model: "gpt-image-2", prompt: "生成一张飞鱼图" }),
        ).pipe(Effect.provide(imageLayer)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      )

      expect(error).toBeInstanceOf(ImageGenerationPlanAccessError)
      if (!(error instanceof ImageGenerationPlanAccessError)) return
      expect(requests.find((url) => url.pathname === "/api/subscription-plans")?.searchParams.get("token")).toBe(
        "oauth-access",
      )
      expect(error.supportedPlans).toEqual([
        { id: "plan-max", name: "Wanlai-Max", price: 398, validityDays: 1, validityUnit: "month" },
      ])
      expect(error.upgradePlans).toEqual([
        { id: "plan-max", name: "Wanlai-Max", price: 398, validityDays: 1, validityUnit: "month" },
      ])
      expect(error.planCatalogAvailable).toBe(true)
      expect(error.purchaseEnabled).toBe(true)
      expect(JSON.stringify(error)).not.toContain("oauth-access")
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("套餐目录返回 500 时保留购买入口并标记目录不可用", async () => {
    const previousFetch = globalThis.fetch
    const info = new Auth.Api({ type: "api", key: "software-api-key" })
    const authLayer = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: () => Effect.succeed(info),
        all: () => Effect.succeed({ wanlaicode: info }),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    )

    // 购买服务异常只影响套餐名称，不应把已经由主站确认的购买地址一并清空。
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/api/wanlaicode_profile") return Response.json({ entitlement: entitlement() })
        if (url.pathname === "/api/v1/settings/public") {
          return Response.json({
            code: 0,
            data: {
              purchase_subscription_enabled: true,
              purchase_subscription_url: "https://pay.example.com/pay",
            },
          })
        }
        if (url.pathname === "/api/subscription-plans") {
          return Response.json({ error: "获取订阅套餐失败" }, { status: 500 })
        }
        return Response.json({ message: `unexpected request: ${url.pathname}` }, { status: 500 })
      },
      { preconnect: previousFetch.preconnect },
    )

    try {
      const imageLayer = WanlaiCodeImageGeneration.layer.pipe(Layer.provide(authLayer))
      const error = await Effect.runPromise(
        WanlaiCodeImageGeneration.Service.use((service) =>
          service.generate({ model: "gpt-image-2", prompt: "生成一张飞鱼图" }),
        ).pipe(Effect.provide(imageLayer)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      )

      expect(error).toBeInstanceOf(ImageGenerationPlanAccessError)
      if (!(error instanceof ImageGenerationPlanAccessError)) return
      expect(error.purchaseUrl).toBe("https://pay.example.com/pay")
      expect(error.supportedPlans).toEqual([])
      expect(error.upgradePlans).toEqual([])
      expect(error.planCatalogAvailable).toBe(false)
      expect(error.purchaseEnabled).toBe(true)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("升级推荐接口挂起时按时返回套餐拒绝而不触达图片端点", async () => {
    const previousFetch = globalThis.fetch
    const requests: string[] = []
    const info = new Auth.Api({ type: "api", key: "software-api-key" })
    const authLayer = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: () => Effect.succeed(info),
        all: () => Effect.succeed({ wanlaicode: info }),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    )

    // 推荐属于附加信息：即使 pay 无响应，也必须在短超时后返回明确拒绝，不能让会话长期保持 busy。
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(url.pathname)
        if (url.pathname === "/api/wanlaicode_profile") return Response.json({ entitlement: entitlement() })
        if (url.pathname === "/api/v1/settings/public") {
          return Response.json({
            code: 0,
            data: {
              purchase_subscription_enabled: true,
              purchase_subscription_url: "https://pay.example.com/pay",
            },
          })
        }
        if (url.pathname === "/api/subscription-plans") return await new Promise<Response>(() => {})
        return Response.json({ message: `unexpected request: ${url.pathname}` }, { status: 500 })
      },
      { preconnect: previousFetch.preconnect },
    )

    try {
      const imageLayer = WanlaiCodeImageGeneration.layer.pipe(Layer.provide(authLayer))
      const startedAt = Date.now()
      const error = await Effect.runPromise(
        WanlaiCodeImageGeneration.Service.use((service) =>
          service.generate({ model: "gpt-image-2", prompt: "生成一张飞鱼图" }),
        ).pipe(Effect.provide(imageLayer)),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      )

      expect(error).toBeInstanceOf(ImageGenerationPlanAccessError)
      if (!(error instanceof ImageGenerationPlanAccessError)) return
      expect(Date.now() - startedAt).toBeLessThan(4_000)
      expect(error.supportedPlans).toEqual([])
      expect(error.upgradePlans).toEqual([])
      expect(error.purchaseUrl).toBe("https://pay.example.com/pay")
      expect(error.planCatalogAvailable).toBe(false)
      expect(error.purchaseEnabled).toBe(true)
      expect(requests).toContain("/api/subscription-plans")
      expect(requests.some((item) => item.includes("/images/"))).toBe(false)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("已开启生图能力的 API Key 套餐继续调用原图片接口", async () => {
    const previousFetch = globalThis.fetch
    const requests: string[] = []
    const info = new Auth.Api({ type: "api", key: "software-api-key" })
    const authLayer = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: () => Effect.succeed(info),
        all: () => Effect.succeed({ wanlaicode: info }),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    )

    // 正向路径只新增权益校验；通过后仍使用原 API Key、原生成端点和原图片响应结构。
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(url.pathname)
        if (url.pathname === "/api/wanlaicode_profile") {
          return Response.json({ entitlement: entitlement({ allow_image_generation: true }) })
        }
        if (url.pathname === "/v1/images/generations") {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer software-api-key")
          return Response.json({ data: [{ b64_json: "generated-image" }] })
        }
        return Response.json({ message: `unexpected request: ${url.pathname}` }, { status: 500 })
      },
      { preconnect: previousFetch.preconnect },
    )

    try {
      const imageLayer = WanlaiCodeImageGeneration.layer.pipe(Layer.provide(authLayer))
      const result = await Effect.runPromise(
        WanlaiCodeImageGeneration.Service.use((service) =>
          service.generate({ model: "gpt-image-2", prompt: "生成一张飞鱼图" }),
        ).pipe(Effect.provide(imageLayer)),
      )

      expect(result.images.map((image) => image.url)).toEqual(["data:image/png;base64,generated-image"])
      expect(requests.filter((item) => item === "/api/wanlaicode_profile")).toHaveLength(1)
      expect(requests.filter((item) => item === "/v1/images/generations")).toHaveLength(1)
      expect(requests).not.toContain("/api/v1/settings/public")
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
