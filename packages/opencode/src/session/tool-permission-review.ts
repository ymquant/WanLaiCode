import type { Permission } from "@/permission"
import type { MessageV2 } from "@/session/message-v2"

const key = "permissionReview"

export function applyToolPermissionReview(part: MessageV2.ToolPart, review: Permission.ReviewOutcome) {
  if (part.state.status !== "running") return part
  return {
    ...part,
    state: {
      ...part.state,
      metadata: {
        ...part.state.metadata,
        [key]: review,
      },
    },
  } satisfies MessageV2.ToolPart
}

export function mergeToolMetadata(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  if (!current?.[key]) return next ?? {}
  return {
    ...next,
    [key]: current[key],
  }
}
