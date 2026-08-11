import type { ErrorCategory } from "./error-codes"

export type ErrorAction =
  | "refresh_token" // 先尝试刷新 token（失败再 relogin）
  | "relogin" // 触发重新授权登录
  | "show_blocked" // 账号封禁提示 + 客服
  | "open_purchase" // 打开购买/用户中心
  | "show_quota" // 额度用尽提示（含重置时间）
  | "backoff_retry" // 退避重试提示（交给 retry policy）
  | "show_message" // 展示后端 message（兜底）

// 接入点（UI 层按此落地，复用现有锚点）：
//   refresh_token → oauthAccessToken({force:true})（fetch 层 401 自动刷新，UI 不呈现按钮）
//   relogin       → 现有 OAuth 授权流程
//   open_purchase → 现有购买页/用户中心入口
//   backoff_retry → session/retry.ts 现有 policy
//   show_quota / show_blocked / show_message → showToast / InlineErrorState + i18n(C6)
export function errorAction(category: ErrorCategory): ErrorAction {
  switch (category) {
    case "auth_expired":
      return "relogin"
    case "auth_invalid":
      return "show_message"
    case "account_disabled":
    case "subscription_suspended":
      return "show_blocked"
    case "entitlement_missing":
    case "upgrade_required":
    case "subscription_expired":
      return "open_purchase"
    case "quota_exhausted":
      return "show_quota"
    case "rate_limited":
      return "backoff_retry"
    default:
      return "show_message"
  }
}
