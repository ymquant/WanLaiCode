import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect } from "effect"

import { EffectBridge } from "@/effect/bridge"
import { Permission } from "@/permission"
import { PermissionMode } from "@/permission/mode"
import { ApprovalReviewer } from "@/session/approval-reviewer"
import { PermissionID } from "@/permission/schema"
import { SessionID } from "@/session/schema"

test("regular tool EffectBridge inherits the turn mode and reviewer", async () => {
  const reviewer: Permission.Reviewer = () =>
    Effect.succeed({
      decision: "approve",
      risk: "low",
      reason: "turn reviewer",
      providerID: "wanlaicode",
      modelID: "deepseek-v4-flash",
      halt: false,
    })
  const request = new Permission.Request({
    id: PermissionID.ascending(),
    sessionID: SessionID.make("session_effect_bridge"),
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    always: [],
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const regularTool = tool({
        inputSchema: jsonSchema<{ command: string }>({
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        }),
        execute: () =>
          bridge.promise(
            Effect.gen(function* () {
              const inherited = yield* Permission.ReviewerRef
              return {
                mode: yield* PermissionMode.Ref,
                decision: inherited ? (yield* inherited({ request, ruleset: [] })).decision : "missing",
              }
            }),
          ),
      })
      if (!regularTool.execute) throw new Error("regular tool is not executable")
      const execute = regularTool.execute as unknown as (
        input: { command: string },
        options: { toolCallId: string; messages: [] },
      ) => Promise<{ mode: PermissionMode.Info; decision: string }>
      return yield* Effect.promise(() => execute({ command: "ls" }, { toolCallId: "call_test", messages: [] }))
    }).pipe(ApprovalReviewer.provideContext({ mode: "auto_review", reviewer })),
  )

  expect(result).toEqual({ mode: "auto_review", decision: "approve" })
})

test("run loop applies the bridge-tested context to regular tool resolution and processing", async () => {
  const source = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
  // 锚定当前 execution 执行块，确保工具解析与处理始终处于同一个审批上下文中。
  const execution = source.indexOf('const execution: Effect.Effect<"break" | "continue"> = Effect.gen')
  const resolveTools = source.indexOf("const tools = yield* resolveTools", execution)
  const provider = source.indexOf("ApprovalReviewer.provideContext({", resolveTools)
  const latestMode = source.indexOf("mode: PermissionMode.resolve(approvalConfig.permission_mode)", provider)

  expect(execution).toBeGreaterThan(-1)
  expect(resolveTools).toBeGreaterThan(execution)
  expect(provider).toBeGreaterThan(resolveTools)
  expect(latestMode).toBeGreaterThan(provider)
})

test("stops only when the reviewer denial breaker is set", async () => {
  const source = await Bun.file(new URL("../../src/session/processor.ts", import.meta.url)).text()
  expect(source).toContain("error instanceof Permission.ReviewDeniedError && error.halt")
  expect(source).toContain("ctx.blocked = true")
})

test("records auto-review outcomes on the tool part and preserves them through completion", async () => {
  const prompt = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
  const processor = await Bun.file(new URL("../../src/session/processor.ts", import.meta.url)).text()

  expect(prompt).toContain("onReview: (review) =>")
  expect(prompt).toContain("applyToolPermissionReview(match, review)")
  expect(prompt).toContain(
    'mergeToolMetadata(match.state.status === "running" ? match.state.metadata : undefined, val.metadata)',
  )
  expect(processor).toContain("mergeToolMetadata(match.part.state.metadata, output.metadata)")
})
