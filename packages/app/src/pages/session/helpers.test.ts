import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  consumeSessionSyncDebugError,
  runSessionSyncAutoRetry,
  runSessionSyncRetry,
  runStateTimerShouldRun,
  sessionMessageRenderState,
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  getTabReorderIndex,
  shouldFocusTerminalOnKeyDown,
} from "./helpers"

describe("runStateTimerShouldRun", () => {
  // 「有活才起表」：跟仓库既有四份同用途定时器（session.tsx / sidebar-items.tsx 等）保持
  // 同一守卫语义 —— status 还没加载完，且没有任何未收尾 assistant 时，不需要起 1Hz 定时器。
  test("status 未加载且没有未收尾 assistant 时不起表", () => {
    const messages = [
      { role: "assistant", time: { created: 0, completed: 1 } },
    ] as Pick<Message, "role" | "time">[]
    expect(runStateTimerShouldRun({ statusLoaded: false, messages })).toBe(false)
  })

  test("status 已加载(哪怕已经是 idle)时起表，后续事件仍可能翻转", () => {
    expect(runStateTimerShouldRun({ statusLoaded: true, messages: [] })).toBe(true)
  })

  test("status 未加载但存在未收尾 assistant 时仍要起表", () => {
    const messages = [{ role: "assistant", time: { created: 0 } }] as Pick<Message, "role" | "time">[]
    expect(runStateTimerShouldRun({ statusLoaded: false, messages })).toBe(true)
  })

  test("没有消息、status 也未加载时不起表", () => {
    expect(runStateTimerShouldRun({ statusLoaded: false, messages: [] })).toBe(false)
  })
})

describe("sessionMessageRenderState", () => {
  test("keeps rendering cached messages when sync fails", () => {
    expect(sessionMessageRenderState({ messagesReady: true, syncError: new Error("sync failed") })).toEqual({
      timeline: true,
      staleError: true,
      loading: false,
      blockingError: false,
    })
  })

  test("blocks only when sync fails before messages are available", () => {
    expect(sessionMessageRenderState({ messagesReady: false, syncError: new Error("sync failed") })).toEqual({
      timeline: false,
      staleError: false,
      loading: false,
      blockingError: true,
    })
  })

  test("shows loading before messages are available without sync error", () => {
    expect(sessionMessageRenderState({ messagesReady: false, syncError: undefined })).toEqual({
      timeline: false,
      staleError: false,
      loading: true,
      blockingError: false,
    })
  })
})

describe("runSessionSyncRetry", () => {
  test("forces sync before clearing the resource error", async () => {
    const calls: unknown[] = []

    await runSessionSyncRetry({
      sessionID: "ses_123",
      sync: async (sessionID, opts) => calls.push([sessionID, opts]),
      refetch: () => calls.push("refetch"),
    })

    expect(calls).toEqual([["ses_123", { force: true }], "refetch"])
  })

  test("keeps the resource error when forced sync fails", async () => {
    const calls: unknown[] = []

    await expect(
      runSessionSyncRetry({
        sessionID: "ses_123",
        sync: async () => {
          calls.push("sync")
          throw new Error("sync failed")
        },
        refetch: () => calls.push("refetch"),
      }),
    ).rejects.toThrow("sync failed")

    expect(calls).toEqual(["sync"])
  })

  test("does not clear the resource error after switching sessions during retry", async () => {
    const calls: unknown[] = []

    await runSessionSyncRetry({
      sessionID: "ses_123",
      activeSessionID: () => "ses_other",
      sync: async (sessionID, opts) => calls.push([sessionID, opts]),
      refetch: () => calls.push("refetch"),
    })

    expect(calls).toEqual([["ses_123", { force: true }]])
  })

  test("does not force sync when debug injection fails first", async () => {
    const calls: unknown[] = []

    await expect(
      runSessionSyncRetry({
        sessionID: "ses_123",
        beforeSync: () => {
          calls.push("beforeSync")
          throw new Error("debug session sync error")
        },
        sync: async () => calls.push("sync"),
        refetch: () => calls.push("refetch"),
      }),
    ).rejects.toThrow("debug session sync error")

    expect(calls).toEqual(["beforeSync"])
  })
})

describe("runSessionSyncAutoRetry", () => {
  test("keeps retrying after failed attempts until one succeeds", async () => {
    const calls: string[] = []

    await runSessionSyncAutoRetry({
      sessionID: "ses_123",
      delays: [0, 0, 0],
      sleep: async () => undefined,
      retry: async () => {
        calls.push("retry")
        if (calls.length < 3) throw new Error("sync failed")
      },
    })

    expect(calls).toEqual(["retry", "retry", "retry"])
  })

  test("stops retrying when the session changes", async () => {
    const calls: string[] = []

    await runSessionSyncAutoRetry({
      sessionID: "ses_123",
      delays: [0, 0, 0],
      activeSessionID: () => "ses_other",
      sleep: async () => undefined,
      retry: async () => calls.push("retry"),
    })

    expect(calls).toEqual([])
  })
})

describe("consumeSessionSyncDebugError", () => {
  test("decrements debug failures until they are exhausted", () => {
    const values = new Map([["debug-sync-error", "2"]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }

    expect(consumeSessionSyncDebugError({ enabled: true, storage })).toBe(true)
    expect(values.get("debug-sync-error")).toBe("1")
    expect(consumeSessionSyncDebugError({ enabled: true, storage })).toBe(true)
    expect(values.has("debug-sync-error")).toBe(false)
    expect(consumeSessionSyncDebugError({ enabled: true, storage })).toBe(false)
  })

  test("does not consume debug failures outside dev mode", () => {
    const values = new Map([["debug-sync-error", "1"]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }

    expect(consumeSessionSyncDebugError({ enabled: false, storage })).toBe(false)
    expect(values.get("debug-sync-error")).toBe("1")
  })

  test("clears invalid debug failure values without throwing", () => {
    const values = new Map([["debug-sync-error", "invalid"]])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }

    expect(consumeSessionSyncDebugError({ enabled: true, storage })).toBe(false)
    expect(values.has("debug-sync-error")).toBe(false)
  })
})

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })

  test("activates non-file tabs without loading review content", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return value
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return undefined
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("context")

    expect(calls).toEqual(["normalize:context", "open:context", "path:context", "active:context"])
  })

  test("keeps external absolute file tabs stable", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return value
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.startsWith("file://") ? tab.slice("file://".length) : undefined
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("file:///Users/developer/.codex/skills/skill-creator/SKILL.md", { preview: true })

    expect(calls).toEqual([
      "normalize:file:///Users/developer/.codex/skills/skill-creator/SKILL.md",
      "open:file:///Users/developer/.codex/skills/skill-creator/SKILL.md",
      "path:file:///Users/developer/.codex/skills/skill-creator/SKILL.md",
      "load:/Users/developer/.codex/skills/skill-creator/SKILL.md",
      "review",
      "active:file:///Users/developer/.codex/skills/skill-creator/SKILL.md",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("shouldFocusTerminalOnKeyDown", () => {
  test("skips pure modifier keys", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBe(false)
  })

  test("skips shortcut key combos", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }))).toBe(false)
  })

  test("keeps plain typing focused on terminal", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "a" }))).toBe(true)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "A", shiftKey: true }))).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      expect(result.closableTab()).toBe("context")
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })
})
