import { describe, expect, test } from "bun:test"
import {
  nextTabListScrollLeft,
  tabListScrollLeftFromThumbLeft,
  tabListThumbLeftFromPointer,
  tabListThumbMetrics,
} from "./file-tab-scroll"

describe("nextTabListScrollLeft", () => {
  test("does not scroll when width shrinks", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 420,
      clientWidth: 300,
      prevContextOpen: false,
      contextOpen: false,
    })

    expect(left).toBeUndefined()
  })

  test("scrolls to start when context tab opens", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 400,
      scrollWidth: 500,
      clientWidth: 320,
      prevContextOpen: false,
      contextOpen: true,
    })

    expect(left).toBe(0)
  })

  test("scrolls to right edge for new file tabs", () => {
    const left = nextTabListScrollLeft({
      prevScrollWidth: 500,
      scrollWidth: 780,
      clientWidth: 300,
      prevContextOpen: true,
      contextOpen: true,
    })

    expect(left).toBe(480)
  })
})

describe("tabListThumbMetrics", () => {
  test("returns undefined when content fits", () => {
    expect(tabListThumbMetrics(300, 300, 0)).toBeUndefined()
  })

  test("maps scroll position to thumb offset", () => {
    const metrics = tabListThumbMetrics(600, 300, 150)
    expect(metrics).toBeDefined()
    expect(metrics?.left).toBeCloseTo(75, 1)
  })
})

describe("tabListScrollLeftFromThumbLeft", () => {
  test("maps thumb offset back to scroll position", () => {
    const left = tabListScrollLeftFromThumbLeft(75, 150, 300)
    expect(left).toBeCloseTo(150, 1)
  })
})

describe("tabListThumbLeftFromPointer", () => {
  test("centers thumb on pointer within track bounds", () => {
    expect(tabListThumbLeftFromPointer(180, 100, 200, 40)).toBe(60)
    expect(tabListThumbLeftFromPointer(90, 100, 200, 40)).toBe(0)
  })
})
