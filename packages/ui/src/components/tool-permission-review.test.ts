import { expect, test } from "bun:test"

import { parseToolPermissionReview, permissionReviewPresentation } from "./tool-permission-review-data"

test("parses an in-progress review without requiring a reason", () => {
  const review = parseToolPermissionReview({ status: "reviewing" })

  expect(review).toBeDefined()
  expect(permissionReviewPresentation(review!)).toEqual({
    icon: "sparkle",
    label: "ui.toolPermissionReview.reviewing",
    tone: "neutral",
    reason: undefined,
    risk: undefined,
    providerID: undefined,
    modelID: undefined,
  })
})

test("parses a persisted approved review into a visible success presentation", () => {
  const review = parseToolPermissionReview({
    status: "approved",
    decision: "approve",
    risk: "low",
    reason: "explicitly authorized",
    providerID: "wanlaicode",
    modelID: "deepseek-v4-flash",
  })

  expect(review).toMatchObject({ providerID: "wanlaicode", modelID: "deepseek-v4-flash" })
  expect(permissionReviewPresentation(review!)).toEqual({
    icon: "shield",
    label: "ui.toolPermissionReview.approved",
    tone: "neutral",
    reason: "explicitly authorized",
    risk: "low",
    providerID: "wanlaicode",
    modelID: "deepseek-v4-flash",
  })
})

test("shows a safe localized reason when the reviewer itself fails", () => {
  const review = parseToolPermissionReview({ status: "failed", reason: "reviewer_unavailable" })

  expect(review).toBeDefined()
  expect(permissionReviewPresentation(review!)).toEqual({
    icon: "warning",
    label: "ui.toolPermissionReview.failed",
    tone: "neutral",
    reason: "ui.toolPermissionReview.failure.reviewerUnavailable",
    risk: undefined,
    providerID: undefined,
    modelID: undefined,
  })
})

test("uses red only for denied reviews", () => {
  const presentations = [
    { status: "approved", reason: "ok" },
    { status: "denied", reason: "blocked" },
    { status: "escalated", reason: "ask the user" },
    { status: "failed", reason: "reviewer_unavailable" },
  ].map((value) => permissionReviewPresentation(parseToolPermissionReview(value)!))

  expect(presentations.map((item) => [item.icon, item.tone])).toEqual([
    ["shield", "neutral"],
    ["circle-x", "danger"],
    ["hand", "neutral"],
    ["warning", "neutral"],
  ])
})

test("collapses review history into a tooltip icon", async () => {
  const source = await Bun.file(new URL("./tool-permission-review.tsx", import.meta.url)).text()

  expect(source).toContain("<Tooltip")
  expect(source).toContain('data-slot="tool-permission-review-tooltip"')
  expect(source).toContain('viewBox={item().icon === "hand"')
  expect(source).toContain('"0 0 1024 1024"')
  expect(source).not.toContain("<span>{i18n.t(item().label)}</span>")
})

test("ignores malformed tool metadata", () => {
  expect(parseToolPermissionReview({ status: "approved" })).toBeUndefined()
  expect(parseToolPermissionReview({ status: "unknown", reason: "x" })).toBeUndefined()
})
