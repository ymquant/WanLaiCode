import { describe, expect, test } from "bun:test"
import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { Cause, Effect, Exit, Fiber } from "effect"

import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ApprovalReviewer } from "@/session/approval-reviewer"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { PermissionID } from "@/permission/schema"

const sessionID = SessionID.descending()

function message(
  role: "user" | "assistant",
  text: string,
  options?: { synthetic?: boolean; ignored?: boolean; reasoning?: string },
): MessageV2.WithParts {
  const id = MessageID.ascending()
  const info =
    role === "user"
      ? {
          id,
          sessionID,
          role,
          time: { created: 0 },
          agent: "build",
          model: { providerID: ProviderID.make("wanlaicode"), modelID: ModelID.make("deepseek-v4-pro") },
        }
      : {
          id,
          sessionID,
          role,
          time: { created: 0, completed: 0 },
          parentID: MessageID.ascending(),
          modelID: ModelID.make("deepseek-v4-pro"),
          providerID: ProviderID.make("wanlaicode"),
          mode: "build",
          agent: "build",
          path: { cwd: "/repo", root: "/repo" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
  return {
    info,
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text,
        synthetic: options?.synthetic,
        ignored: options?.ignored,
      },
      ...(options?.reasoning
        ? [
            {
              id: PartID.ascending(),
              sessionID,
              messageID: id,
              type: "reasoning" as const,
              text: options.reasoning,
              time: { start: 0 },
            },
          ]
        : []),
    ],
  } as MessageV2.WithParts
}

describe("ApprovalReviewer.visibleTranscript", () => {
  test("keeps only the eight newest visible entries and excludes hidden content", () => {
    const transcript = ApprovalReviewer.visibleTranscript([
      message("user", "credential sk-ant-oldest"),
      ...Array.from({ length: 9 }, (_, index) => message(index % 2 ? "assistant" : "user", `visible-${index}`)),
      message("assistant", "synthetic-secret", { synthetic: true }),
      message("user", "ignored-secret", { ignored: true }),
      message("assistant", "latest-visible", { reasoning: "hidden-chain-of-thought" }),
    ])

    expect(transcript).not.toContain("credential sk-ant-oldest")
    expect(transcript).not.toContain("visible-0")
    expect(transcript).not.toContain("visible-1")
    expect(transcript).not.toContain("synthetic-secret")
    expect(transcript).not.toContain("ignored-secret")
    expect(transcript).not.toContain("hidden-chain-of-thought")
    expect(transcript).toContain("visible-2")
    expect(transcript).toContain("latest-visible")
    expect(transcript.match(/^\[(user|assistant)\]/gm)).toHaveLength(8)
  })

  test("caps the transcript at 16 KiB while retaining the newest content", () => {
    const transcript = ApprovalReviewer.visibleTranscript([
      message("user", `old-${"a".repeat(12_000)}`),
      message("assistant", `new-${"b".repeat(12_000)}`),
    ])

    expect(new TextEncoder().encode(transcript).byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(transcript).toContain("new-")
  })

  test("redacts credentials from visible messages", () => {
    const transcript = ApprovalReviewer.visibleTranscript([
      message("user", "Use API_KEY=credential-visible and Authorization: Bearer bearer-visible"),
    ])

    expect(transcript).not.toContain("credential-visible")
    expect(transcript).not.toContain("bearer-visible")
    expect(transcript).toContain("[redacted]")
  })

  test("redacts prefixed environment credentials and GitHub tokens from visible messages", () => {
    const transcript = ApprovalReviewer.visibleTranscript([
      message(
        "user",
        "Use AWS_SECRET_ACCESS_KEY=transcript-environment-secret and ghp_notarealtoken",
      ),
    ])

    expect(transcript).not.toContain("transcript-environment-secret")
    expect(transcript).not.toContain("ghp_notarealtoken")
    expect(transcript.match(/\[redacted\]/g)).toHaveLength(2)
  })
})

test("reviewPrompt includes approved request context without environment metadata", () => {
  const prompt = ApprovalReviewer.reviewPrompt({
    messages: [message("user", "I authorize running bun test for this task")],
    directory: "/repo/package",
    worktree: "/repo",
    request: new Permission.Request({
      id: PermissionID.ascending(),
      sessionID,
      permission: "bash",
      patterns: ["bun test test/session/approval-reviewer.test.ts", "TOKEN=pattern-credential command"],
      metadata: {
        description: "run focused tests",
        environment: { WANLAICODE_API_KEY: "credential-must-not-leak" },
        irrelevant: "not-approved",
      },
      always: ["bun test *"],
    }),
    ruleset: [{ permission: "bash", pattern: "bun test *", action: "ask" }],
  })

  expect(prompt).toContain('"permission": "bash"')
  expect(prompt).toContain("bun test test/session/approval-reviewer.test.ts")
  expect(prompt).toContain('"directory": "/repo/package"')
  expect(prompt).toContain('"worktree": "/repo"')
  expect(prompt).toContain('"ruleset"')
  expect(prompt).toContain("I authorize running bun test for this task")
  expect(prompt).not.toContain("credential-must-not-leak")
  expect(prompt).not.toContain("pattern-credential")
  expect(prompt).not.toContain("environment")
  expect(prompt).not.toContain("not-approved")
})

test("reviewPrompt redacts prefixed environment credentials and GitHub tokens from permission patterns", () => {
  const prompt = ApprovalReviewer.reviewPrompt({
    messages: [],
    directory: "/repo/package",
    worktree: "/repo",
    request: new Permission.Request({
      id: PermissionID.ascending(),
      sessionID,
      permission: "bash",
      patterns: [
        "WANLAICODE_API_KEY=permission-environment-secret command",
        "DATABASE_PASSWORD=permission-password-secret command",
        "command github_pat_notarealtoken",
      ],
      metadata: {},
      always: [],
    }),
    ruleset: [],
  })

  expect(prompt).not.toContain("permission-environment-secret")
  expect(prompt).not.toContain("permission-password-secret")
  expect(prompt).not.toContain("github_pat_notarealtoken")
  expect(prompt.match(/\[redacted\]/g)).toHaveLength(3)
})

test("reviewPrompt redacts prefixed environment credentials and GitHub tokens from ruleset patterns", () => {
  const prompt = ApprovalReviewer.reviewPrompt({
    messages: [],
    directory: "/repo/package",
    worktree: "/repo",
    request: new Permission.Request({
      id: PermissionID.ascending(),
      sessionID,
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    }),
    ruleset: [
      { permission: "bash", pattern: "DEPLOY_TOKEN=ruleset-environment-secret command", action: "ask" },
      { permission: "bash", pattern: "command ghp_notarealtoken", action: "ask" },
    ],
  })

  expect(prompt).not.toContain("ruleset-environment-secret")
  expect(prompt).not.toContain("ghp_notarealtoken")
  expect(prompt.match(/\[redacted\]/g)).toHaveLength(2)
})

function modelOutput(outputs: string[], calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "wanlaicode",
    modelId: "deepseek-v4-flash",
    supportedUrls: {},
    doGenerate(options) {
      calls.push(options)
      const text = outputs.shift()
      if (!text) throw new Error("missing test output")
      return Promise.resolve({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      })
    },
    doStream() {
      throw new Error("streaming is not expected")
    },
  }
}

function reviewerFixture(outputs: string[]) {
  const calls: LanguageModelV3CallOptions[] = []
  const small = {
    id: ModelID.make("deepseek-v4-flash"),
    providerID: ProviderID.make("wanlaicode"),
  } as Provider.Model
  const selections: Array<{ providerID: ProviderID; options?: { sameProvider?: boolean } }> = []
  const provider = {
    getSmallModel(providerID: ProviderID, options?: { sameProvider?: boolean }) {
      selections.push({ providerID, options })
      return Effect.succeed(small)
    },
    getLanguage() {
      return Effect.succeed(modelOutput(outputs, calls))
    },
  } as unknown as Provider.Interface
  const request = new Permission.Request({
    id: PermissionID.ascending(),
    sessionID,
    permission: "bash",
    patterns: ["bun test"],
    metadata: {},
    always: [],
  })
  const reviewer = ApprovalReviewer.make({
    state: ApprovalReviewer.state(),
    provider,
    model: { ...small, id: ModelID.make("deepseek-v4-pro") },
    messages: [message("user", "please run the focused tests")],
    directory: "/repo/package",
    worktree: "/repo",
    fallbackToMainModel: false,
  })
  return { calls, request, reviewer, selections }
}

function fallbackFixture(input: {
  enabled: boolean
  smallModelID?: string
  mainModelID?: string
  noSmallModel?: boolean
  failMainModel?: boolean
  smallOutput?: string
}) {
  const calls: string[] = []
  const small = {
    id: ModelID.make(input.smallModelID ?? "deepseek-v4-flash"),
    providerID: ProviderID.make("wanlaicode"),
  } as Provider.Model
  const main = {
    id: ModelID.make(input.mainModelID ?? "deepseek-v4-pro"),
    providerID: ProviderID.make("wanlaicode"),
  } as Provider.Model
  const provider = {
    getSmallModel: () => Effect.succeed(input.noSmallModel ? undefined : small),
    getLanguage(model: Provider.Model) {
      calls.push(String(model.id))
      if (model.id === small.id) {
        if (input.smallOutput) return Effect.succeed(modelOutput([input.smallOutput], []))
        return Effect.succeed({
          specificationVersion: "v3",
          provider: "wanlaicode",
          modelId: String(model.id),
          supportedUrls: {},
          doGenerate() {
            throw new APICallError({
              message: "small model unavailable",
              url: "https://example.invalid/review",
              requestBodyValues: {},
              statusCode: 503,
            })
          },
          doStream() {
            throw new Error("streaming is not expected")
          },
        } satisfies LanguageModelV3)
      }
      if (!input.failMainModel) {
        return Effect.succeed(modelOutput(['{"action":"low","reason":"main model fallback"}'], []))
      }
      return Effect.succeed({
        specificationVersion: "v3",
        provider: "wanlaicode",
        modelId: String(model.id),
        supportedUrls: {},
        doGenerate() {
          throw new Error("main model unavailable")
        },
        doStream() {
          throw new Error("streaming is not expected")
        },
      } satisfies LanguageModelV3)
    },
  } as unknown as Provider.Interface
  return {
    calls,
    request: new Permission.Request({
      id: PermissionID.ascending(),
      sessionID,
      permission: "bash",
      patterns: ["bun test"],
      metadata: {},
      always: [],
    }),
    reviewer: ApprovalReviewer.make({
      state: ApprovalReviewer.state(),
      provider,
      model: main,
      messages: [],
      directory: "/repo/package",
      worktree: "/repo",
      fallbackToMainModel: input.enabled,
    }),
  }
}

test("main-model fallback defaults to enabled", () => {
  expect(ApprovalReviewer.resolveMainModelFallback(undefined)).toBe(true)
  expect(ApprovalReviewer.resolveMainModelFallback(false)).toBe(false)
})

test("reviewer falls back to the current session model when the small model is unavailable", async () => {
  const fixture = fallbackFixture({ enabled: true })

  const result = await Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))

  expect(result).toMatchObject({
    decision: "approve",
    providerID: "wanlaicode",
    modelID: "deepseek-v4-pro",
    reason: "main model fallback",
  })
  expect(fixture.calls).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"])
})

test("reviewer does not use the main model when fallback is disabled", async () => {
  const fixture = fallbackFixture({ enabled: false })

  await expect(Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))).rejects.toBeDefined()
  expect(fixture.calls).toEqual(["deepseek-v4-flash"])
})

test("reviewer does not retry when the small model is already the current session model", async () => {
  const fixture = fallbackFixture({ enabled: true, mainModelID: "deepseek-v4-flash" })

  await expect(Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))).rejects.toBeDefined()
  expect(fixture.calls).toEqual(["deepseek-v4-flash"])
})

test("reviewer uses the current session model when no same-provider small model exists", async () => {
  const fixture = fallbackFixture({ enabled: true, noSmallModel: true })

  const result = await Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))

  expect(result.modelID).toBe("deepseek-v4-pro")
  expect(fixture.calls).toEqual(["deepseek-v4-pro"])
})

test("reviewer fails for manual approval when both small and current session models are unavailable", async () => {
  const fixture = fallbackFixture({ enabled: true, failMainModel: true })

  await expect(Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))).rejects.toBeDefined()
  expect(fixture.calls).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"])
})

test("reviewer falls back when the small model returns an invalid review payload", async () => {
  const fixture = fallbackFixture({
    enabled: true,
    smallOutput: '{"action":"unknown","reason":"invalid risk"}',
  })

  const result = await Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))

  expect(result.modelID).toBe("deepseek-v4-pro")
  expect(fixture.calls).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"])
})

test("reviewer honors a valid high-risk classification without calling the current session model", async () => {
  const fixture = fallbackFixture({
    enabled: true,
    smallOutput: `{"action":"high","reason":"shared remote side effect"}`,
  })

  const result = await Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))

  expect(result).toMatchObject({
    decision: "ask_user",
    risk: "high",
    modelID: "deepseek-v4-flash",
  })
  expect(fixture.calls).toEqual(["deepseek-v4-flash"])
})

test("reviewer derives approval solely from the classified risk", async () => {
  const fixture = reviewerFixture([
    `{"action":"low","risk":"critical","decision":"deny","reason":"read-only status inspection"}`,
    `{"action":"medium","reason":"recoverable workspace edit"}`,
    `{"action":"high","reason":"writes to a shared remote"}`,
    `{"action":"critical","reason":"irreversible production deletion"}`,
  ])

  const results = await Promise.all(
    Array.from({ length: 4 }, () => Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))),
  )

  expect(results.map((result) => ({ decision: result.decision, risk: result.risk, halt: result.halt }))).toEqual([
    { decision: "approve", risk: "low", halt: false },
    { decision: "approve", risk: "medium", halt: false },
    { decision: "ask_user", risk: "high", halt: false },
    { decision: "ask_user", risk: "critical", halt: false },
  ])
  expect(fixture.selections).toEqual(
    Array.from({ length: 4 }, () => ({
      providerID: ProviderID.make("wanlaicode"),
      options: { sameProvider: true },
    })),
  )
  expect(fixture.calls.every((call) => call.maxOutputTokens === 512 && !call.tools)).toBe(true)
  const prompt = JSON.stringify(fixture.calls[0]?.prompt)
  expect(prompt).toContain("Do not raise risk because authorization is ambiguous or context is incomplete.")
  expect(prompt).toContain("Low risk: read-only and observational operations")
  expect(prompt).toContain("Medium risk: recoverable operations limited to the current workspace")
  expect(prompt).toContain("High risk: operations with external, shared, system-wide, or broad destructive effects")
  expect(prompt).toContain("Critical risk: operations that can cause irreversible or major loss")
  expect(prompt).toContain("action must be one of")
  expect(prompt).not.toContain("Approve only when the visible user authorization")
  expect(prompt).not.toContain("approve, deny, or ask_user")
})

test("reviewer disables AI SDK retries", async () => {
  let calls = 0
  const fixture = reviewerFixture([])
  const provider = {
    getSmallModel: () =>
      Effect.succeed({
        id: ModelID.make("deepseek-v4-flash"),
        providerID: ProviderID.make("wanlaicode"),
      } as Provider.Model),
    getLanguage: () =>
      Effect.succeed({
        specificationVersion: "v3",
        provider: "wanlaicode",
        modelId: "deepseek-v4-flash",
        supportedUrls: {},
        doGenerate() {
          calls += 1
          throw new APICallError({
            message: "retryable review failure",
            url: "https://example.invalid/review",
            requestBodyValues: {},
            statusCode: 503,
          })
        },
        doStream() {
          throw new Error("streaming is not expected")
        },
      } satisfies LanguageModelV3),
  } as unknown as Provider.Interface
  const reviewer = ApprovalReviewer.make({
    state: ApprovalReviewer.state(),
    provider,
    model: { id: ModelID.make("deepseek-v4-pro"), providerID: ProviderID.make("wanlaicode") } as Provider.Model,
    messages: [],
    directory: "/repo/package",
    worktree: "/repo",
    fallbackToMainModel: false,
  })

  await expect(Effect.runPromise(reviewer({ request: fixture.request, ruleset: [] }))).rejects.toBeDefined()
  expect(calls).toBe(1)
}, 10_000)

test("reviewer aborts the underlying model call when its Effect is interrupted", async () => {
  let signal: AbortSignal | undefined
  const fixture = reviewerFixture([])
  const provider = {
    getSmallModel: () =>
      Effect.succeed({
        id: ModelID.make("deepseek-v4-flash"),
        providerID: ProviderID.make("wanlaicode"),
      } as Provider.Model),
    getLanguage: () =>
      Effect.succeed({
        specificationVersion: "v3",
        provider: "wanlaicode",
        modelId: "deepseek-v4-flash",
        supportedUrls: {},
        doGenerate(options) {
          signal = options.abortSignal
          return new Promise((_, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true })
          })
        },
        doStream() {
          throw new Error("streaming is not expected")
        },
      } satisfies LanguageModelV3),
  } as unknown as Provider.Interface
  const reviewer = ApprovalReviewer.make({
    state: ApprovalReviewer.state(),
    provider,
    model: { id: ModelID.make("deepseek-v4-pro"), providerID: ProviderID.make("wanlaicode") } as Provider.Model,
    messages: [],
    directory: "/repo/package",
    worktree: "/repo",
    fallbackToMainModel: false,
  })

  const fiber = Effect.runFork(reviewer({ request: fixture.request, ruleset: [] }))
  for (let i = 0; i < 100 && !signal; i++) await Bun.sleep(5)
  await Effect.runPromise(Fiber.interrupt(fiber))
  const exit = await Effect.runPromise(Fiber.await(fiber))

  expect(signal).toBeDefined()
  expect(signal?.aborted).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
})

test("reviewer rejects a risk classification without a reason", async () => {
  const fixture = reviewerFixture([`{"action":"low"}`])

  await expect(Effect.runPromise(fixture.reviewer({ request: fixture.request, ruleset: [] }))).rejects.toBeDefined()
})
