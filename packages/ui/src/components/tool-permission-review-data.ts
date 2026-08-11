const statuses = ["reviewing", "approved", "denied", "escalated", "failed"] as const
const risks = ["low", "medium", "high", "critical"] as const

export type ToolPermissionReviewData = {
  status: (typeof statuses)[number]
  reason?: string
  risk?: (typeof risks)[number]
  providerID?: string
  modelID?: string
}

export function parseToolPermissionReview(value: unknown): ToolPermissionReviewData | undefined {
  if (!value || typeof value !== "object") return undefined
  const status = "status" in value ? statuses.find((item) => item === value.status) : undefined
  if (!status) return undefined
  const reason = "reason" in value ? value.reason : undefined
  if (status !== "reviewing" && (typeof reason !== "string" || !reason.trim())) return undefined
  return {
    status,
    reason: typeof reason === "string" && reason.trim() ? reason : undefined,
    risk: "risk" in value ? risks.find((item) => item === value.risk) : undefined,
    providerID: "providerID" in value && typeof value.providerID === "string" ? value.providerID : undefined,
    modelID: "modelID" in value && typeof value.modelID === "string" ? value.modelID : undefined,
  }
}

export function permissionReviewPresentation(review: ToolPermissionReviewData) {
  return {
    icon: {
      reviewing: "sparkle",
      approved: "shield",
      denied: "circle-x",
      escalated: "hand",
      failed: "warning",
    }[review.status] as "sparkle" | "shield" | "circle-x" | "hand" | "warning",
    label: `ui.toolPermissionReview.${review.status}`,
    tone: review.status === "denied" ? ("danger" as const) : ("neutral" as const),
    reason:
      review.status === "failed" && review.reason === "reviewer_unavailable"
        ? "ui.toolPermissionReview.failure.reviewerUnavailable"
        : review.reason,
    risk: review.risk,
    providerID: review.providerID,
    modelID: review.modelID,
  }
}
