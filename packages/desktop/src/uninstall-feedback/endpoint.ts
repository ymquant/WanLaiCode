export function resolveUninstallFeedbackEndpoint(apiBase: string): string {
  const host = apiBase
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/+$/, "")
  return `${host}/api/v1/software/uninstall-feedback`
}
