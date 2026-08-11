import { describe, expect, test } from "bun:test"
import type { PermissionReviewState } from "./types"
import { createPermissionReviewLifecycle } from "./permission-review-lifecycle"

const review = (
  id: string,
  sessionID: string,
  status: PermissionReviewState["status"],
): PermissionReviewState => ({
  id,
  permissionID: `per_${id}`,
  sessionID,
  status,
  summary: id,
  startedAt: 1,
  completedAt: status === "reviewing" ? undefined : 2,
})

describe("permission review lifecycle", () => {
  test("expires approved reviews after 1.2 seconds without a composer mount", async () => {
    const lifecycle = createPermissionReviewLifecycle()
    const removed: string[] = []

    lifecycle.sync({
      directory: "/background",
      review: review("review_approved", "ses_background", "approved"),
      remove: (id) => removed.push(id),
    })

    await Bun.sleep(1_250)
    expect(removed).toEqual(["review_approved"])
  })

  test("expires denied, escalated, and failed reviews after five seconds even while a human card is visible", async () => {
    const lifecycle = createPermissionReviewLifecycle()
    const removed: string[] = []

    for (const status of ["denied", "escalated", "failed"] as const) {
      lifecycle.sync({
        directory: "/background",
        review: review(`review_${status}`, `ses_${status}`, status),
        remove: (id) => removed.push(id),
      })
    }

    await Bun.sleep(5_050)
    expect(removed.sort()).toEqual(["review_denied", "review_escalated", "review_failed"])
  }, 6_000)

  test("replaces a review timer and clears timers when a session or directory cache is dropped", async () => {
    const lifecycle = createPermissionReviewLifecycle()
    const removed: string[] = []

    lifecycle.sync({
      directory: "/switch",
      review: review("review_replaced", "ses_replaced", "approved"),
      remove: (id) => removed.push(id),
    })
    lifecycle.sync({
      directory: "/switch",
      review: review("review_replaced", "ses_replaced", "denied"),
      remove: (id) => removed.push(id),
    })
    lifecycle.sync({
      directory: "/switch", review: review("review_session", "ses_session", "approved"), remove: (id) => removed.push(id) })
    lifecycle.sync({
      directory: "/disposed", review: review("review_directory", "ses_directory", "approved"), remove: (id) => removed.push(id) })
    lifecycle.clearSession("/switch", "ses_session")
    lifecycle.clearDirectory("/disposed")

    await Bun.sleep(1_250)
    expect(removed).toEqual([])

    await Bun.sleep(3_850)
    expect(removed).toEqual(["review_replaced"])
  }, 6_000)
})
