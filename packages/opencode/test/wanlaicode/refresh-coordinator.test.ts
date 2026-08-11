import { test, expect, describe, beforeEach } from "bun:test"
import { WanlaiCodeRefreshCoordinator } from "../../src/provider/wanlaicode-refresh-coordinator"
import {
  computeRefreshDelayMs,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  REFRESH_LEAD_MS,
} from "../../src/provider/wanlaicode-refresh-coordinator"
import { WanlaiCodeAuth } from "../../src/provider/wanlaicode"

type Oauth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
  accountEmail?: string
  accountName?: string
  enterpriseUrl?: string
  softwareToken?: string
}

function makeAuth(refresh: string, access = "sk-old"): Oauth {
  return { type: "oauth", access, refresh, expires: 0 }
}

function refreshError(reason: string) {
  return new WanlaiCodeAuth.OAuthRefreshError({
    status: 401,
    reason,
    body: JSON.stringify({ error: reason.toLowerCase() }),
  })
}

describe("WanlaiCodeRefreshCoordinator", () => {
  beforeEach(() => WanlaiCodeRefreshCoordinator.resetForTest())

  test("并发 refresh 只触发一次真实刷新（单飞）", async () => {
    let calls = 0
    let store = makeAuth("R0")
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return { refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt" }
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "sk-new", profile: {} }),
    })
    const [a, b, c] = await Promise.all([
      WanlaiCodeRefreshCoordinator.refresh(),
      WanlaiCodeRefreshCoordinator.refresh(),
      WanlaiCodeRefreshCoordinator.refresh(),
    ])
    expect(calls).toBe(1)
    expect(a.runtimeKey).toBe("sk-new")
    expect(a.refreshToken).toBe("R1")
    expect(a.softwareToken).toBe("jwt")
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(store.refresh).toBe("R1")
    expect(store.access).toBe("sk-new")
  })

  test("刷新从内存最新 refresh token 出发，第二次不再用旧值", async () => {
    const seen: string[] = []
    let store = makeAuth("R0")
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async ({ refreshToken }) => {
        seen.push(refreshToken)
        const next = refreshToken === "R0" ? "R1" : "R2"
        return { refreshToken: next, expiresIn: 3600, softwareToken: "jwt-" + next }
      },
      refreshRuntimeKey: async ({ accessToken }) => ({ runtimeKey: "sk-" + accessToken, profile: {} }),
    })
    await WanlaiCodeRefreshCoordinator.refresh()
    await WanlaiCodeRefreshCoordinator.refresh()
    expect(seen).toEqual(["R0", "R1"])
  })

  test("无推理权益返回空 runtime key 时仍持久化轮换后的 OAuth 凭据", async () => {
    let store = makeAuth("R0")
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => ({
        refreshToken: "R1",
        expiresIn: 3600,
        softwareToken: "jwt-new",
      }),
      refreshRuntimeKey: async () => ({
        runtimeKey: "",
        profile: { account: { uuid: "acct_123" } },
      }),
    })

    const result = await WanlaiCodeRefreshCoordinator.refresh()

    // 手机远控只依赖软件 JWT；套餐为空不能让已轮换的 refresh token 丢失。
    expect(result).toMatchObject({ runtimeKey: "", refreshToken: "R1", softwareToken: "jwt-new" })
    expect(store).toMatchObject({ access: "", refresh: "R1", softwareToken: "jwt-new", accountId: "acct_123" })
  })

  test("profile/runtime key 失败前已原子保存轮换后的 OAuth 三元组", async () => {
    let store: Oauth = { ...makeAuth("R0"), softwareToken: "jwt-old", expires: 10 }
    const saved: Oauth[] = []
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
        saved.push(store)
      },
      refreshToken: async () => ({ refreshToken: "R1", expiresIn: 7200, softwareToken: "jwt-new" }),
      refreshRuntimeKey: async () => {
        // 模拟 token 已轮换后 profile/runtime key 的瞬时故障，协调器仍必须保住唯一可继续使用的新 refresh token。
        throw new Error("profile temporarily unavailable")
      },
    })

    const error = await WanlaiCodeRefreshCoordinator.refresh().catch((cause) => cause)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("profile temporarily unavailable")
    expect(WanlaiCodeAuth.isOAuthExpiredError(error)).toBe(false)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(store)).toBe(false)
    expect(saved).toHaveLength(1)
    expect(store).toMatchObject({ access: "sk-old", refresh: "R1", softwareToken: "jwt-new" })
    expect(store.expires).toBeGreaterThan(Math.floor(Date.now() / 1000) + 7100)
  })

  test("expires_in 缺失时不会把新 OAuth 凭据保存成已过期", async () => {
    let store = makeAuth("R0")
    const now = Math.floor(Date.now() / 1000)
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => ({ refreshToken: "R1", softwareToken: "opaque-access-token" }),
      refreshRuntimeKey: async () => ({ runtimeKey: "sk-new", profile: {} }),
    })

    await WanlaiCodeRefreshCoordinator.refresh()

    // 不可解析的 opaque token 使用一小时默认值，避免 scheduler 和所有调用方立即再次刷新。
    expect(store.expires).toBeGreaterThanOrEqual(now + 3599)
  })

  test("无显式 apiBase 时不会把 OAuth 站点 enterpriseUrl 当成 API 地址", async () => {
    let store: Oauth = { ...makeAuth("R0"), enterpriseUrl: "https://login.example.com" }
    const seenApiBases: Array<string | undefined> = []
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async ({ apiBase }) => {
        seenApiBases.push(apiBase)
        return { refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt-R1" }
      },
      refreshRuntimeKey: async ({ apiBase }) => {
        seenApiBases.push(apiBase)
        return { runtimeKey: "sk-R1", profile: {} }
      },
    })

    await WanlaiCodeRefreshCoordinator.refresh()

    // undefined 会让 wanlaicode.ts 使用唯一默认 API 配置；登录站点不能被 normalize 成错误的 /v1 后端。
    expect(seenApiBases).toEqual([undefined, undefined])
  })

  test("同进程退出后重新登录不会复用旧 shared refresh token", async () => {
    const seen: string[] = []
    let store: Oauth = { ...makeAuth("R0"), softwareToken: "jwt-R0", accountId: "acct-old" }
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async ({ refreshToken }) => {
        seen.push(refreshToken)
        return { refreshToken: `${refreshToken}-next`, expiresIn: 3600, softwareToken: `jwt-${refreshToken}-next` }
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "sk-next", profile: {} }),
    })

    await WanlaiCodeRefreshCoordinator.refresh()
    // 模拟 OAuth callback 在同一进程写入另一个账号；来源 revision 变化后旧账号内存 token 必须立即失效。
    store = {
      ...makeAuth("LOGIN-R0"),
      softwareToken: "jwt-login",
      expires: Math.floor(Date.now() / 1000) + 3600,
      accountId: "acct-new",
    }
    await WanlaiCodeRefreshCoordinator.refresh()

    expect(seen).toEqual(["R0", "LOGIN-R0"])
  })

  test("profile/runtime key 返回时不会覆盖期间完成的新登录", async () => {
    let store: Oauth = { ...makeAuth("R0"), softwareToken: "jwt-R0", expires: 1 }
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      modifyAuth: async (update) => {
        const modified = update(store) as Oauth | undefined
        if (!modified) return undefined
        store = modified
        return store
      },
      refreshToken: async () => ({ refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt-R1" }),
      refreshRuntimeKey: async () => {
        // 模拟补全请求在途时 OAuth callback 写入新账号，旧 runtime key 完成结果必须被丢弃。
        store = {
          ...makeAuth("LOGIN-R0"),
          softwareToken: "jwt-login",
          expires: Math.floor(Date.now() / 1000) + 7200,
        }
        return { runtimeKey: "sk-stale", profile: {} }
      },
    })

    await expect(WanlaiCodeRefreshCoordinator.refresh()).rejects.toThrow("credential changed during refresh")
    expect(store).toMatchObject({ refresh: "LOGIN-R0", softwareToken: "jwt-login", access: "sk-old" })
  })

  test("token exchange 在途完成的新登录不会被旧刷新第一阶段覆盖", async () => {
    let store: Oauth = { ...makeAuth("R0"), softwareToken: "jwt-R0", expires: 1 }
    let releaseExchange!: () => void
    let markExchangeStarted!: () => void
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve
    })
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      modifyAuth: async (update) => {
        const modified = update(store) as Oauth | undefined
        if (!modified) return undefined
        store = modified
        return store
      },
      refreshToken: async () => {
        markExchangeStarted()
        await exchangeGate
        return { refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt-R1" }
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "sk-R1", profile: {} }),
    })

    const refresh = WanlaiCodeRefreshCoordinator.refresh()
    await exchangeStarted
    // OAuth callback 与刷新 CAS 共用 Auth.modify 锁；callback 先提交后，旧 exchange 只能失败退出。
    store = {
      ...makeAuth("LOGIN-R0"),
      softwareToken: "jwt-login",
      expires: Math.floor(Date.now() / 1000) + 7200,
    }
    releaseExchange()

    await expect(refresh).rejects.toThrow("credential changed during refresh")
    expect(store).toMatchObject({ refresh: "LOGIN-R0", softwareToken: "jwt-login", access: "sk-old" })
  })

  test("token exchange 在途收到明确撤权时不会写入或清除失效 revision", async () => {
    let store: Oauth = { ...makeAuth("R0"), softwareToken: "jwt-R0", expires: 1 }
    let releaseExchange!: () => void
    let markExchangeStarted!: () => void
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve
    })
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      modifyAuth: async (update) => {
        const modified = update(store) as Oauth | undefined
        if (!modified) return undefined
        store = modified
        return store
      },
      refreshToken: async () => {
        markExchangeStarted()
        await exchangeGate
        return { refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt-R1" }
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "sk-R1", profile: {} }),
    })

    const refresh = WanlaiCodeRefreshCoordinator.refresh()
    await exchangeStarted
    // socket 明确撤权发生在 token 请求返回前，CAS 必须拒绝成功响应，且不能借刷新清掉旧 revision 的失效结论。
    WanlaiCodeRefreshCoordinator.markCredentialInvalid(store)
    releaseExchange()

    await expect(refresh).rejects.toThrow(/登录已过期|expired/i)
    expect(store).toMatchObject({ refresh: "R0", softwareToken: "jwt-R0", access: "sk-old" })
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(store)).toBe(true)
  })

  test("profile/runtime key 补全会保留同凭据代次的并发账号资料更新", async () => {
    let store: Oauth = { ...makeAuth("R0"), softwareToken: "jwt-R0", expires: 1 }
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => ({ refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt-R1" }),
      refreshRuntimeKey: async () => {
        // 模拟 status 后台在补全请求期间写入账号资料；token revision 未变时最终写入必须保留它。
        store = { ...store, accountEmail: "user@example.com", accountName: "测试账号" }
        return { runtimeKey: "sk-R1", profile: {} }
      },
    })

    await WanlaiCodeRefreshCoordinator.refresh()

    expect(store).toMatchObject({
      refresh: "R1",
      softwareToken: "jwt-R1",
      access: "sk-R1",
      accountEmail: "user@example.com",
      accountName: "测试账号",
    })
  })

  test("OAuth callback 写入的新代次不会继承旧 invalid 标记", async () => {
    const stale = { ...makeAuth("same-refresh"), softwareToken: "jwt-old", expires: 100, accountId: "acct" }
    const callback = { ...stale, softwareToken: "jwt-new", expires: 200 }

    // callback 可能复用 refresh token；JWT/到期时间变化仍会建立新的凭据代次并自动恢复登录态。
    WanlaiCodeRefreshCoordinator.markCredentialInvalid(stale)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(stale)).toBe(true)
    expect(WanlaiCodeRefreshCoordinator.isCredentialInvalid(callback)).toBe(false)
  })

  test("账号资料异步补全不会让 invalid 凭据变成新代次", () => {
    const stale = { ...makeAuth("R0"), softwareToken: "jwt", expires: 100 }
    WanlaiCodeRefreshCoordinator.markCredentialInvalid(stale)

    // status 后台只补 email/name；真正 token 未变化时，全局失效结论必须继续生效。
    expect(
      WanlaiCodeRefreshCoordinator.isCredentialInvalid({
        ...stale,
        accountId: "acct",
        accountEmail: "user@example.com",
        accountName: "测试账号",
      }),
    ).toBe(true)
  })

  test("调度器启动后再登录时不会提前刷新尚未到期的 OAuth 凭据", async () => {
    let store: Oauth | undefined
    let refreshCalls = 0
    const scheduled: Array<{ callback: () => void | Promise<void>; delay: number }> = []
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout

    // 拦截定时器以稳定复现“进程先启动、用户随后登录、首个 60 秒 tick 到达”的真实时序。
    globalThis.setTimeout = ((callback: () => void | Promise<void>, delay = 0) => {
      scheduled.push({ callback, delay })
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout

    try {
      WanlaiCodeRefreshCoordinator.configureForTest({
        loadAuth: async () => store,
        saveAuth: async (info) => {
          store = info as Oauth
        },
        refreshToken: async () => {
          refreshCalls++
          return { refreshToken: "R2", expiresIn: 3600, softwareToken: "jwt-R2" }
        },
        refreshRuntimeKey: async () => ({ runtimeKey: "sk-R2", profile: {} }),
      })

      WanlaiCodeRefreshCoordinator.ensureTokenRefreshScheduler()
      expect(scheduled[0]?.delay).toBe(MIN_DELAY_MS)

      store = {
        ...makeAuth("R1"),
        softwareToken: "jwt-R1",
        expires: Math.floor(Date.now() / 1000) + 3600,
      }
      await scheduled.shift()!.callback()

      // 新登录凭据还有一小时有效期，应重排到刷新窗口而不是立即兑换 refresh token。
      expect(refreshCalls).toBe(0)
      expect(scheduled).toHaveLength(1)
      expect(scheduled[0]!.delay).toBeGreaterThan(MIN_DELAY_MS)
    } finally {
      WanlaiCodeRefreshCoordinator.stopTokenRefreshScheduler()
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test("撞 invalid_grant 时重读 auth，token 已被更新则用新值重试成功", async () => {
    let store = makeAuth("R0")
    let attempt = 0
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async ({ refreshToken }) => {
        attempt++
        if (refreshToken === "R0") {
          // 模拟：另一进程已把 auth.json 轮换到 R9，旧 R0 失效
          store = makeAuth("R9")
          throw refreshError("SOFTWARE_OAUTH_REFRESH_TOKEN_INVALID")
        }
        return { refreshToken: "R10", expiresIn: 3600, softwareToken: "jwt" }
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "sk-R10", profile: {} }),
    })
    const result = await WanlaiCodeRefreshCoordinator.refresh()
    expect(result.runtimeKey).toBe("sk-R10")
    expect(attempt).toBe(2)
  })

  test("invalid_grant 且重读后 token 未变，抛 OAuthExpiredError", async () => {
    let store = makeAuth("R0")
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => {
        throw refreshError("invalid_grant")
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "unused", profile: {} }),
    })
    await expect(WanlaiCodeRefreshCoordinator.refresh()).rejects.toThrow(/登录已过期|expired/i)
  })

  test("no_entitlement 错误原样抛出，不转成 OAuthExpiredError", async () => {
    let store = makeAuth("R0")
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => ({ refreshToken: "R1", expiresIn: 3600, softwareToken: "jwt-R1" }),
      refreshRuntimeKey: async () => {
        throw WanlaiCodeAuth.noEntitlementError("no_entitlement")
      },
    })
    const error = await WanlaiCodeRefreshCoordinator.refresh().catch((e) => e)
    expect(WanlaiCodeAuth.isNoEntitlementRuntimeError(error)).toBe(true)
    expect(WanlaiCodeAuth.isOAuthExpiredError(error)).toBe(false)
  })

  test("首次 invalid_grant → 重读拿到新 token → 第二次仍 invalid_grant，最终抛 OAuthExpiredError", async () => {
    let store = makeAuth("R0")
    let attempt = 0
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async ({ refreshToken }) => {
        attempt++
        if (refreshToken === "R0") {
          // 模拟：另一进程已把 auth.json 轮换到 R9，旧 R0 失效
          store = makeAuth("R9")
          throw refreshError("invalid_grant")
        }
        // 第二次（用重读到的 R9）依然失效
        throw refreshError("invalid_grant")
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "unused", profile: {} }),
    })
    await expect(WanlaiCodeRefreshCoordinator.refresh()).rejects.toThrow(/登录已过期|expired/i)
    expect(attempt).toBe(2)
  })

  test("首次 invalid_grant → 重读拿到新 token → 第二次抛 no_entitlement，原样抛出", async () => {
    let store = makeAuth("R0")
    let attempt = 0
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => store,
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async ({ refreshToken }) => {
        attempt++
        if (refreshToken === "R0") {
          store = makeAuth("R9")
          throw refreshError("invalid_grant")
        }
        throw WanlaiCodeAuth.noEntitlementError("no_entitlement")
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "unused", profile: {} }),
    })
    const error = await WanlaiCodeRefreshCoordinator.refresh().catch((e) => e)
    expect(WanlaiCodeAuth.isNoEntitlementRuntimeError(error)).toBe(true)
    expect(WanlaiCodeAuth.isOAuthExpiredError(error)).toBe(false)
    expect(attempt).toBe(2)
  })

  test("invalid_grant 重读后 reloaded 为 undefined（凭据并发消失），抛 OAuthExpiredError", async () => {
    let store: Oauth | undefined = makeAuth("R0")
    let loadCount = 0
    WanlaiCodeRefreshCoordinator.configureForTest({
      loadAuth: async () => {
        loadCount++
        // 第一次读到 R0，第二次（重读）凭据已并发消失
        if (loadCount === 1) return store
        return undefined
      },
      saveAuth: async (info) => {
        store = info as Oauth
      },
      refreshToken: async () => {
        throw refreshError("invalid_grant")
      },
      refreshRuntimeKey: async () => ({ runtimeKey: "unused", profile: {} }),
    })
    await expect(WanlaiCodeRefreshCoordinator.refresh()).rejects.toThrow(/登录已过期|expired/i)
  })
})

describe("computeRefreshDelayMs", () => {
  const now = 1_000_000_000_000
  const nowSec = Math.floor(now / 1000)

  test("过期前 5 分钟触发", () => {
    const expires = nowSec + 3600 // 1 小时后过期
    expect(computeRefreshDelayMs(expires, now)).toBe(3600 * 1000 - REFRESH_LEAD_MS)
  })

  test("已过期/极近过期 → clamp 到最小间隔", () => {
    expect(computeRefreshDelayMs(nowSec - 10, now)).toBe(MIN_DELAY_MS)
    expect(computeRefreshDelayMs(nowSec + 60, now)).toBe(MIN_DELAY_MS)
  })

  test("极远过期 → clamp 到最大间隔", () => {
    const expires = nowSec + 100 * 24 * 3600
    expect(computeRefreshDelayMs(expires, now)).toBe(MAX_DELAY_MS)
  })
})
