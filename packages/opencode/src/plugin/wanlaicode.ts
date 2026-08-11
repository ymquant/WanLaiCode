import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { WanlaiCodeAuth } from "@/provider/wanlaicode"

const wanlaiCodeFetch = WanlaiCodeAuth.createFetch("WanlaiCode.oauth")
const log = Log.create({ service: "plugin.wanlaicode" })

// 把 OAuth 回调结果集中映射成持久化凭据，确保无推理套餐时仍保留手机远控所需的软件 JWT。
export function oauthCallbackResult(input: {
  tokens: WanlaiCodeAuth.OAuthTokenResponse
  profile: WanlaiCodeAuth.WanlaiCodeProfile
  runtimeKey: string
  now?: number
}) {
  return {
    type: "success" as const,
    provider: "wanlaicode",
    refresh: input.tokens.refresh_token ?? "",
    access: input.runtimeKey,
    softwareToken: input.tokens.access_token,
    // OAuth 回调与后台刷新共用同一过期时间算法，expires_in 缺失时尊重 JWT exp，禁止延寿已过期 token。
    expires: WanlaiCodeAuth.oauthTokenExpiresAt({
      accessToken: input.tokens.access_token,
      expiresIn: input.tokens.expires_in,
      now: input.now,
    }),
    accountId: input.profile.account?.uuid,
    accountEmail: WanlaiCodeAuth.profileAccountEmail(input.profile),
    accountName: WanlaiCodeAuth.profileAccountName(input.profile),
    enterpriseUrl: WanlaiCodeAuth.defaultConfig.siteUrl,
  }
}

export async function WanlaiCodeAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "wanlaicode",
      methods: [
        {
          type: "oauth",
          label: "使用 万来Code 继续",
          authorize: async () => {
            const oauth = await WanlaiCodeAuth.startOAuth({})

            const callback = await WanlaiCodeAuth.createOAuthCallback({
              state: oauth.state,
            })

            const authorizeUrl = WanlaiCodeAuth.buildAuthorizeUrl({
              redirectUri: callback.redirectUri,
              state: oauth.state,
              codeChallenge: oauth.codeChallenge,
            })

            return {
              url: authorizeUrl.href,
              instructions: "Complete authorization in your browser",
              method: "auto" as const,
              callback: async () => {
                const code = await callback.wait()
                callback.stop()

                const tokens = await WanlaiCodeAuth.exchangeOAuthCode({
                  code,
                  redirectUri: callback.redirectUri,
                  codeVerifier: oauth.codeVerifier,
                  fetch: wanlaiCodeFetch,
                }).pipe(Effect.runPromise)

                const profile = await WanlaiCodeAuth.validateOAuthProfile({
                  accessToken: tokens.access_token,
                  fetch: wanlaiCodeFetch,
                }).pipe(Effect.runPromise)

                const runtimeKey = await WanlaiCodeAuth.createRuntimeKey({
                  accessToken: tokens.access_token,
                  fetch: wanlaiCodeFetch,
                }).pipe(
                  Effect.catchIf(WanlaiCodeAuth.isNoEntitlementError, (error) =>
                    Effect.sync(() => {
                      log.warn(
                        "runtime key unavailable without entitlement; saving OAuth session without inference key",
                        { error },
                      )
                      return ""
                    }),
                  ),
                  Effect.runPromise,
                )

                // 回调成功后一次性返回完整 OAuth 代次，避免 runtime key 为空时遗漏软件 JWT。
                return oauthCallbackResult({ tokens, profile, runtimeKey })
              },
            }
          },
        },
        {
          type: "api",
          label: "使用其他方式登录",
        },
      ],
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "wanlaicode") return
      // 万来Code 上游部分模型不接受 max_output_tokens，交给模型默认输出预算处理。
      output.maxOutputTokens = undefined
      // 上报会话 ID。服务端据此把同一会话的多轮请求归并到一起，不带的话它只能
      // 拿请求内容的哈希去猜会话边界，而那是启发式的：开场一字不差的两个会话
      // 分不开、上下文压缩后前缀断裂、回退分叉会把两条支线并成一条。
      //
      // 键名必须是 snake_case 的 prompt_cache_key，不能照抄 transform.ts 里那行
      // promptCacheKey。@ai-sdk/openai-compatible 会把 providerOptions 里
      // **它自己 schema 之外**的字段原样铺进请求体，键名一个字符都不改写——
      // 也就是说写驼峰出去就是驼峰，服务端读的 prompt_cache_key 永远拿不到值，
      // 而且这种失效完全静默。见 test/provider/wanlaicode-session-id-wire.test.ts，
      // 那里抓的是最终 HTTP 请求体，不是中间对象。
      //
      // 顺带有正收益：prompt_cache_key 本就是上游的提示词缓存键，语义正是
      // 「同一段对话前缀用同一个键」，与这里的用法一致。
      output.options["prompt_cache_key"] = input.sessionID
    },
  }
}
