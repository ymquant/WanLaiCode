import { beforeEach, describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import {
  clearIssueEvents,
  createIssueReportSnapshot,
  getIssueEvents,
  installIssueReportGlobalListeners,
  issueReportAttachmentFilename,
  promptEditDelta,
  recordIssueAction,
  recordIssueEvent,
  redactText,
  normalizeCommunityPlatform,
  readAsDataUrl,
  sanitizeIssueError,
  setIssueReportSubmitter,
  stableHash,
  submitIssueReport,
  summarizeDroppedText,
  summarizeDragFiles,
  summarizeIssueAttachment,
  summarizePromptParts,
} from "./issue-report-snapshot"

beforeEach(() => {
  clearIssueEvents()
  setIssueReportSubmitter(undefined)
})

describe("issue report snapshot", () => {
  test("redacts obvious private values", () => {
    const redacted = redactText(
      "email a@example.com phone 13800138000 Authorization: Bearer secret-token /Users/developer/code/private.ts https://x.test/a?token=secret",
    )

    expect(redacted).not.toContain("a@example.com")
    expect(redacted).not.toContain("13800138000")
    expect(redacted).not.toContain("secret-token")
    expect(redacted).not.toContain("token=secret")
    expect(redacted).not.toContain("/Users/developer")
    expect(redacted).toContain("[email]")
    expect(redacted).toContain("[phone]")
    expect(redacted).toContain("/[home]/code/private.ts")
  })

  test("sanitizes errors before external reporting", () => {
    const error = new Error("failed for dev@example.com with token=secret at /Users/developer/code/private.ts")
    error.stack = "Error: token=secret\n    at run (/Users/developer/code/private.ts:1:1)"

    const sanitized = sanitizeIssueError(error)
    const serialized = `${sanitized.name}\n${sanitized.message}\n${sanitized.stack}`

    expect(serialized).not.toContain("dev@example.com")
    expect(serialized).not.toContain("token=secret")
    expect(serialized).not.toContain("/Users/developer")
    expect(serialized).toContain("[email]")
    expect(serialized).toContain("/[home]/code/private.ts")
  })

  test("keeps the event buffer bounded and redacted", () => {
    for (let i = 0; i < 125; i += 1) {
      recordIssueAction(`event.${i}`, { token: "secret", email: "dev@example.com" })
    }

    expect(getIssueEvents()).toHaveLength(120)
    expect(getIssueEvents()[0].name).toBe("event.5")
    expect(JSON.stringify(getIssueEvents())).not.toContain("secret")
    expect(JSON.stringify(getIssueEvents())).not.toContain("dev@example.com")
  })

  test("summarizes drag files without reading content", () => {
    const summary = summarizeDragFiles([
      new File(["private file content"], "report.txt", { type: "text/plain", lastModified: 0 }),
    ])

    expect(summary).toMatchObject([
      { index: 0, name_hash: stableHash("report.txt"), ext: "txt", size: 20, type: "text/plain" },
    ])
    expect(summary[0].last_modified).toBeNumber()
    expect(JSON.stringify(summary)).not.toContain("private file content")
    expect(JSON.stringify(summary)).not.toContain("report.txt")
  })

  test("summarizes dropped text without storing the raw content", () => {
    const text = "C:\\Users\\dev\\secret.txt\nprivate file content"
    const summary = summarizeDroppedText(text)

    expect(summary).toMatchObject({
      length: text.length,
      hash: stableHash(text),
      lines: 2,
      truncated: false,
      looks_like_path: true,
    })
    expect(JSON.stringify(summary)).not.toContain("private file content")
  })

  test("summarizes issue attachments with hashed names", () => {
    const file = new File(["png"], "screen-secret.png", { type: "image/png", lastModified: 1 })
    const summary = summarizeIssueAttachment(file)

    expect(summary).toEqual({
      name_hash: stableHash("screen-secret.png"),
      ext: "png",
      size: 3,
      type: "image/png",
    })
    expect(JSON.stringify(summary)).not.toContain("screen-secret.png")
    expect(issueReportAttachmentFilename(file)).toBe(`issue-attachment-${stableHash("screen-secret.png:3:image/png:1")}.png`)
    expect(issueReportAttachmentFilename(file)).not.toContain("screen-secret")
  })

  test("summarizes prompt parts with hashes instead of raw file and agent identifiers", () => {
    const prompt: Prompt = [
      { type: "text", content: "fix ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "plugin", name: "github", addonKey: "plugin:github", content: "@github", start: 10, end: 17 },
      { type: "file", path: "/Users/developer/code/private.ts", content: "@/Users/developer/code/private.ts", start: 17, end: 47 },
      { type: "image", id: "img", filename: "secret.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]
    const summary = summarizePromptParts(prompt)
    const serialized = JSON.stringify(summary)

    expect(summary.counts).toMatchObject({ text: 1, agent: 1, plugin: 1, file: 1, image: 1 })
    expect(serialized).not.toContain("/Users/developer")
    expect(serialized).not.toContain("build")
    expect(serialized).not.toContain("plugin:github")
    expect(serialized).not.toContain("secret.png")
    expect(serialized).toContain(stableHash("/Users/developer/code/private.ts"))
    expect(serialized).toContain(stableHash("build"))
    expect(serialized).toContain(stableHash("plugin:github"))
    expect(serialized).toContain(stableHash("secret.png"))
  })

  test("reports removed structured parts after prompt editor save", () => {
    const before: Prompt = [
      { type: "text", content: "fix ", start: 0, end: 4 },
      { type: "agent", name: "build", content: "@build", start: 4, end: 10 },
      { type: "plugin", name: "github", addonKey: "plugin:github", content: "@github", start: 10, end: 17 },
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 17, end: 28 },
      { type: "image", id: "img", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]

    const delta = promptEditDelta(before, [{ type: "text", content: "fix ", start: 0, end: 4 }])

    expect(delta.removed.map((part) => part.type)).toEqual(["agent", "plugin", "file", "image"])
    expect(JSON.stringify(delta)).not.toContain("src/app.ts")
    expect(JSON.stringify(delta)).not.toContain("plugin:github")
  })

  test("creates a snapshot with recent events and desktop diagnostics", () => {
    recordIssueEvent({
      type: "network",
      name: "request.failed",
      message: "Authorization: Bearer private-token",
      data: { route: "/api/v1/test", cookie: "secret-cookie" },
    })

    const snapshot = createIssueReportSnapshot(
      { platform: "desktop", os: "macos", version: "0.0.0", sentryEnabled: true },
      { renderer_pid: 123 },
    )
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.schema_version).toBe(1)
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.desktop).toEqual({ renderer_pid: 123 })
    expect(serialized).not.toContain("private-token")
    expect(serialized).not.toContain("secret-cookie")
  })

  test("includes redacted current session, project, and branch context", () => {
    const snapshot = createIssueReportSnapshot({
      platform: "desktop",
      context: {
        route: {
          session_id: "ses_current",
        },
        project: {
          name: "Private Project",
          worktree: "/Users/developer/code/private",
        },
        workspace: {
          directory: "C:\\Users\\dev\\private",
          branch: "fix/private-branch",
          default_branch: "main",
        },
      },
    })
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.context?.route).toEqual({ session_id: "ses_current" })
    expect(serialized).toContain("fix/private-branch")
    expect(serialized).not.toContain("/Users/developer")
    expect(serialized).not.toContain("C:\\Users\\dev")
    expect(serialized).toContain("/[home]/code/private")
    expect(serialized).toContain("[path]/private")
  })

  test("redacts circular and deeply nested context safely", () => {
    const circular: Record<string, unknown> = { token: "private-token" }
    circular.self = circular
    const deep = Array.from({ length: 12 }).reduce<Record<string, unknown>>(
      (value) => ({ child: value }),
      { leaf: "/Users/developer/code/private.ts" },
    )

    const snapshot = createIssueReportSnapshot({
      platform: "desktop",
      context: { circular, deep },
    })
    const serialized = JSON.stringify(snapshot)

    expect(serialized).toContain("[circular]")
    expect(serialized).toContain("[max-depth]")
    expect(serialized).not.toContain("private-token")
    expect(serialized).not.toContain("/Users/developer")
  })

  test("redacts nested desktop diagnostics before snapshot serialization", () => {
    const snapshot = createIssueReportSnapshot(
      { platform: "desktop" },
      {
        backend_log_tail: "Authorization: Bearer private-token\nat /Users/developer/code/private.ts",
        renderer: {
          url: "http://localhost:5173/VXNlcnMvamFzaGluL2NvZGUvcHJpdmF0ZQ/session/ses_private?token=private-token",
          title: "dev@example.com",
        },
        main_process_issues: [
          {
            message: "Authorization: Bearer private-token",
            data: { path: "/Users/developer/code/private.ts", token: "secret" },
          },
        ],
      },
    )
    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain("private-token")
    expect(serialized).not.toContain("dev@example.com")
    expect(serialized).not.toContain("/Users/developer")
    expect(serialized).not.toContain("ses_private")
    expect(serialized).toContain("Authorization=[redacted]")
    expect(serialized).toContain("[session:")
  })

  test("encodes attachments as data urls preserving mime type", async () => {
    await expect(readAsDataUrl(new Blob(["hello"], { type: "text/plain" }))).resolves.toBe(
      "data:text/plain;base64,aGVsbG8=",
    )
    await expect(readAsDataUrl(new Blob([JSON.stringify({ a: 1 })], { type: "application/json" }))).resolves.toBe(
      "data:application/json;base64,eyJhIjoxfQ==",
    )
  })

  test("encodes binary attachments without corrupting bytes", async () => {
    const bytes = new Uint8Array(Array.from({ length: 512 }, (_, i) => i % 256))
    const dataUrl = await readAsDataUrl(new Blob([bytes], { type: "application/octet-stream" }))
    expect(dataUrl.startsWith("data:application/octet-stream;base64,")).toBe(true)
    const decoded = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })

  test("maps normalized platform.os values to community platform values", () => {
    expect(normalizeCommunityPlatform("windows", "desktop")).toBe("windows")
    expect(normalizeCommunityPlatform("macos", "desktop")).toBe("macos")
    expect(normalizeCommunityPlatform("linux", "desktop")).toBe("linux")
    expect(normalizeCommunityPlatform(undefined, "web")).toBe("other")
    expect(normalizeCommunityPlatform(undefined, undefined)).toBe("other")
  })

  // darwin 含 win 子串，若先判 win 会被误判成 windows。生产链路传的是已归一化的
  // platform.os，取不到裸 darwin；这条用例锁住子串碰撞的判断顺序，不代表线上场景。
  test("checks mac before win so darwin is not misread as windows", () => {
    expect(normalizeCommunityPlatform("Darwin", undefined)).toBe("macos")
    expect(normalizeCommunityPlatform("darwin", "desktop")).toBe("macos")
    expect(normalizeCommunityPlatform("Windows_NT", undefined)).toBe("windows")
  })

  test("redacts dynamic route identifiers from page metadata", () => {
    const originalLocation = globalThis.location
    const projectRoute = "VXNlcnMvamFzaGluL2NvZGUvcHJpdmF0ZQ"
    const sessionID = "ses_private"
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        href: `https://app.test/${projectRoute}/session/${sessionID}?token=private-token`,
        pathname: `/${projectRoute}/session/${sessionID}`,
      },
    })

    const snapshot = createIssueReportSnapshot({ platform: "desktop" })

    expect(snapshot.page.path).toBe(
      `/[project:${stableHash(projectRoute)}]/session/[session:${stableHash(sessionID)}]`,
    )
    expect(snapshot.page.href).not.toContain(projectRoute)
    expect(snapshot.page.href).not.toContain(sessionID)
    expect(snapshot.page.href).not.toContain("private-token")
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
  })

  test("keeps static desktop entry paths readable", () => {
    const originalLocation = globalThis.location
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        href: "http://localhost:5173/index.html",
        pathname: "/index.html",
      },
    })

    const snapshot = createIssueReportSnapshot({ platform: "desktop" })

    expect(snapshot.page.href).toBe("http://localhost:5173/index.html")
    expect(snapshot.page.path).toBe("/index.html")
    Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation })
  })

  test("skips official upload when no submitter is configured", async () => {
    const result = await submitIssueReport({
      payload: {
        title: "Bug",
        description: "Something failed",
        category: "bug",
        severity: "normal",
        snapshot: createIssueReportSnapshot({ platform: "web" }),
      },
    })

    expect(result).toEqual({ skipped: true })
  })

  test("delegates to the configured submitter with payload and attachments", async () => {
    const calls: { title: string; attachmentCount: number }[] = []
    setIssueReportSubmitter(async ({ payload, attachments }) => {
      calls.push({ title: payload.title, attachmentCount: attachments.length })
      return { skipped: false }
    })

    const result = await submitIssueReport({
      payload: {
        title: "Bug",
        description: "Something failed",
        category: "bug",
        severity: "normal",
        snapshot: createIssueReportSnapshot({ platform: "web" }),
      },
      attachments: [new File(["x"], "a.png", { type: "image/png" })],
    })

    expect(result).toEqual({ skipped: false })
    expect(calls).toEqual([{ title: "Bug", attachmentCount: 1 }])
  })

  test("records failed fetches without query strings or request bodies", async () => {
    const originalFetch = window.fetch
    window.fetch = Object.assign(async () => new Response("private-token", { status: 503 }), originalFetch)
    const cleanup = installIssueReportGlobalListeners()

    await window.fetch("https://api.example.test/v1/items?token=private-token", {
      method: "POST",
      body: "secret request body",
    })

    cleanup()
    window.fetch = originalFetch
    const event = getIssueEvents().find((item) => item.name === "fetch.nonOk")

    expect(event?.data).toMatchObject({
      method: "POST",
      url: "https://api.example.test/v1/items",
      status: 503,
    })
    expect(JSON.stringify(event)).not.toContain("private-token")
    expect(JSON.stringify(event)).not.toContain("secret request body")
  })

  test("records recent frontend console methods", () => {
    const originalLog = console.log
    const originalInfo = console.info
    const originalDebug = console.debug
    console.log = () => undefined
    console.info = () => undefined
    console.debug = () => undefined
    const cleanup = installIssueReportGlobalListeners()

    try {
      console.log("opened", { token: "private-token" })
      console.info("route", "/Users/developer/code/private.ts")
      console.debug("debug message")
    } finally {
      cleanup()
      console.log = originalLog
      console.info = originalInfo
      console.debug = originalDebug
    }
    const names = getIssueEvents().map((item) => item.name)
    const serialized = JSON.stringify(getIssueEvents())

    expect(names).toContain("console.log")
    expect(names).toContain("console.info")
    expect(names).toContain("console.debug")
    expect(serialized).not.toContain("private-token")
    expect(serialized).not.toContain("/Users/developer")
  })

  test("does not throw when console receives circular objects", () => {
    const originalLog = console.log
    console.log = () => undefined
    const cleanup = installIssueReportGlobalListeners()
    const circular: Record<string, unknown> = { token: "private-token" }
    circular.self = circular

    try {
      expect(() => console.log("cycle", circular)).not.toThrow()
    } finally {
      cleanup()
      console.log = originalLog
    }
    const event = getIssueEvents().find((item) => item.name === "console.log")
    const serialized = JSON.stringify(event)

    expect(event?.message).toContain("[circular]")
    expect(serialized).not.toContain("private-token")
  })

  test("hashes dynamic network path segments", async () => {
    const originalFetch = window.fetch
    window.fetch = Object.assign(async () => new Response("", { status: 404 }), originalFetch)
    const cleanup = installIssueReportGlobalListeners()

    await window.fetch("https://api.example.test/api/v1/session/ses_private?token=private-token")

    cleanup()
    window.fetch = originalFetch
    const event = getIssueEvents().find((item) => item.name === "fetch.nonOk")

    expect(event?.data?.url).toBe(`https://api.example.test/api/v1/session/[id:${stableHash("ses_private")}]`)
    expect(JSON.stringify(event)).not.toContain("ses_private")
    expect(JSON.stringify(event)).not.toContain("private-token")
  })
})
