import type { ErrorCategory } from "@opencode-ai/core/error/error-codes"
import type { ErrorMessageMap } from "@opencode-ai/core/error/message-map"

type Translator = (key: string) => string

const ERROR_CATEGORIES: ErrorCategory[] = [
  "auth_expired",
  "auth_invalid",
  "entitlement_missing",
  "upgrade_required",
  "subscription_expired",
  "subscription_suspended",
  "quota_exhausted",
  "rate_limited",
  "account_disabled",
  "api_key_invalid",
  "upstream_error",
  "invalid_request",
  "service_unavailable",
  "internal",
  "unknown",
]

export function sessionCategoryErrorMessages(t: Translator): ErrorMessageMap {
  return Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, t(`errors.category.${category}`)]))
}

export function imageGenerationClientConfig(t: Translator) {
  return {
    failure_prefix: t("prompt.imageGeneration.message.failed"),
    loading_text: t("prompt.imageGeneration.message.loading"),
    error_messages: {
      group_disabled: t("prompt.imageGeneration.error.groupDisabled"),
      ...sessionCategoryErrorMessages(t),
    },
  }
}
