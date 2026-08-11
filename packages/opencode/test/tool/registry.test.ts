import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ToolRegistry } from "@/tool/registry"
import { MemoryStore } from "@/memory"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { WanlaiCodeImageGeneration } from "@/provider/wanlaicode-image-generation"
import { ShellBackground } from "@/tool/shell/background"
import { Config } from "@/config/config"

const node = CrossSpawnSpawner.defaultLayer
// 每组注册表测试复用同一套真实服务，只按场景替换配置读取结果。
const registryLayer = (overrides: Partial<Config.Interface> = {}) =>
  ToolRegistry.layer.pipe(
    Layer.provide(
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".wanlaicode")])),
        ...overrides,
      }),
    ),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(MemoryStore.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(WanlaiCodeImageGeneration.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(node),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(ShellBackground.defaultLayer),
  )

const it = testEffect(Layer.mergeAll(registryLayer(), node))
const disabledIt = testEffect(
  Layer.mergeAll(
    registryLayer({
      get: () => Effect.succeed({ tools: { disabled: false } }),
    }),
    node,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry goal tools", () => {
  it.instance("goal 工具默认常驻", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("update_goal")
      expect(ids).toContain("get_goal")
    }),
  )

  it.instance("图片生成工具默认常驻", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("image_generation")
    }),
  )
})

describe("tool.registry", () => {
  it.instance("loads tools from .wanlaicode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".wanlaicode")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads tools from .wanlaicode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".wanlaicode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".wanlaicode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )

  disabledIt.instance("does not import explicitly disabled custom tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".wanlaicode", "tools")
      const marker = path.join(test.directory, "disabled-tool-imported")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "disabled.ts"),
          [
            `await Bun.write(${JSON.stringify(marker)}, 'imported')`,
            "export default {",
            "  description: 'disabled tool',",
            "  args: {},",
            "  execute: async () => 'disabled',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("disabled")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )

  it.instance("isolates a broken custom tool and keeps healthy tools available", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".wanlaicode", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.all([
        Effect.promise(() =>
          Bun.write(
            path.join(tools, "broken.ts"),
            [
              "import 'wanlaicode-test-missing-custom-tool-dependency'",
              "export default { description: 'broken tool', args: {}, execute: async () => 'broken' }",
              "",
            ].join("\n"),
          ),
        ),
        Effect.promise(() =>
          Bun.write(
            path.join(tools, "healthy.ts"),
            [
              "export default {",
              "  description: 'healthy tool',",
              "  args: {},",
              "  execute: async () => 'healthy',",
              "}",
              "",
            ].join("\n"),
          ),
        ),
      ])

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("broken")
      expect(ids).toContain("healthy")
      expect(ids).toContain("read")
    }),
  )
})
