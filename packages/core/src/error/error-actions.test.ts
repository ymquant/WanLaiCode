import { expect, test, describe } from "bun:test"
import { errorAction, type ErrorAction } from "./error-actions"
import type { ErrorCategory } from "./error-codes"

describe("errorAction", () => {
  // Record 类型强制：遗漏任一 category 会在编译期报错，比逐个断言更强。
  const expected: Record<ErrorCategory, ErrorAction> = {
    auth_expired: "relogin",
    auth_invalid: "show_message",
    account_disabled: "show_blocked",
    subscription_suspended: "show_blocked",
    entitlement_missing: "open_purchase",
    upgrade_required: "open_purchase",
    subscription_expired: "open_purchase",
    quota_exhausted: "show_quota",
    rate_limited: "backoff_retry",
    api_key_invalid: "show_message",
    upstream_error: "show_message",
    invalid_request: "show_message",
    service_unavailable: "show_message",
    internal: "show_message",
    unknown: "show_message",
  }

  for (const [category, action] of Object.entries(expected) as Array<[ErrorCategory, ErrorAction]>) {
    test(`${category} → ${action}`, () => {
      expect(errorAction(category)).toBe(action)
    })
  }
})
