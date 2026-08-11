import { describe, expect, test } from "bun:test"
import { openWebfetchLink } from "./message-part-webfetch-link"

type MockWindow = { open: (...args: unknown[]) => unknown }

function withWindow<T>(windowValue: MockWindow, run: () => T) {
  const original = (globalThis as { window?: MockWindow }).window
  ;(globalThis as { window: MockWindow }).window = windowValue
  try {
    return run()
  } finally {
    if (original === undefined) {
      delete (globalThis as { window?: MockWindow }).window
      return
    }
    ;(globalThis as { window: MockWindow }).window = original
  }
}

describe("openWebfetchLink", () => {
  test("uses the injected external handler when available", () => {
    let calledWith = ""
    let opened = 0

    withWindow(
      {
        open: () => {
          opened += 1
        },
      },
      () => {
        openWebfetchLink("https://example.com", (url) => {
          calledWith = url
        })
      },
    )

    expect(calledWith).toBe("https://example.com")
    expect(opened).toBe(0)
  })

  test("falls back to window.open when no handler is injected", () => {
    let openedWith: unknown[] = []

    withWindow(
      {
        open: (...args: unknown[]) => {
          openedWith = args
        },
      },
      () => {
        openWebfetchLink("https://example.com")
      },
    )

    expect(openedWith).toEqual(["https://example.com", "_blank", "noopener,noreferrer"])
  })
})
