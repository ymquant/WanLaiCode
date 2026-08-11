import type { UserCenterStatus } from "@/pages/users/types"

export type AccountPopoverState = "loading" | "authenticated" | "signed_out" | "reauth_required" | "error"

// 账号资料只有在当前授权仍有效时才能驱动已登录菜单，createResource.latest 的旧值不能越过认证边界。
export function authenticatedAccountStatus(status: UserCenterStatus | null | undefined) {
  return status?.authenticated === true ? status : undefined
}

// 账号过期事件会重新发起状态请求；只有最后一次请求的响应可以解除旧凭据边界。
export function isLatestAccountStatusRequest(requestGeneration: number, currentGeneration: number) {
  return requestGeneration === currentGeneration
}

// 把网络状态、普通未登录与授权失效拆开；auth.expired 事件可立即压过仍在缓存中的旧成功响应。
export function accountPopoverState(
  status: UserCenterStatus | null | undefined,
  loading: boolean,
  failed: boolean,
  authExpired = false,
): AccountPopoverState {
  if (authExpired || status?.oauth_reauth_required === true) return "reauth_required"
  if (loading && !status) return "loading"
  if (failed) return "error"
  if (status?.authenticated === true) return "authenticated"
  return "signed_out"
}
