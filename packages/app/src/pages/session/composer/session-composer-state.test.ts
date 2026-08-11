import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { goalModeActive, todoState } from "./session-goal-state"
import {
  sessionPermissionRequest,
  sessionQuestionRequest,
  withoutPermission,
  withoutQuestion,
} from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("withoutPermission", () => {
  test("removes only the matching permission", () => {
    const list = [permission("perm-a", "s"), permission("perm-b", "s")]
    expect(withoutPermission(list, "perm-a").map((p) => p.id)).toEqual(["perm-b"])
  })

  test("idempotent when the id is absent (orphan re-click)", () => {
    const list = [permission("perm-b", "s")]
    expect(withoutPermission(list, "perm-a").map((p) => p.id)).toEqual(["perm-b"])
  })

  test("handles an undefined list", () => {
    expect(withoutPermission(undefined, "perm-a")).toEqual([])
  })
})

describe("withoutQuestion", () => {
  test("removes only the matching question", () => {
    const list = [question("q-a", "s"), question("q-b", "s")]
    expect(withoutQuestion(list, "q-a").map((q) => q.id)).toEqual(["q-b"])
  })

  test("idempotent when the id is absent", () => {
    const list = [question("q-b", "s")]
    expect(withoutQuestion(list, "q-a").map((q) => q.id)).toEqual(["q-b"])
  })

  test("handles an undefined list", () => {
    expect(withoutQuestion(undefined, "q-a")).toEqual([])
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  // 之前 !live 会返回 "clear" 把 globalSync.session_todo 整段擦掉，
  // 在 SessionDetailsCard 接管渲染后这是不期望的——agent idle 后应保留列表。
  test("keeps incomplete todos visible after the turn ends (no longer clears)", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("open")
  })

  test("closes completed todos when the session is no longer live (no longer clears)", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("close")
  })
})

describe("goalModeActive", () => {
  test("inactive without goal and without pending objective", () => {
    expect(goalModeActive({ goal: undefined, pendingObjective: undefined })).toBe(false)
  })

  test("active while composing a new objective", () => {
    expect(goalModeActive({ goal: undefined, pendingObjective: "" })).toBe(true)
  })

  test("active when a goal exists", () => {
    expect(goalModeActive({ goal: { status: "active" } as never, pendingObjective: undefined })).toBe(true)
  })

  test("inactive when goal is complete (dock hidden)", () => {
    expect(goalModeActive({ goal: { status: "complete" } as never, pendingObjective: undefined })).toBe(false)
  })
})
