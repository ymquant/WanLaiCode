function sanitize(value: string, maxLength = 128): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLength)
}

export function buildUninstallFeedbackHeaders(meta: {
  client: string
  clientVersion: string
  os: string
  arch: string
}): Record<string, string> {
  return {
    // 随 brand 变(wanlai / codex…)，与 apiBase、@opencode-ai/brand 对齐，便于后端按 brand 归类。
    "X-Wanlai-Client": sanitize(meta.client, 64),
    "X-Wanlai-Client-Version": sanitize(meta.clientVersion, 64),
    "X-Wanlai-OS": sanitize(meta.os),
    "X-Wanlai-Arch": sanitize(meta.arch),
  }
}
