import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { Auth } from "@/auth"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"
import { WanlaiCodeCredentialState } from "@/provider/wanlaicode-credential-state"

// 刷新工作流会分两阶段读写 Auth；测试状态必须像真实 auth.json 一样让后续 get 看见上一轮 set。
function authState(initial?: Auth.Info, onSet?: () => void) {
  let current = initial
  const saved: Array<{ key: string; info: Auth.Info }> = []
  return {
    layer: Layer.mock(Auth.Service)({
      get: () => Effect.succeed(current),
      set: (key, info) =>
        Effect.sync(() => {
          current = info
          saved.push({ key, info })
          onSet?.()
        }),
      modify: (key, update) =>
        Effect.sync(() => {
          // 测试状态与正式 auth.json 锁内 CAS 保持一致：拒绝时不写入，成功时立即成为后续 get 的权威值。
          const next = update(current)
          if (!next) return undefined
          current = next
          saved.push({ key, info: next })
          onSet?.()
          return next
        }),
    }),
    saved,
    current: () => current,
    replace: (info: Auth.Info) => {
      current = info
    },
  }
}

// 默认配置固定使用线上服务，本地联调只通过 WANLAICODE_* 环境变量显式覆盖。
describe("WanlaiCode auth configuration", () => {
  test("keeps brand defaults unless local endpoints are explicitly provided", () => {
    expect(WanlaiCodeAuth.endpointDefaults({})).toMatchObject({
      apiBase: "https://api.wanlai.ai/v1",
      siteUrl: "https://wanlai.ai",
    })
    expect(
      WanlaiCodeAuth.endpointDefaults({
        WANLAICODE_API_BASE: " http://127.0.0.1:8080/v1 ",
        WANLAICODE_SITE_URL: " http://127.0.0.1:3001 ",
      }),
    ).toEqual({
      apiBase: "http://127.0.0.1:8080/v1",
      siteUrl: "http://127.0.0.1:3001",
    })
  })

  test("发布默认配置不指向本机并使用线上默认模型", () => {
    // 线上构建未注入联调环境变量时，认证、推理和购买都不能退回 localhost。
    expect(WanlaiCodeAuth.defaultConfig.apiBase).not.toMatch(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/)
    expect(WanlaiCodeAuth.defaultConfig.siteUrl).not.toMatch(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/)
    expect(WanlaiCodeAuth.defaultConfig.purchaseUrl).not.toMatch(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/)
    expect(WanlaiCodeAuth.defaultConfig.purchaseFallbackUrl).not.toMatch(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/)
    expect(WanlaiCodeAuth.defaultConfig.model).toBe("deepseek-v4-flash")
  })

  test("normalizes apiBase and derives relayRoot", () => {
    const config = WanlaiCodeAuth.resolveConfig({ apiBase: "https://api.wanlai.ai" })

    expect(config.apiBase).toBe("https://api.wanlai.ai/v1")
    expect(config.relayRoot).toBe("https://api.wanlai.ai")
  })

  test("keeps apiBase on inference endpoints and uses relayRoot for account endpoints", () => {
    const config = WanlaiCodeAuth.resolveConfig({ apiBase: "https://api.wanlai.ai/v1/" })

    expect(config.endpoints.models).toBe("https://api.wanlai.ai/v1/models")
    expect(config.endpoints.chatCompletions).toBe("https://api.wanlai.ai/v1/chat/completions")
    expect(config.endpoints.apiKeyProfile).toBe("https://api.wanlai.ai/api/wanlaicode_profile")
    expect(config.endpoints.oauthProfile).toBe("https://api.wanlai.ai/api/oauth/profile")
    expect(config.endpoints.createRuntimeKey).toBe("https://api.wanlai.ai/api/oauth/wanlaicode/create_api_key")
    expect(config.endpoints.purchaseSettings).toBe("https://api.wanlai.ai/api/v1/settings/public")
    expect(config.endpoints.oauthToken).toBe("https://api.wanlai.ai/v1/oauth/token")
    expect(config.purchaseUrl).toBe(WanlaiCodeAuth.defaultConfig.purchaseUrl)
  })

  test("uses JWT exp or a safe default when expires_in is missing", () => {
    const now = 1_700_000_000_000
    const jwtExpires = Math.floor(now / 1000) + 1800
    const payload = Buffer.from(JSON.stringify({ exp: jwtExpires })).toString("base64url")
    const expiredPayload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) - 60 })).toString("base64url")

    // JWT exp 是服务端签名的绝对时间；opaque token 无法解析时统一回退一小时，不能保存为 0。
    expect(WanlaiCodeAuth.oauthTokenExpiresAt({ accessToken: `header.${payload}.signature`, now })).toBe(jwtExpires)
    expect(WanlaiCodeAuth.oauthTokenExpiresAt({ accessToken: `header.${expiredPayload}.signature`, now })).toBe(
      Math.floor(now / 1000) - 60,
    )
    expect(WanlaiCodeAuth.oauthTokenExpiresAt({ accessToken: "opaque", now })).toBe(Math.floor(now / 1000) + 3600)
  })

  test("builds OAuth authorize URL with required WanlaiCode parameters", () => {
    const url = WanlaiCodeAuth.buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:39876/callback",
      state: "0123456789abcdef0123456789abcdef",
      codeChallenge: "challenge-value",
    })

    expect(url.origin).toBe(new URL(WanlaiCodeAuth.defaultConfig.siteUrl).origin)
    expect(url.pathname).toBe("/software/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("wanlaicode-cli")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:39876/callback")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("state")).toBe("0123456789abcdef0123456789abcdef")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("scope")).toBe("user:profile user:inference")
  })

  test("creates OAuth PKCE start data", async () => {
    const start = await WanlaiCodeAuth.startOAuth({ redirectUri: "http://127.0.0.1:39876/callback" })

    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
    expect(start.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(start.url!.searchParams.get("state")).toBe(start.state)
    expect(start.url!.searchParams.get("code_challenge")).toBe(start.codeChallenge)
    expect(start.url!.searchParams.get("code_challenge_method")).toBe("S256")
  })

  test("uses dedicated WanlaiCode transport for oauth token exchange", async () => {
    const requests: Array<{ path: string; method: string | undefined }> = []
    const originalFetch = globalThis.fetch
    const originalPreconnect = originalFetch.preconnect
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("global fetch should not be used")
      },
      { preconnect: async (...args: Parameters<typeof originalPreconnect>) => originalPreconnect(...args) },
    )

    try {
      const tokens = await Effect.runPromise(
        WanlaiCodeAuth.exchangeOAuthCode({
          apiBase: "https://api.example.com/v1",
          code: "code_123",
          redirectUri: "http://127.0.0.1:39876/callback",
          codeVerifier: "verifier_123",
          fetch: async (input, init) => {
            requests.push({ path: new URL(input.toString()).pathname, method: init?.method })
            return Response.json({ access_token: "access_123", refresh_token: "refresh_123", expires_in: 3600 })
          },
        }),
      )

      expect(requests).toEqual([{ path: "/v1/oauth/token", method: "POST" }])
      expect(tokens.access_token).toBe("access_123")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uses dedicated WanlaiCode transport for purchase settings", async () => {
    const requests: Array<{ path: string; method: string | undefined }> = []
    const originalFetch = globalThis.fetch
    const originalPreconnect = originalFetch.preconnect
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("global fetch should not be used")
      },
      { preconnect: async (...args: Parameters<typeof originalPreconnect>) => originalPreconnect(...args) },
    )

    try {
      const purchaseUrl = await Effect.runPromise(
        WanlaiCodeAuth.getPurchaseUrl({
          apiBase: "https://api.example.com/v1",
          now: () => 1,
          fetch: async (input, init) => {
            requests.push({ path: new URL(input.toString()).pathname, method: init?.method })
            return Response.json({ data: { purchase_subscription_url: "https://pay.example.com/pay" } })
          },
        }),
      )

      expect(requests).toEqual([{ path: "/api/v1/settings/public", method: undefined }])
      expect(purchaseUrl).toBe("https://pay.example.com/pay")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("derives PKCE challenge from verifier", async () => {
    const codeChallenge = await WanlaiCodeAuth.createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")

    expect(codeChallenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  test("waits for OAuth callback code with matching state", async () => {
    const callback = await WanlaiCodeAuth.createOAuthCallback({ state: "state_123", timeoutMs: 500 })

    try {
      const code = callback.wait()
      const response = await fetch(`${callback.redirectUri}?code=code_123&state=state_123`)

      expect(response.status).toBe(200)
      await expect(code).resolves.toBe("code_123")
    } finally {
      callback.stop()
    }
  })

  test("rejects OAuth callback without code", async () => {
    const callback = await WanlaiCodeAuth.createOAuthCallback({ state: "state_123", timeoutMs: 500 })

    try {
      const waitPromise = callback.wait()
      const rejectionPromise = new Promise<Error>((resolve) => {
        waitPromise.catch(resolve)
      })
      const response = await fetch(`${callback.redirectUri}?state=state_123`)
      expect(response.status).toBe(400)
      const error = await rejectionPromise
      expect(error.message).toBe("Missing authorization code")
    } finally {
      callback.stop()
    }
  })

  test("rejects OAuth callback with mismatched state", async () => {
    const callback = await WanlaiCodeAuth.createOAuthCallback({ state: "state_123", timeoutMs: 500 })

    try {
      const waitPromise = callback.wait()
      const rejectionPromise = new Promise<Error>((resolve) => {
        waitPromise.catch(resolve)
      })
      const response = await fetch(`${callback.redirectUri}?code=code_123&state=state_bad`)
      expect(response.status).toBe(400)
      const error = await rejectionPromise
      expect(error.message).toBe("Invalid OAuth state")
    } finally {
      callback.stop()
    }
  })

  test("rejects OAuth callback on timeout", async () => {
    const callback = await WanlaiCodeAuth.createOAuthCallback({ state: "state_123", timeoutMs: 10 })

    try {
      await expect(callback.wait()).rejects.toThrow("OAuth callback timeout")
    } finally {
      callback.stop()
    }
  })

  test("exchanges OAuth authorization code for tokens", async () => {
    const requests: Array<{ path: string; method: string | undefined; contentType: string | null; body: unknown }> = []
    const tokens = await Effect.runPromise(
      WanlaiCodeAuth.exchangeOAuthCode({
        apiBase: "https://api.example.com/v1",
        code: "code_123",
        redirectUri: "http://127.0.0.1:39876/callback",
        codeVerifier: "verifier_123",
        fetch: async (input, init) => {
          requests.push({
            path: new URL(input.toString()).pathname,
            method: init?.method,
            contentType: new Headers(init?.headers).get("content-type"),
            body: JSON.parse(init?.body?.toString() ?? "{}"),
          })
          return Response.json({ access_token: "access_123", refresh_token: "refresh_123", expires_in: 3600 })
        },
      }),
    )

    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe("/v1/oauth/token")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].contentType).toBe("application/json")
    expect(requests[0].body).toEqual({
      grant_type: "authorization_code",
      client_id: "wanlaicode-cli",
      code: "code_123",
      redirect_uri: "http://127.0.0.1:39876/callback",
      code_verifier: "verifier_123",
    })
    expect(tokens).toEqual({ access_token: "access_123", refresh_token: "refresh_123", expires_in: 3600 })
  })

  test("classifies refresh-token invalid response by structured error code", async () => {
    let thrown: unknown
    try {
      await Effect.runPromise(
        WanlaiCodeAuth.refreshOAuthToken({
          refreshToken: "refresh_123",
          apiBase: "https://api.example.com/v1",
          fetch: async () =>
            Response.json(
              {
                error: "software_oauth_refresh_token_invalid",
                message: "localized message should not drive classification",
              },
              { status: 401 },
            ),
        }),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WanlaiCodeAuth.OAuthRefreshError)
    expect(WanlaiCodeAuth.isOAuthRefreshTokenInvalid(thrown)).toBe(true)
    expect((thrown as WanlaiCodeAuth.OAuthRefreshError).reason).toBe("software_oauth_refresh_token_invalid")
  })

  test("classifies authorization-expired refresh response by structured reason", async () => {
    let thrown: unknown
    try {
      await Effect.runPromise(
        WanlaiCodeAuth.refreshOAuthToken({
          refreshToken: "refresh_123",
          apiBase: "https://api.example.com/v1",
          fetch: async () =>
            Response.json(
              {
                reason: "SOFTWARE_OAUTH_AUTHORIZATION_EXPIRED",
                message: "localized message should not drive classification",
              },
              { status: 401 },
            ),
        }),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WanlaiCodeAuth.OAuthRefreshError)
    expect(WanlaiCodeAuth.isOAuthRefreshTokenInvalid(thrown)).toBe(true)
  })

  test("does not classify unrelated 401 refresh failures as login expired", () => {
    expect(
      WanlaiCodeAuth.isOAuthRefreshTokenInvalid(
        new WanlaiCodeAuth.OAuthRefreshError({
          status: 401,
          reason: "SOFTWARE_OAUTH_MISSING_AUTHORIZATION",
          body: JSON.stringify({ error: "software_oauth_missing_authorization" }),
        }),
      ),
    ).toBe(false)
  })

  test("validates OAuth profile with bearer access token", async () => {
    const requests: Array<{ path: string; authorization: string | null }> = []
    const profile = await Effect.runPromise(
      WanlaiCodeAuth.validateOAuthProfile({
        accessToken: "access_123",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          requests.push({
            path: new URL(input.toString()).pathname,
            authorization: new Headers(init?.headers).get("authorization"),
          })
          return Response.json({
            entitlement: { plan: "pro" },
            account: { uuid: "acct_123", email: "user@example.com" },
          })
        },
      }),
    )

    expect(requests).toEqual([{ path: "/api/oauth/profile", authorization: "Bearer access_123" }])
    expect(profile.entitlement).toEqual({ plan: "pro" })
    expect(profile.account?.email).toBe("user@example.com")
  })

  test("accepts OAuth profile responses without entitlement", async () => {
    const profile = await Effect.runPromise(
      WanlaiCodeAuth.validateOAuthProfile({
        accessToken: "access_123",
        apiBase: "https://api.example.com/v1",
        fetch: async () => Response.json({ account: { uuid: "acct_123" } }),
      }),
    )

    expect(profile.entitlement).toBeUndefined()
    expect(profile.account?.uuid).toBe("acct_123")
  })

  test("creates OAuth runtime key with bearer access token", async () => {
    const requests: Array<{ path: string; method: string | undefined; authorization: string | null }> = []
    const runtimeKey = await Effect.runPromise(
      WanlaiCodeAuth.createRuntimeKey({
        accessToken: "access_123",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          requests.push({
            path: new URL(input.toString()).pathname,
            method: init?.method,
            authorization: new Headers(init?.headers).get("authorization"),
          })
          return Response.json({ raw_key: "runtime_key_123" })
        },
      }),
    )

    expect(requests).toEqual([
      { path: "/api/oauth/wanlaicode/create_api_key", method: "POST", authorization: "Bearer access_123" },
    ])
    expect(runtimeKey).toBe("runtime_key_123")
  })

  test("rejects OAuth runtime key responses without raw_key", async () => {
    await expect(
      Effect.runPromise(
        WanlaiCodeAuth.createRuntimeKey({
          accessToken: "access_123",
          apiBase: "https://api.example.com/v1",
          fetch: async () => Response.json({}),
        }),
      ),
    ).rejects.toThrow("WanlaiCode OAuth runtime key response does not include raw_key")
  })

  test("detects no entitlement runtime key failures", () => {
    expect(
      WanlaiCodeAuth.isNoEntitlementError(
        new Error('WanlaiCode OAuth runtime key request failed: 403 Forbidden - {"error":"no_entitlement"}'),
      ),
    ).toBe(true)
    expect(
      WanlaiCodeAuth.isNoEntitlementError(
        new Error(
          'WanlaiCode OAuth runtime key request failed: 403 Forbidden - {"error":"software_product_not_entitled","message":"user does not have this software product"}',
        ),
      ),
    ).toBe(true)
    expect(WanlaiCodeAuth.isNoEntitlementError(new Error("WanlaiCode OAuth runtime key request failed: 500"))).toBe(
      false,
    )
  })

  test("uses an empty runtime key when runtime key is blocked by missing entitlement", async () => {
    const runtimeKey = await Effect.runPromise(
      WanlaiCodeAuth.createRuntimeKeyOrEmpty({
        accessToken: "access_123",
        apiBase: "https://api.example.com/v1",
        fetch: async () =>
          Response.json(
            {
              error: "software_product_not_entitled",
              message: "user does not have this software product",
            },
            { status: 403 },
          ),
      }),
    )

    expect(runtimeKey).toBe("")
  })

  test("validates API key profile with x-api-key header", async () => {
    const requests: Array<{ path: string; apiKey: string | null }> = []
    const profile = await Effect.runPromise(
      WanlaiCodeAuth.validateApiKey({
        apiKey: "test-api-key",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          requests.push({
            path: new URL(input.toString()).pathname,
            apiKey: new Headers(init?.headers).get("x-api-key"),
          })
          return Response.json({
            entitlement: { plan: "pro" },
            account: { uuid: "acct_123", email: "user@example.com" },
          })
        },
      }),
    )

    expect(requests).toEqual([{ path: "/api/wanlaicode_profile", apiKey: "test-api-key" }])
    expect(profile.entitlement).toEqual({ plan: "pro" })
    expect(profile.account?.uuid).toBe("acct_123")
  })

  test("accepts API key profile responses without entitlement", async () => {
    const profile = await Effect.runPromise(
      WanlaiCodeAuth.validateApiKey({
        apiKey: "test-api-key",
        apiBase: "https://api.example.com/v1",
        fetch: async () => Response.json({ account: { uuid: "acct_123" } }),
      }),
    )

    expect(profile.entitlement).toBeUndefined()
    expect(profile.account?.uuid).toBe("acct_123")
  })

  test("rejects API key profile HTTP failures", async () => {
    await expect(
      Effect.runPromise(
        WanlaiCodeAuth.validateApiKey({
          apiKey: "test-api-key",
          apiBase: "https://api.example.com/v1",
          fetch: async () => Response.json({ error: "invalid key" }, { status: 401 }),
        }),
      ),
    ).rejects.toThrow("WanlaiCode API key profile request failed: 401")
  })

  test("loginWithApiKey stores validated key in service-side auth", async () => {
    const saved: Array<{ key: string; info: Auth.Info }> = []
    const auth = Layer.mock(Auth.Service)({
      set: (key, info) => Effect.sync(() => saved.push({ key, info })),
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    const profile = await Effect.runPromise(
      WanlaiCodeAuth.loginWithApiKey({
        apiKey: "test-api-key",
        apiBase: "https://api.example.com/v1",
        fetch: async () => Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123" } }),
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(profile.entitlement).toEqual({ plan: "pro" })
    expect(saved).toEqual([
      {
        key: "wanlaicode",
        info: { type: "api", key: "test-api-key", metadata: { apiBase: "https://api.example.com/v1" } },
      },
    ])
  })

  test("loginWithApiKey refreshes model state after saving auth", async () => {
    const operations: string[] = []
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.sync(() => operations.push("auth.set")),
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: (force) => Effect.sync(() => operations.push(`models.refresh:${String(force)}`)),
      refreshWanlaiCode: () => Effect.sync(() => operations.push("models.refreshWanlaiCode")),
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.sync(() => operations.push("provider.refresh")),
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithApiKey({
        apiKey: "test-api-key",
        apiBase: "https://api.example.com/v1",
        fetch: async () => Response.json({ entitlement: { plan: "pro" } }),
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(operations).toEqual(["auth.set", "provider.refresh", "models.refreshWanlaiCode", "provider.refresh"])
  })

  test("loginWithEmailPassword posts email/password to Wanlai auth login endpoint", async () => {
    const requests: Array<{ path: string; method: string | undefined; contentType: string | null; body: unknown }> = []
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.void,
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithEmailPassword({
        email: "user@example.com",
        password: "secret-password",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          const path = new URL(input.toString()).pathname
          if (path === "/api/v1/auth/login") {
            requests.push({
              path,
              method: init?.method,
              contentType: new Headers(init?.headers).get("content-type"),
              body: JSON.parse(init?.body?.toString() ?? "{}"),
            })
            return Response.json({ code: 0, data: { access_token: "jwt_123" } })
          }
          if (path === "/api/v1/software/api-keys/current") {
            return Response.json({ code: 0, data: { raw_key: "sk_test_123" } })
          }
          return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123", email: "user@example.com" } })
        },
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(requests).toEqual([
      {
        path: "/api/v1/auth/login",
        method: "POST",
        contentType: "application/json",
        body: {
          email: "user@example.com",
          password: "secret-password",
        },
      },
    ])
  })

  test("loginWithEmailPassword exchanges user JWT for software api key and stores api session", async () => {
    const saved: Array<{ key: string; info: Auth.Info }> = []
    const apiKeyRequests: Array<{ path: string; authorization: string | null }> = []
    const auth = Layer.mock(Auth.Service)({
      set: (key, info) => Effect.sync(() => saved.push({ key, info })),
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithEmailPassword({
        email: "user@example.com",
        password: "secret-password",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          const path = new URL(input.toString()).pathname
          if (path === "/api/v1/auth/login") {
            return Response.json({ code: 0, data: { access_token: "jwt_123" } })
          }
          if (path === "/api/v1/software/api-keys/current") {
            apiKeyRequests.push({ path, authorization: new Headers(init?.headers).get("authorization") })
            return Response.json({ code: 0, data: { raw_key: "sk_test_123" } })
          }
          return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123", email: "user@example.com" } })
        },
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(apiKeyRequests).toEqual([{ path: "/api/v1/software/api-keys/current", authorization: "Bearer jwt_123" }])
    expect(saved).toEqual([
      {
        key: "wanlaicode",
        info: {
          type: "api",
          key: "sk_test_123",
          accountEmail: "user@example.com",
          accountName: "user",
          metadata: { apiBase: "https://api.example.com/v1" },
        },
      },
    ])
  })

  test("loginWithEmailPassword creates a software api key when none exists", async () => {
    const created: Array<{ path: string; method: string | undefined; body: unknown }> = []
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.void,
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithEmailPassword({
        email: "user@example.com",
        password: "secret-password",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          const path = new URL(input.toString()).pathname
          if (path === "/api/v1/auth/login") {
            return Response.json({ code: 0, data: { access_token: "jwt_123" } })
          }
          if (path === "/api/v1/software/api-keys/current") {
            return Response.json({ code: 404, message: "not found" }, { status: 404 })
          }
          if (path === "/api/v1/software/api-keys") {
            created.push({ path, method: init?.method, body: JSON.parse(init?.body?.toString() ?? "{}") })
            return Response.json({ code: 0, data: { raw_key: "sk_created_123" } })
          }
          return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123", email: "user@example.com" } })
        },
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(created).toEqual([
      {
        path: "/api/v1/software/api-keys",
        method: "POST",
        body: { product_code: "wanlaicode", replace_existing: false },
      },
    ])
  })

  test("loginWithEmailPassword falls through to create key on HTTP 200 + code 404 (no key yet)", async () => {
    const created: Array<{ path: string }> = []
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.void,
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithEmailPassword({
        email: "user@example.com",
        password: "secret-password",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          const path = new URL(input.toString()).pathname
          if (path === "/api/v1/auth/login") {
            return Response.json({ code: 0, data: { access_token: "jwt_123" } })
          }
          if (path === "/api/v1/software/api-keys/current") {
            // 后端以HTTP 200 + code 404 表示没有key——需要映射到创建兜底
            return Response.json({ code: 404, message: "no software api key" })
          }
          if (path === "/api/v1/software/api-keys") {
            created.push({ path })
            return Response.json({ code: 0, data: { raw_key: "sk_created_123" } })
          }
          return Response.json({ entitlement: { plan: "pro" }, account: { uuid: "acct_123", email: "user@example.com" } })
        },
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(created).toEqual([{ path: "/api/v1/software/api-keys" }])
  })

  test("loginWithOAuth stores OAuth session in service-side auth", async () => {
    const saved: Array<{ key: string; info: Auth.Info }> = []
    const auth = Layer.mock(Auth.Service)({
      set: (key, info) => Effect.sync(() => saved.push({ key, info })),
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithOAuth({
        accessToken: "access_123",
        refreshToken: "refresh_123",
        expiresIn: 3600,
        profile: {
          entitlement: { plan: "pro" },
          account: { uuid: "acct_123", email: "user@example.com" },
        },
        runtimeKey: "runtime_key_123",
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(saved).toEqual([
      {
        key: "wanlaicode",
        info: {
          type: "oauth",
          access: "runtime_key_123",
          softwareToken: "access_123",
          refresh: "refresh_123",
          expires: expect.any(Number),
          accountId: "acct_123",
          accountEmail: "user@example.com",
          accountName: "user",
          enterpriseUrl: WanlaiCodeAuth.defaultConfig.siteUrl,
        },
      },
    ])
  })

  test("loginWithOAuth clears an invalid marker when callback reuses the same credential revision", async () => {
    const state = authState()
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })
    const expires = Math.floor(Date.now() / 1000) + 3600
    const payload = Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")
    const input = {
      accessToken: `header.${payload}.signature`,
      refreshToken: "refresh-reused",
      expiresIn: 0,
      profile: { account: { uuid: "acct_123" } },
      runtimeKey: "runtime-key",
    }

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithOAuth(input).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )
    const first = state.current()
    if (first?.type !== "oauth") throw new Error("测试登录未保存 OAuth 凭据")
    WanlaiCodeCredentialState.markCredentialInvalid(first)
    expect(WanlaiCodeCredentialState.isCredentialInvalid(first)).toBe(true)

    // 服务端可能复用完全相同的三元组；用户刚完成 callback 时仍必须显式恢复该代次。
    await Effect.runPromise(
      WanlaiCodeAuth.loginWithOAuth(input).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )
    const current = state.current()
    if (current?.type !== "oauth") throw new Error("测试重新登录未保存 OAuth 凭据")
    expect(WanlaiCodeCredentialState.credentialRevision(current)).toBe(
      WanlaiCodeCredentialState.credentialRevision(first),
    )
    expect(WanlaiCodeCredentialState.isCredentialInvalid(current)).toBe(false)
  })

  test("loginWithOAuth refreshes model state after saving auth", async () => {
    const operations: string[] = []
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.sync(() => operations.push("auth.set")),
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: (force) => Effect.sync(() => operations.push(`models.refresh:${String(force)}`)),
      refreshWanlaiCode: () => Effect.sync(() => operations.push("models.refreshWanlaiCode")),
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.sync(() => operations.push("provider.refresh")),
    })

    await Effect.runPromise(
      WanlaiCodeAuth.loginWithOAuth({
        accessToken: "access_123",
        refreshToken: "refresh_123",
        expiresIn: 3600,
        profile: {
          entitlement: { plan: "pro" },
          account: { uuid: "acct_123", email: "user@example.com" },
        },
        runtimeKey: "runtime_key_123",
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(operations).toEqual(["auth.set", "provider.refresh", "models.refreshWanlaiCode", "provider.refresh"])
  })

  test("refreshOAuthSession exchanges refresh token, recreates runtime key and saves auth", async () => {
    const requests: Array<
      | { path: string; method: string | undefined; contentType: string | null; body: unknown }
      | { path: string; method: string | undefined; authorization: string | null }
    > = []
    const state = authState()
    const saved = state.saved
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.refreshOAuthSession({
        refreshToken: "refresh_123",
        accountUuid: "acct_123",
        siteUrl: "https://wanlai.ai",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          const path = new URL(input.toString()).pathname
          if (path === "/v1/oauth/token") {
            requests.push({
              path,
              method: init?.method,
              contentType: new Headers(init?.headers).get("content-type"),
              body: JSON.parse(init?.body?.toString() ?? "{}"),
            })
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (path === "/api/oauth/profile") {
            requests.push({
              path,
              method: init?.method,
              authorization: new Headers(init?.headers).get("authorization"),
            })
            return Response.json({
              entitlement: { plan: "pro" },
              account: { uuid: "acct_123", email: "user@example.com" },
            })
          }
          requests.push({
            path,
            method: init?.method,
            authorization: new Headers(init?.headers).get("authorization"),
          })
          return Response.json({ raw_key: "runtime_key_456" })
        },
      }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )

    expect(requests).toEqual([
      {
        path: "/v1/oauth/token",
        method: "POST",
        contentType: "application/json",
        body: expect.any(Object),
      },
      {
        path: "/api/oauth/profile",
        method: undefined,
        authorization: "Bearer access_456",
      },
      {
        path: "/api/oauth/wanlaicode/create_api_key",
        method: "POST",
        authorization: "Bearer access_456",
      },
    ])
    expect((requests[0] as { body: unknown }).body).toEqual({
      grant_type: "refresh_token",
      client_id: "wanlaicode-cli",
      refresh_token: "refresh_123",
      scope: "user:profile user:inference",
    })
    expect(saved).toHaveLength(2)
    // 第一次写入必须发生在 profile/runtime key 请求前，并保留完整轮换三元组。
    expect(saved[0]).toMatchObject({
      key: "wanlaicode",
      info: {
        type: "oauth",
        access: "",
        softwareToken: "access_456",
        refresh: "refresh_456",
        expires: expect.any(Number),
      },
    })
    expect(saved[1]).toEqual({
      key: "wanlaicode",
      info: {
        type: "oauth",
        access: "runtime_key_456",
        softwareToken: "access_456",
        refresh: "refresh_456",
        expires: expect.any(Number),
        accountId: "acct_123",
        accountEmail: "user@example.com",
        accountName: "user",
        enterpriseUrl: "https://wanlai.ai",
      },
    })
  })

  test("refreshOAuthSession keeps rotated tokens when profile completion fails", async () => {
    const existing = new Auth.Oauth({
      type: "oauth",
      access: "runtime_key_old",
      softwareToken: "access_old",
      refresh: "refresh_old",
      expires: 1,
      accountId: "acct_123",
    })
    const state = authState(existing)
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({ refresh: () => Effect.void })

    await expect(
      Effect.runPromise(
        WanlaiCodeAuth.refreshOAuthSession({
          refreshToken: "refresh_old",
          apiBase: "https://api.example.com/v1",
          fetch: async (input) => {
            const path = new URL(input.toString()).pathname
            if (path === "/v1/oauth/token") {
              return Response.json({ access_token: "access_new", refresh_token: "refresh_new", expires_in: 7200 })
            }
            // 普通资料失败应返回原错误，但不能撤销 token endpoint 已经轮换的新凭据。
            return Response.json({ error: "profile unavailable" }, { status: 400 })
          },
        }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
      ),
    ).rejects.toThrow("OAuth profile request failed: 400")

    expect(state.saved).toHaveLength(1)
    expect(state.saved[0]?.info).toMatchObject({
      access: "runtime_key_old",
      softwareToken: "access_new",
      refresh: "refresh_new",
      expires: expect.any(Number),
    })
  })

  test("refreshOAuthSession does not overwrite a new login completed during profile/runtime completion", async () => {
    const existing = new Auth.Oauth({
      type: "oauth",
      access: "runtime_key_old",
      softwareToken: "access_old",
      refresh: "refresh_old",
      expires: 1,
    })
    const callback = new Auth.Oauth({
      type: "oauth",
      access: "runtime_key_login",
      softwareToken: "access_login",
      refresh: "refresh_login",
      expires: Math.floor(Date.now() / 1000) + 7200,
    })
    const state = authState(existing)
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({ refresh: () => Effect.void })

    await expect(
      Effect.runPromise(
        WanlaiCodeAuth.refreshOAuthSession({
          refreshToken: "refresh_old",
          apiBase: "https://api.example.com/v1",
          fetch: async (input) => {
            const path = new URL(input.toString()).pathname
            if (path === "/v1/oauth/token") {
              return Response.json({
                access_token: "access_rotated",
                refresh_token: "refresh_rotated",
                expires_in: 3600,
              })
            }
            if (path === "/api/oauth/profile") return Response.json({ account: { uuid: "acct_old" } })
            // runtime key 响应在途时 callback 已落盘；旧补全结果返回后必须被 revision 校验拒绝。
            state.replace(callback)
            return Response.json({ raw_key: "runtime_key_stale" })
          },
        }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
      ),
    ).rejects.toThrow("credential changed during refresh")

    expect(state.current()).toEqual(callback)
    expect(state.saved).toHaveLength(1)
  })

  test("refreshOAuthSessionCore 不会用在途 token 响应复活已明确撤权的凭据", async () => {
    const existing = new Auth.Oauth({
      type: "oauth",
      access: "runtime_key_old",
      softwareToken: "access_old",
      refresh: "refresh_old",
      expires: 1,
    })
    const state = authState(existing)
    let releaseExchange!: () => void
    let markExchangeStarted!: () => void
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve
    })
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })

    WanlaiCodeCredentialState.resetForTest()
    try {
      const refresh = Effect.runPromise(
        WanlaiCodeAuth.refreshOAuthSessionCore({
          refreshToken: "refresh_old",
          apiBase: "https://api.example.com/v1",
          fetch: async (input) => {
            const path = new URL(input.toString()).pathname
            if (path !== "/v1/oauth/token") throw new Error(`unexpected request: ${path}`)
            markExchangeStarted()
            await exchangeGate
            return Response.json({
              access_token: "access_rotated",
              refresh_token: "refresh_rotated",
              expires_in: 3600,
            })
          },
        }).pipe(Effect.provide(state.layer)),
      )

      await exchangeStarted
      // 兼容入口同样以明确撤权为最终结论；成功 token 响应不得落盘，也不得清理旧 revision 的 invalid 标记。
      WanlaiCodeCredentialState.markCredentialInvalid(existing)
      releaseExchange()

      await expect(refresh).rejects.toThrow(/登录已过期|expired/i)
      expect(state.current()).toEqual(existing)
      expect(state.saved).toHaveLength(0)
      expect(WanlaiCodeCredentialState.isCredentialInvalid(existing)).toBe(true)
    } finally {
      WanlaiCodeCredentialState.resetForTest()
    }
  })

  test("refreshOAuthSession refreshes model state after saving auth", async () => {
    const operations: string[] = []
    const state = authState(undefined, () => operations.push("auth.set"))
    const models = Layer.mock(ModelsDev.Service)({
      refresh: (force) => Effect.sync(() => operations.push(`models.refresh:${String(force)}`)),
      refreshWanlaiCode: () => Effect.sync(() => operations.push("models.refreshWanlaiCode")),
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.sync(() => operations.push("provider.refresh")),
    })

    await Effect.runPromise(
      WanlaiCodeAuth.refreshOAuthSession({
        refreshToken: "refresh_123",
        accountUuid: "acct_123",
        apiBase: "https://api.example.com/v1",
        fetch: async (input) => {
          const path = new URL(input.toString()).pathname
          if (path === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (path === "/api/oauth/profile") {
            return Response.json({
              entitlement: { plan: "pro" },
              account: { uuid: "acct_123", email: "user@example.com" },
            })
          }
          return Response.json({ raw_key: "runtime_key_456" })
        },
      }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )

    expect(operations).toEqual(["auth.set", "auth.set", "models.refreshWanlaiCode", "provider.refresh"])
  })

  test("refreshOAuthSession revalidates OAuth profile before saving auth", async () => {
    const requests: Array<{ path: string; authorization: string | null }> = []
    const state = authState()
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.refreshOAuthSession({
        refreshToken: "refresh_123",
        accountUuid: "acct_123",
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          const path = new URL(input.toString()).pathname
          if (path === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (path === "/api/oauth/profile") {
            requests.push({ path, authorization: new Headers(init?.headers).get("authorization") })
            return Response.json({
              entitlement: { plan: "pro" },
              account: { uuid: "acct_123", email: "user@example.com" },
            })
          }
          return Response.json({ raw_key: "runtime_key_456" })
        },
      }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )

    expect(requests).toEqual([{ path: "/api/oauth/profile", authorization: "Bearer access_456" }])
  })

  test("refreshOAuthSession accepts refreshed profile without entitlement", async () => {
    const state = authState()
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.refreshOAuthSession({
        refreshToken: "refresh_123",
        accountUuid: "acct_123",
        apiBase: "https://api.example.com/v1",
        fetch: async (input) => {
          const path = new URL(input.toString()).pathname
          if (path === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (path === "/api/oauth/profile") {
            return Response.json({ account: { uuid: "acct_123" } })
          }
          return Response.json({ raw_key: "runtime_key_456" })
        },
      }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )

    // 第二次写入才包含 profile/runtime key，第一次写入只负责保护轮换凭据。
    expect(state.saved.at(-1)?.info).toMatchObject({
      type: "oauth",
      access: "runtime_key_456",
      refresh: "refresh_456",
      accountId: "acct_123",
    })
  })

  test("refreshOAuthSession stores OAuth session without runtime key when no entitlement exists", async () => {
    const state = authState()
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await Effect.runPromise(
      WanlaiCodeAuth.refreshOAuthSession({
        refreshToken: "refresh_123",
        accountUuid: "acct_123",
        apiBase: "https://api.example.com/v1",
        fetch: async (input) => {
          const path = new URL(input.toString()).pathname
          if (path === "/v1/oauth/token") {
            return Response.json({ access_token: "access_456", refresh_token: "refresh_456", expires_in: 7200 })
          }
          if (path === "/api/oauth/profile") {
            return Response.json({ account: { uuid: "acct_123" } })
          }
          return Response.json(
            {
              error: "software_product_not_entitled",
              message: "user does not have this software product",
            },
            { status: 403 },
          )
        },
      }).pipe(Effect.provide(Layer.mergeAll(state.layer, models, provider))),
    )

    // 无套餐完成阶段返回空 runtime key，但仍会在 token 写入后完成第二次资料合并。
    expect(state.saved.at(-1)?.info).toMatchObject({
      type: "oauth",
      access: "",
      refresh: "refresh_456",
      accountId: "acct_123",
    })
  })

  test("returns invalid api key failure when relay rejects the key", async () => {
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.void,
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    await expect(
      Effect.runPromise(
        WanlaiCodeAuth.loginWithApiKey({
          apiKey: "invalid-key",
          apiBase: "https://api.example.com/v1",
          fetch: async () => Response.json({ code: "INVALID_API_KEY", message: "Invalid API key" }, { status: 401 }),
        }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
      ),
    ).rejects.toThrow("WanlaiCode API key profile request failed: 401")
  })

  test("returns clear API key login failure with purchase URL", async () => {
    const auth = Layer.mock(Auth.Service)({
      set: () => Effect.void,
    })
    const models = Layer.mock(ModelsDev.Service)({
      refresh: () => Effect.void,
      refreshWanlaiCode: () => Effect.void,
    })
    const provider = Layer.mock(Provider.Service)({
      refresh: () => Effect.void,
    })

    const result = await Effect.runPromise(
      WanlaiCodeAuth.loginWithApiKeyResult({
        apiKey: "invalid-key",
        apiBase: "https://api.example.com/v1",
        fetch: async () => Response.json({ error: "invalid key" }, { status: 401 }),
      }).pipe(Effect.provide(Layer.mergeAll(auth, models, provider))),
    )

    expect(result).toEqual({
      ok: false,
      error: "no_entitlement",
      purchaseUrl: WanlaiCodeAuth.defaultConfig.purchaseFallbackUrl,
    })
  })

  test("reads purchase URL from public settings endpoint", async () => {
    const requests: Array<{ path: string; method: string | undefined }> = []

    const purchaseUrl = await Effect.runPromise(
      WanlaiCodeAuth.getPurchaseUrl({
        apiBase: "https://api.example.com/v1",
        fetch: async (input, init) => {
          requests.push({ path: new URL(input.toString()).pathname, method: init?.method })
          return Response.json({ data: { purchase_subscription_url: "https://buy.example.com/pro" } })
        },
      }),
    )

    expect(requests).toEqual([{ path: "/api/v1/settings/public", method: undefined }])
    expect(purchaseUrl).toBe("https://buy.example.com/pro")
  })

  test("falls back to default purchase URL when settings request fails", async () => {
    const purchaseUrl = await Effect.runPromise(
      WanlaiCodeAuth.getPurchaseUrl({
        apiBase: "https://api-fallback.example.com/v1",
        fetch: async () => Response.json({ error: "failed" }, { status: 500 }),
      }),
    )

    expect(purchaseUrl).toBe(WanlaiCodeAuth.defaultConfig.purchaseFallbackUrl)
  })

  test("caches purchase URL for five minutes", async () => {
    let calls = 0
    const now = 1_700_000_000_000

    const first = await Effect.runPromise(
      WanlaiCodeAuth.getPurchaseUrl({
        apiBase: "https://api-cache.example.com/v1",
        now: () => now,
        fetch: async () => {
          calls += 1
          return Response.json({ data: { purchase_subscription_url: `https://buy.example.com/${calls}` } })
        },
      }),
    )

    const second = await Effect.runPromise(
      WanlaiCodeAuth.getPurchaseUrl({
        apiBase: "https://api-cache.example.com/v1",
        now: () => now + 60_000,
        fetch: async () => {
          calls += 1
          return Response.json({ data: { purchase_subscription_url: `https://buy.example.com/${calls}` } })
        },
      }),
    )

    const third = await Effect.runPromise(
      WanlaiCodeAuth.getPurchaseUrl({
        apiBase: "https://api-cache.example.com/v1",
        now: () => now + 301_000,
        fetch: async () => {
          calls += 1
          return Response.json({ data: { purchase_subscription_url: `https://buy.example.com/${calls}` } })
        },
      }),
    )

    expect(first).toBe("https://buy.example.com/1")
    expect(second).toBe("https://buy.example.com/1")
    expect(third).toBe("https://buy.example.com/2")
    expect(calls).toBe(2)
  })
})

describe("WanlaiCode device id", () => {
  test("解析 macOS ioreg 的 IOPlatformUUID", () => {
    const lines = [
      "+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice>",
      '"IOPlatformUUID" = "1FABD4F9-C50A-58A5-8968-4E1D0499E696"',
      '"IOPlatformSerialNumber" = "C02XX0XXJG5H"',
    ]
    expect(WanlaiCodeAuth.parseMachineGUID("darwin", lines)).toBe("1FABD4F9-C50A-58A5-8968-4E1D0499E696")
  })

  test("解析 Windows reg query 的 MachineGuid", () => {
    const lines = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
      "MachineGuid    REG_SZ    a8f3c2d1-7b4e-49a0-9c33-2e1f6d8b0a55",
    ]
    expect(WanlaiCodeAuth.parseMachineGUID("win32", lines)).toBe("a8f3c2d1-7b4e-49a0-9c33-2e1f6d8b0a55")
  })

  test("Windows 仅按首列精确匹配键名，不误命中含子串的其它行", () => {
    // 路径行末尾恰好含 MachineGuid 子串，但首列不是键名，应被跳过。
    expect(
      WanlaiCodeAuth.parseMachineGUID("win32", [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor\\MachineGuid",
        "MachineGuidExtra    REG_SZ    should-not-match",
      ]),
    ).toBe("")
  })

  test("解析 Linux /etc/machine-id 内容", () => {
    expect(WanlaiCodeAuth.parseMachineGUID("linux", ["b9f6d2c4a1e84f0c8d3b5a7e2f1c9d04"])).toBe(
      "b9f6d2c4a1e84f0c8d3b5a7e2f1c9d04",
    )
  })

  test("Linux machine-id 非 hex（文件损坏）时返回空字符串", () => {
    expect(WanlaiCodeAuth.parseMachineGUID("linux", ["not-a-valid-machine-id!!"])).toBe("")
  })

  test("读不到机器码时返回空字符串", () => {
    expect(WanlaiCodeAuth.parseMachineGUID("darwin", [])).toBe("")
    expect(WanlaiCodeAuth.parseMachineGUID("win32", ["HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography"])).toBe("")
    expect(WanlaiCodeAuth.parseMachineGUID("linux", [""])).toBe("")
    expect(WanlaiCodeAuth.parseMachineGUID("freebsd" as NodeJS.Platform, ["whatever"])).toBe("")
  })

  test("device-id 为 64 位十六进制且进程内稳定", () => {
    const first = WanlaiCodeAuth.softwareHeaders()["X-Wanlai-Device-Id"]
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    // 进程内缓存：多次调用返回同一值。
    expect(WanlaiCodeAuth.softwareHeaders()["X-Wanlai-Device-Id"]).toBe(first)
  })
})
