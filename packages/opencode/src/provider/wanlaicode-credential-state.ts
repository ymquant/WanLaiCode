import { Auth } from "@/auth"

type AuthOauth = Extract<Auth.Info, { type: "oauth" }>

const invalidCredentialRevisions = new Set<string>()
const INVALID_CREDENTIAL_REVISION_LIMIT = 32

// 仅真正凭据字段定义认证代次；账号资料会被后台异步补全，不能借此绕过已确认的失效状态。
export function credentialRevision(info: AuthOauth) {
  return JSON.stringify([info.refresh, info.softwareToken ?? "", info.expires])
}

// 失效记录按插入顺序限制容量，避免长驻桌面进程在多次登录后无限积累历史凭据。
export function markCredentialInvalid(info: AuthOauth): void {
  const revision = credentialRevision(info)
  invalidCredentialRevisions.delete(revision)
  invalidCredentialRevisions.add(revision)
  while (invalidCredentialRevisions.size > INVALID_CREDENTIAL_REVISION_LIMIT) {
    const oldest = invalidCredentialRevisions.values().next().value
    if (oldest === undefined) return
    invalidCredentialRevisions.delete(oldest)
  }
}

// OAuth callback 成功后只恢复本次新凭据；其他历史失效代次仍保留，避免旧异步请求重新变成有效状态。
export function clearCredentialInvalid(info: AuthOauth): void {
  invalidCredentialRevisions.delete(credentialRevision(info))
}

export function isCredentialInvalid(info: AuthOauth): boolean {
  return invalidCredentialRevisions.has(credentialRevision(info))
}

// 测试间必须隔离进程级认证结论，生产流程不会主动清空仍在使用的失效代次。
export function resetForTest(): void {
  invalidCredentialRevisions.clear()
}

export * as WanlaiCodeCredentialState from "./wanlaicode-credential-state"
