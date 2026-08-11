import { gatewayReasonFromBody } from "./gateway-reason"

const MACHINE_CODE = /^[A-Z][A-Z0-9_]*$/

// 从 "SOFTWARE_BILLING_COST_UNAVAILABLE: The requested model is not available" 这类 message 提取 reason。
export function reasonFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  const trimmed = message.trim()
  if (!trimmed) return undefined

  const colonMatch = trimmed.match(/^([A-Z][A-Z0-9_]+):\s/)
  if (colonMatch?.[1] && MACHINE_CODE.test(colonMatch[1])) return colonMatch[1]

  if (MACHINE_CODE.test(trimmed)) return trimmed

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return gatewayReasonFromBody(JSON.parse(trimmed))
    } catch {
      return undefined
    }
  }

  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      return gatewayReasonFromBody(JSON.parse(trimmed.slice(start, end + 1)))
    } catch {
      return undefined
    }
  }

  return undefined
}
