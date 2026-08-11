import { describe, expect, test } from "bun:test"
import { createPromptResetBridge } from "@/context/prompt-reset"
import { newSessionHref, openNewSession } from "@/utils/new-session"

describe("new session navigation", () => {
  test("resets the workspace prompt before navigation", () => {
    const calls: string[] = []

    openNewSession({
      slug: "workspace-slug",
      reset: (slug) => calls.push(`reset:${slug}`),
      navigate: (href) => calls.push(`navigate:${href}`),
    })

    expect(calls).toEqual(["reset:workspace-slug", "navigate:/workspace-slug/session"])
  })

  test("preserves deep link prompt handoff in the new session URL", () => {
    expect(newSessionHref("workspace-slug", "hello world")).toBe("/workspace-slug/session?prompt=hello%20world")
  })
})

describe("prompt reset bridge", () => {
  test("keeps pending resets before provider mounts", () => {
    const bridge = createPromptResetBridge()
    const resets: string[] = []

    bridge.reset("workspace-a")
    bridge.reset("workspace-a")
    bridge.reset("workspace-b")
    bridge.register((dir) => resets.push(`${dir}:__workspace__`))

    expect(resets).toEqual(["workspace-a:__workspace__", "workspace-b:__workspace__"])

    bridge.reset("workspace-c")

    expect(resets).toEqual(["workspace-a:__workspace__", "workspace-b:__workspace__", "workspace-c:__workspace__"])
  })

  test("queues resets again after provider cleanup", () => {
    const bridge = createPromptResetBridge()
    const resets: string[] = []

    bridge.register((dir) => resets.push(`first:${dir}`))
    bridge.reset("workspace-a")
    bridge.clear()
    bridge.reset("workspace-b")

    expect(resets).toEqual(["first:workspace-a"])

    bridge.register((dir) => resets.push(`second:${dir}`))

    expect(resets).toEqual(["first:workspace-a", "second:workspace-b"])
  })
})

describe("session new reset entrypoints", () => {
  test("global and project new chat reset before navigation with base64 scope", async () => {
    const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()

    expect(source).toContain("openNewSession({")
    expect(source).toContain("slug: base64Encode(project.worktree)")
    expect(source).toContain("slug: base64Encode(scratch)")
    expect(source).toContain("slug: base64Encode(dir)")
    expect(source).toContain("navigate: navigateWithSidebarReset")
  })

  test("workspace new session resets prompt before navigation", async () => {
    const source = await Bun.file(new URL("./layout/sidebar-workspace.tsx", import.meta.url)).text()

    expect(source).toContain("openNewSessionRoute({ slug: slug(), reset: resetPromptDraft, navigate })")
  })

  test("session new command resets prompt before navigating", async () => {
    const source = await Bun.file(new URL("./session/use-session-commands.tsx", import.meta.url)).text()

    expect(source).toContain("prompt.reset({ dir: params.dir })")
    expect(source).toContain("navigate(`/${params.dir}/session`)")
  })

  test("NewSessionItem in sidebar resets prompt with correct scope", async () => {
    const source = await Bun.file(new URL("./layout/sidebar-items.tsx", import.meta.url)).text()

    expect(source).toContain("resetPromptDraft(props.slug)")
    expect(source).toContain("clearHoverProjectSoon()")
  })

  test("project picker new session paths reuse reset navigation", async () => {
    const source = await Bun.file(new URL("../components/prompt-input.tsx", import.meta.url)).text()

    expect(source).toContain("openNewSession({ slug: base64Encode(worktree), reset: resetPromptDraft, navigate })")
    expect(source).toContain("openNewSession({ slug: base64Encode(scratch), reset: resetPromptDraft, navigate })")
  })
})
