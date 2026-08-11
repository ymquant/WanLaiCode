import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "@/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const userMessage = (text: string, skillArguments?: string): MessageV2.WithParts => ({
  info: {
    id: MessageID.make("msg_user"),
    sessionID: baseCtx.sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "wanlaicode" as any, modelID: "gpt-5" as any },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User,
  parts: [
    {
      id: PartID.make("prt_user"),
      sessionID: baseCtx.sessionID,
      messageID: MessageID.make("msg_user"),
      type: "text",
      text,
      ...(skillArguments
        ? {
            metadata: {
              skill: {
                name: "imagegen",
                arguments: skillArguments,
              },
            },
          }
        : {}),
    },
  ],
})

afterEach(async () => {
  await disposeAllInstances()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

describe("tool.skill", () => {
  it.live("execute can load builtin imagegen skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "wanlaicode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const result = yield* tool.execute(
            { name: "imagegen" },
            {
              ...baseCtx,
              ask: (req) =>
                Effect.sync(() => {
                  requests.push(req)
                }),
            },
          )

          expect(requests.length).toBe(1)
          expect(result.metadata.dir).toBe("builtin:imagegen")
          expect(result.output).toContain(`<skill_content name="imagegen">`)
          expect(result.output).toContain("Use the image_generation tool")
          expect(result.output).toContain("call the image_generation tool now")
          expect(result.output).toContain("Base directory for this skill: builtin:imagegen")
        }),
      { git: true },
    ),
  )

  it.live("imagegen skill rejects bare clarification followups", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "wanlaicode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const exit = yield* tool
            .execute(
              { name: "imagegen" },
              {
                ...baseCtx,
                messages: [userMessage("?")],
                ask: (req) =>
                  Effect.sync(() => {
                    requests.push(req)
                  }),
              },
            )
            .pipe(Effect.exit)

          expect(exit._tag).toBe("Failure")
          expect(requests).toHaveLength(0)
        }),
      { git: true },
    ),
  )

  it.live("imagegen skill reads clarification text from stored skill arguments", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "wanlaicode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const exit = yield* tool
            .execute(
              { name: "imagegen" },
              {
                ...baseCtx,
                messages: [userMessage("/imagegen ?", "?")],
                ask: (req) =>
                  Effect.sync(() => {
                    requests.push(req)
                  }),
              },
            )
            .pipe(Effect.exit)

          expect(exit._tag).toBe("Failure")
          expect(requests).toHaveLength(0)
        }),
      { git: true },
    ),
  )

  it.live("execute returns skill content block with files", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".wanlaicode", "skill", "tool-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

          const home = (process.env.WANLAICODE_TEST_HOME ?? process.env.OPENCODE_TEST_HOME)
          process.env.WANLAICODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.WANLAICODE_TEST_HOME = home
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "wanlaicode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute({ name: "tool-skill" }, ctx)
          const file = path.resolve(skill, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")
          expect(result.metadata.dir).toBe(skill)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(skill).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        }),
      { git: true },
    ),
  )
})
