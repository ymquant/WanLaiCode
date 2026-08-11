import { describe, expect, test } from "bun:test"
import { parseSessionId, parseSessionRoute, resolveSessionId } from "./session-route"

describe("parseSessionId", () => {
  // 具体会话路由由常驻目录布局渲染，解析必须覆盖 URL 的会话段。
  test("从具体会话 URL 解析 ID", () => {
    expect(parseSessionId("/workspace/session/ses_a")).toBe("ses_a")
    expect(parseSessionId("/workspace/session/ses_a?tab=chat#latest")).toBe("ses_a")
  })

  test("新建会话 URL 不产生会话 ID", () => {
    expect(parseSessionId("/workspace/session")).toBeUndefined()
    expect(parseSessionId("/workspace/session/")).toBeUndefined()
  })

  test("识别新建会话路由，避免沿用旧的动态参数", () => {
    expect(parseSessionRoute("/workspace/session")).toEqual({ matched: true, id: undefined })
    expect(parseSessionRoute("/workspace/projects")).toEqual({ matched: false, id: undefined })
  })

  test("当前会话 URL 优先于常驻路由残留参数", () => {
    expect(resolveSessionId("/workspace/session/ses_current", "ses_stale")).toBe("ses_current")
    expect(resolveSessionId("/workspace/session", "ses_stale")).toBeUndefined()
    expect(resolveSessionId("/workspace/projects", "ses_parent")).toBe("ses_parent")
  })
})
