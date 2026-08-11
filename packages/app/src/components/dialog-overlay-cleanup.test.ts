import { afterEach, describe, expect, test } from "bun:test"
import { cleanupOrphanedDialogPortals } from "@opencode-ai/ui/context/dialog"

describe("dialog overlay cleanup", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  test("keeps portals that contain non-shared Kobalte dialog content", () => {
    const portal = document.createElement("div")
    const overlay = document.createElement("div")
    overlay.setAttribute("data-component", "dialog-overlay")
    const content = document.createElement("div")
    content.setAttribute("role", "dialog")
    content.className = "cdx cdx-modal"
    portal.append(overlay, content)
    document.body.append(portal)

    cleanupOrphanedDialogPortals()

    expect(document.body.contains(portal)).toBe(true)
    expect(document.querySelector('[data-component="dialog-overlay"]')).toBe(overlay)
    expect(document.querySelector('[role="dialog"]')).toBe(content)
  })

  test("removes overlay portals without dialog content", () => {
    const portal = document.createElement("div")
    const overlay = document.createElement("div")
    overlay.setAttribute("data-component", "dialog-overlay")
    portal.append(overlay, document.createTextNode("[object Object]"))
    document.body.append(portal)

    cleanupOrphanedDialogPortals()

    expect(document.body.contains(portal)).toBe(false)
    expect(document.querySelector('[data-component="dialog-overlay"]')).toBeNull()
  })

  test("keeps a portal when a dialog becomes active before queued cleanup", async () => {
    const portal = document.createElement("div")
    const overlay = document.createElement("div")
    overlay.setAttribute("data-component", "dialog-overlay")
    portal.append(overlay)
    document.body.append(portal)

    let active = false
    queueMicrotask(() => cleanupOrphanedDialogPortals(() => active))
    active = true
    await Promise.resolve()

    expect(document.body.contains(portal)).toBe(true)
  })
})
