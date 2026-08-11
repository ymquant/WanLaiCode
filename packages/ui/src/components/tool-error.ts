function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function toolErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (!record(error)) return String(error ?? "")

  // 工具失败事件可能从服务端带回对象；优先取用户可读字段，避免渲染层把对象当字符串处理。
  if (typeof error.message === "string") return error.message
  if (typeof error.error === "string") return error.error
  if (record(error.error) && typeof error.error.message === "string") return error.error.message
  return stringify(error)
}
