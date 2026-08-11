import { expect, test } from "bun:test"

test("composer keeps review status out of the bottom dock", async () => {
  const region = await Bun.file(new URL("./session-composer-region.tsx", import.meta.url)).text()
  const permission = await Bun.file(new URL("./session-permission-dock.tsx", import.meta.url)).text()

  expect(region).not.toContain("SessionPermissionReviewDock")
  expect(region).not.toContain("permissionReview()")
  expect(permission).not.toContain("PermissionReviewState")
  expect(permission).not.toContain("permissionReviewReason")
})
