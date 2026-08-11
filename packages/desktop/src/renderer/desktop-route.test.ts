import { describe, expect, test } from "bun:test"
import { desktopAddressForRoute, desktopRouteFromLocation } from "./desktop-route"

// 这些测试覆盖桌面端刷新时的根路由规范化和会话深链持久化。
describe("desktop route persistence", () => {
  test("normalizes the Electron index entry to the root route", () => {
    expect(desktopRouteFromLocation("/index.html")).toBe("/")
    expect(desktopRouteFromLocation("/index.html", "?prompt=hello", "#message")).toBe("/?prompt=hello#message")
  })

  test("keeps session deep links across renderer refreshes", () => {
    const route = "/L3ByaXZhdGUvdG1wL3Byb2plY3Q/session/ses_test"
    expect(desktopRouteFromLocation(route)).toBe(route)
    expect(desktopAddressForRoute(route, "/index.html")).toBe(route)
  })

  test("keeps the packaged index entry for the root route", () => {
    expect(desktopAddressForRoute("/", "/index.html")).toBe("/index.html")
    expect(desktopAddressForRoute("/", "/")).toBe("/")
    expect(desktopAddressForRoute("/?prompt=hello", "/index.html")).toBe("/index.html?prompt=hello")
  })
})
