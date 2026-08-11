export function parseUninstallFeedbackResponse(
  status: number,
  body: unknown,
): { ok: boolean; id?: string; retryable: boolean } {
  const env = (body ?? {}) as { code?: number; data?: { id?: string } }
  if (status === 200 && env.code === 0) {
    return { ok: true, id: env.data?.id, retryable: false }
  }
  if (status === 503) return { ok: false, retryable: true }
  return { ok: false, retryable: false }
}
