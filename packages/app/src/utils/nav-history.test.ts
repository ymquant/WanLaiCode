import { describe, expect, test } from "bun:test"
import {
  applyPath,
  canGoBack,
  canGoForward,
  initialNavHistory,
  MAX_NAV_HISTORY,
  normalizePath,
  type NavHistory,
} from "./nav-history"

describe("nav-history > normalizePath", () => {
  test("strips trailing slashes but keeps root /", () => {
    expect(normalizePath("/")).toBe("/")
    expect(normalizePath("/foo")).toBe("/foo")
    expect(normalizePath("/foo/")).toBe("/foo")
    expect(normalizePath("/foo//")).toBe("/foo")
    expect(normalizePath("")).toBe("/")
  })
})

describe("nav-history > applyPath", () => {
  test("first push from initial state", () => {
    const next = applyPath(initialNavHistory(), "/a")
    expect(next).toEqual({ stack: ["/a"], index: 0 })
  })

  test("repeated push of same path is no-op", () => {
    let s: NavHistory = applyPath(initialNavHistory(), "/a")
    s = applyPath(s, "/a")
    expect(s).toEqual({ stack: ["/a"], index: 0 })
  })

  test("push different paths grows stack", () => {
    let s: NavHistory = applyPath(initialNavHistory(), "/a")
    s = applyPath(s, "/b")
    s = applyPath(s, "/c")
    expect(s).toEqual({ stack: ["/a", "/b", "/c"], index: 2 })
  })

  test("back to previous path moves index without truncating", () => {
    let s: NavHistory = initialNavHistory()
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    s = applyPath(s, "/c")
    s = applyPath(s, "/b")
    expect(s).toEqual({ stack: ["/a", "/b", "/c"], index: 1 })
    s = applyPath(s, "/a")
    expect(s).toEqual({ stack: ["/a", "/b", "/c"], index: 0 })
  })

  test("forward replays existing entry", () => {
    let s: NavHistory = initialNavHistory()
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    expect(s).toEqual({ stack: ["/a", "/b"], index: 1 })
  })

  test("new push after going back truncates forward part", () => {
    let s: NavHistory = initialNavHistory()
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    s = applyPath(s, "/c")
    s = applyPath(s, "/b")
    s = applyPath(s, "/x")
    expect(s).toEqual({ stack: ["/a", "/b", "/x"], index: 2 })
  })

  test("respects MAX_NAV_HISTORY upper bound", () => {
    let s: NavHistory = initialNavHistory()
    for (let i = 0; i < MAX_NAV_HISTORY + 5; i++) {
      s = applyPath(s, `/p${i}`)
    }
    expect(s.stack.length).toBe(MAX_NAV_HISTORY)
    expect(s.index).toBe(MAX_NAV_HISTORY - 1)
    expect(s.stack[0]).toBe(`/p${5}`)
    expect(s.stack[s.index]).toBe(`/p${MAX_NAV_HISTORY + 4}`)
  })
})

describe("nav-history > canGoBack / canGoForward", () => {
  test("initial state cannot go back or forward", () => {
    const s = initialNavHistory()
    expect(canGoBack(s)).toBe(false)
    expect(canGoForward(s)).toBe(false)
  })

  test("single entry cannot go back or forward", () => {
    const s = applyPath(initialNavHistory(), "/a")
    expect(canGoBack(s)).toBe(false)
    expect(canGoForward(s)).toBe(false)
  })

  test("after pushing two: can back but not forward", () => {
    let s: NavHistory = initialNavHistory()
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    expect(canGoBack(s)).toBe(true)
    expect(canGoForward(s)).toBe(false)
  })

  test("after going back: can both back and forward at middle", () => {
    let s: NavHistory = initialNavHistory()
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    s = applyPath(s, "/c")
    s = applyPath(s, "/b")
    expect(canGoBack(s)).toBe(true)
    expect(canGoForward(s)).toBe(true)
  })

  test("at oldest entry: cannot back, can forward", () => {
    let s: NavHistory = initialNavHistory()
    s = applyPath(s, "/a")
    s = applyPath(s, "/b")
    s = applyPath(s, "/a")
    expect(canGoBack(s)).toBe(false)
    expect(canGoForward(s)).toBe(true)
  })
})
