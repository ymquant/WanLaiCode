import { afterEach, test, expect } from "bun:test"
import os from "os"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { PermissionMode } from "../../src/permission/mode"
import { PermissionID } from "../../src/permission/schema"
import { InstanceState } from "../../src/effect/instance-state"
import { Database } from "../../src/storage/db"
import { PermissionTable } from "../../src/session/session.sql"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import {
  disposeAllInstances,
  provideInstance,
  provideTmpdirInstance,
  reloadTestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"

const bus = Bus.layer
const env = Layer.mergeAll(Permission.layer.pipe(Layer.provide(bus)), bus, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

afterEach(async () => {
  await disposeAllInstances()
})

const rejectAll = (message?: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({
        requestID: req.id,
        reply: "reject",
        message,
      })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const askInput = (pattern: string): Parameters<Permission.Interface["ask"]>[0] => ({
  sessionID: SessionID.make("session_test"),
  permission: "bash",
  patterns: [pattern],
  metadata: {},
  always: [],
  ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
})

function withDir(options: { git?: boolean } | undefined, self: (dir: string) => Effect.Effect<any, any, any>) {
  return provideTmpdirInstance(self, options)
}

function withProvided(dir: string) {
  return <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(dir))
}

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

// Permission precedence follows config insertion order. `evaluate()` uses the
// last matching rule, so later config entries intentionally override earlier
// entries even when a wildcard appears after a specific permission.

test("fromConfig - preserves top-level config key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  expect(wildcardFirst.map((r) => r.permission)).toEqual(["*", "bash"])
  expect(specificFirst.map((r) => r.permission)).toEqual(["bash", "*"])

  expect(Permission.evaluate("bash", "ls", wildcardFirst).action).toBe("allow")
  expect(Permission.evaluate("bash", "ls", specificFirst).action).toBe("deny")
})

test("fromConfig - wildcard acts as fallback when it appears before specifics", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow" })
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("ask")
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
})

test("fromConfig - top-level ordering is not sorted by wildcard specificity", () => {
  const ruleset = Permission.fromConfig({
    bash: "allow",
    "*": "ask",
    edit: "deny",
    "mcp_*": "allow",
  })
  expect(ruleset.map((r) => r.permission)).toEqual(["bash", "*", "edit", "mcp_*"])
})

test("fromConfig - sub-pattern insertion order inside a tool key is preserved", () => {
  const ruleset = Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })
  expect(ruleset.map((r) => r.pattern)).toEqual(["*", "git *"])
  expect(Permission.evaluate("bash", "rm foo", ruleset).action).toBe("deny")
  expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("allow")
})

test("fromConfig - documented fallback-first example", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("deny")
  expect(Permission.evaluate("read", "foo.ts", ruleset).action).toBe("ask")
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  const defaults: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  const defaults: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - later wildcard permission can override earlier specific permission", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: Permission.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

// ask tests

it.live("ask - resolves immediately when action is allow", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      }).pipe(Effect.provideService(PermissionMode.Ref, "ask"))
      expect(result).toBeUndefined()
    }),
  ),
)

it.live("ask - fallback allow auto-approves when no rule matches", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
        fallback: "allow",
      })
      expect(result).toBeUndefined()
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - deny rule wins over fallback allow", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
          fallback: "allow",
        }),
      )
      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - fallback reject denies immediately without pending", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
          fallback: "reject",
        }),
      )
      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - omitted fallback defaults to ask (stays pending)", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - FallbackRef allow auto-approves within provided scope", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.provideService(Permission.FallbackRef, "allow"))
      expect(result).toBeUndefined()
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - FallbackRef does not leak outside provided scope", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      // 作用域内 allow → 放行、无 pending
      const provided = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.provideService(Permission.FallbackRef, "allow"))
      expect(provided).toBeUndefined()
      // 作用域外 → 回默认 ask、挂起
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - throws DeniedError when action is deny", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(Permission.DeniedError)
    }),
  ),
)

it.live("ask - stays pending when action is ask", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - adds request to pending list", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const items = yield* waitForPending(1)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - publishes asked event", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      let seen: Permission.Request | undefined
      const unsub = yield* bus.subscribeCallback(Permission.Event.Asked, (event) => {
        seen = event.properties
      })

      try {
        const fiber = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: { cmd: "ls" },
          always: ["ls"],
          tool: {
            messageID: MessageID.make("msg_test"),
            callID: "call_test",
          },
          ruleset: [],
        }).pipe(Effect.forkScoped)

        expect(yield* waitForPending(1)).toHaveLength(1)
        expect(seen).toBeDefined()
        expect(seen).toMatchObject({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
        })

        yield* rejectAll()
        yield* Fiber.await(fiber)
      } finally {
        unsub()
      }
    }),
  ),
)

it.live("ask - ask mode creates a pending request", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask(askInput("ls")).pipe(Effect.provideService(PermissionMode.Ref, "ask"), Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - full_access returns without pending state", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      yield* ask(askInput("ls")).pipe(Effect.provideService(PermissionMode.Ref, "full_access"))
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - auto_review routes ask through reviewer but never overrides deny", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      let calls = 0
      const reviewer: Permission.Reviewer = () => {
        calls += 1
        return Effect.succeed({
          decision: "approve",
          risk: "low",
          reason: "bounded request",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
          halt: false,
        })
      }

      yield* ask(askInput("ls")).pipe(
        Effect.provideService(PermissionMode.Ref, "auto_review"),
        Effect.provideService(Permission.ReviewerRef, reviewer),
      )
      expect(calls).toBe(1)

      const denied = yield* fail(
        ask({ ...askInput("rm -rf /"), ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }).pipe(
          Effect.provideService(PermissionMode.Ref, "auto_review"),
          Effect.provideService(Permission.ReviewerRef, reviewer),
        ),
      )
      expect(denied).toBeInstanceOf(Permission.DeniedError)
      expect(calls).toBe(1)
    }),
  ),
)

it.live("ask - auto_review reviews requests allowed by backend rules", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      let calls = 0
      const reviews: Permission.ReviewOutcome[] = []
      const reviewer: Permission.Reviewer = () => {
        calls += 1
        return Effect.succeed({
          decision: "approve",
          risk: "low",
          reason: "safe command",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
          halt: false,
        })
      }

      yield* permission
        .ask(
          {
            ...askInput("bun --version"),
            ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          },
          { onReview: (review) => Effect.sync(() => reviews.push(review)) },
        )
        .pipe(
          Effect.provideService(PermissionMode.Ref, "auto_review"),
          Effect.provideService(Permission.ReviewerRef, reviewer),
        )

      expect(calls).toBe(1)
      expect(reviews).toEqual([
        { status: "reviewing" },
        {
          status: "approved",
          decision: "approve",
          risk: "low",
          reason: "safe command",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
        },
      ])
    }),
  ),
)

it.live("ask - auto_review reports the terminal review to the caller", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const reviews: Permission.ReviewOutcome[] = []
      const reviewer: Permission.Reviewer = () =>
        Effect.succeed({
          decision: "approve",
          risk: "medium",
          reason: "recoverable workspace operation",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
          halt: false,
        })

      yield* permission
        .ask(askInput("ls"), {
          onReview: (review) => Effect.sync(() => reviews.push(review)),
        })
        .pipe(
          Effect.provideService(PermissionMode.Ref, "auto_review"),
          Effect.provideService(Permission.ReviewerRef, reviewer),
        )

      expect(reviews).toEqual([
        { status: "reviewing" },
        {
          status: "approved",
          decision: "approve",
          risk: "medium",
          reason: "recoverable workspace operation",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
        },
      ])
    }),
  ),
)

it.live("ask - current explicit deny overrides a persisted always approval", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      Database.use((db) =>
        db
          .insert(PermissionTable)
          .values({
            project_id: ctx.project.id,
            data: [{ permission: "bash", pattern: "ls", action: "allow" }],
          })
          .run(),
      )
      const denied = yield* fail(
        ask({
          ...askInput("ls"),
          ruleset: [{ permission: "bash", pattern: "ls", action: "deny" }],
        }),
      )
      expect(denied).toBeInstanceOf(Permission.DeniedError)
    }),
  ),
)

it.live("ask - reviewer deny throws ReviewDeniedError without pending state", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const reviewer: Permission.Reviewer = () =>
        Effect.succeed({
          decision: "deny",
          risk: "critical",
          reason: "destructive command",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
          halt: true,
        })
      const error = yield* fail(
        ask(askInput("rm -rf /tmp/data")).pipe(
          Effect.provideService(PermissionMode.Ref, "auto_review"),
          Effect.provideService(Permission.ReviewerRef, reviewer),
        ),
      )
      expect(error).toBeInstanceOf(Permission.ReviewDeniedError)
      expect(error).toMatchObject({ risk: "critical", reason: "destructive command", halt: true })
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - reviewer ask_user creates pending state", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const reviewer: Permission.Reviewer = () =>
        Effect.succeed({
          decision: "ask_user",
          risk: "high",
          reason: "needs human judgment",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
          halt: false,
        })
      const fiber = yield* ask(askInput("deploy production")).pipe(
        Effect.provideService(PermissionMode.Ref, "auto_review"),
        Effect.provideService(Permission.ReviewerRef, reviewer),
        Effect.forkScoped,
      )
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - reviewer failure creates pending state", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const reviewer: Permission.Reviewer = () => Effect.fail(new Error("provider unavailable"))
      const fiber = yield* ask(askInput("ls")).pipe(
        Effect.provideService(PermissionMode.Ref, "auto_review"),
        Effect.provideService(Permission.ReviewerRef, reviewer),
        Effect.forkScoped,
      )
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - reviewer failure reports a safe reason before falling back to human approval", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const reviews: Permission.ReviewOutcome[] = []
      const reviewer: Permission.Reviewer = () => Effect.fail(new Error("Authorization: Bearer secret upstream failed"))
      const fiber = yield* permission
        .ask(askInput("ls"), {
          onReview: (review) => Effect.sync(() => reviews.push(review)),
        })
        .pipe(
          Effect.provideService(PermissionMode.Ref, "auto_review"),
          Effect.provideService(Permission.ReviewerRef, reviewer),
          Effect.forkScoped,
        )

      expect(yield* waitForPending(1)).toHaveLength(1)
      expect(reviews).toEqual([
        { status: "reviewing" },
        { status: "failed", reason: "reviewer_unavailable" },
      ])

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  ),
)

it.live("ask - reviewer interruption preserves the original cause", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const interruptor = 424242
      const reviewer: Permission.Reviewer = () => Effect.failCause(Cause.interrupt(interruptor))
      const exit = yield* ask(askInput("ls")).pipe(
        Effect.provideService(PermissionMode.Ref, "auto_review"),
        Effect.provideService(Permission.ReviewerRef, reviewer),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.interruptors(exit.cause)).toEqual(new Set([interruptor]))
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - reviewer interruption publishes a terminal review event and preserves the cause", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const events: Array<{ type: string; reason?: string }> = []
      const unsubscribe = yield* bus.subscribeAllCallback((event) => {
        if (!event.type.startsWith("permission.review.")) return
        events.push({ type: event.type, reason: event.properties.reason })
      })
      const reviewer: Permission.Reviewer = () => Effect.never

      try {
        const fiber = yield* ask(askInput("ls")).pipe(
          Effect.provideService(PermissionMode.Ref, "auto_review"),
          Effect.provideService(Permission.ReviewerRef, reviewer),
          Effect.forkScoped,
        )
        for (let i = 0; i < 100 && events.length === 0; i++) yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        yield* Effect.sleep("10 millis")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(events).toEqual([
          { type: "permission.review.started", reason: undefined },
          { type: "permission.review.failed", reason: "review_cancelled" },
        ])
      } finally {
        unsubscribe()
      }
    }),
  ),
)

it.live("ask - review event summaries redact all supported credential families", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const summaries: string[] = []
      const unsubscribe = yield* bus.subscribeCallback(Permission.Event.ReviewStarted, (event) => {
        summaries.push(event.properties.summary)
      })
      const reviewer: Permission.Reviewer = () =>
        Effect.succeed({
          decision: "approve",
          risk: "low",
          reason: "redaction test",
          providerID: "wanlaicode",
          modelID: "deepseek-v4-flash",
          halt: false,
        })
      const patterns = [
        "WANLAICODE_API_KEY=event-environment-secret command",
        "Authorization: Bearer event-bearer-secret",
        "command sk-eventsecret123456",
        "command ghp_notarealtoken",
        "command github_pat_notarealtoken",
      ]

      try {
        for (const pattern of patterns) {
          yield* ask(askInput(pattern)).pipe(
            Effect.provideService(PermissionMode.Ref, "auto_review"),
            Effect.provideService(Permission.ReviewerRef, reviewer),
          )
        }
        yield* Effect.sleep("10 millis")

        expect(summaries).toHaveLength(patterns.length)
        expect(summaries.join("\n")).not.toMatch(
          /event-environment-secret|event-bearer-secret|sk-eventsecret123456|ghp_|github_pat_/,
        )
        expect(summaries.every((summary) => summary.includes("[redacted]"))).toBe(true)
      } finally {
        unsubscribe()
      }
    }),
  ),
)

it.live("ask - explicit fallback remains higher priority than mode and reviewer", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      let calls = 0
      const reviewer: Permission.Reviewer = () => {
        calls += 1
        return Effect.die("reviewer should not run")
      }
      yield* ask(askInput("ls")).pipe(
        Effect.provideService(Permission.FallbackRef, "allow"),
        Effect.provideService(PermissionMode.Ref, "auto_review"),
        Effect.provideService(Permission.ReviewerRef, reviewer),
      )
      expect(calls).toBe(0)
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

// reply tests

it.live("reply - once resolves the pending ask", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionID.make("per_test1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionID.make("per_test1"), reply: "once" })
      yield* Fiber.join(fiber)
    }),
  ),
)

it.live("reply - reject throws RejectedError", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionID.make("per_test2"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionID.make("per_test2"), reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
    }),
  ),
)

it.live("reply - reject with message throws CorrectedError", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionID.make("per_test2b"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({
        requestID: PermissionID.make("per_test2b"),
        reply: "reject",
        message: "Use a safer command",
      })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).toBeInstanceOf(Permission.CorrectedError)
        expect(String(err)).toContain("Use a safer command")
      }
    }),
  ),
)

it.live("reply - always persists approval and resolves", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const run = withProvided(dir)
    const fiber = yield* ask({
      id: PermissionID.make("per_test3"),
      sessionID: SessionID.make("session_test"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: ["ls"],
      ruleset: [],
    }).pipe(run, Effect.provideService(PermissionMode.Ref, "ask"), Effect.forkScoped)

    yield* waitForPending(1).pipe(run)
    yield* reply({ requestID: PermissionID.make("per_test3"), reply: "always" }).pipe(run)
    yield* Fiber.join(fiber)

    const result = yield* ask({
      sessionID: SessionID.make("session_test2"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(run, Effect.provideService(PermissionMode.Ref, "ask"))
    expect(result).toBeUndefined()
  }),
)

it.live("reply - reject cancels all pending for same session", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionID.make("per_test4a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionID.make("per_test4b"),
        sessionID: SessionID.make("session_same"),
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionID.make("per_test4a"), reply: "reject" })

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isFailure(ea)).toBe(true)
      expect(Exit.isFailure(eb)).toBe(true)
      if (Exit.isFailure(ea)) expect(Cause.squash(ea.cause)).toBeInstanceOf(Permission.RejectedError)
      if (Exit.isFailure(eb)) expect(Cause.squash(eb.cause)).toBeInstanceOf(Permission.RejectedError)
    }),
  ),
)

it.live("reply - always resolves matching pending requests in same session", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionID.make("per_test5a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionID.make("per_test5b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionID.make("per_test5a"), reply: "always" })

      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("reply - always keeps other session pending", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionID.make("per_test6a"),
        sessionID: SessionID.make("session_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionID.make("per_test6b"),
        sessionID: SessionID.make("session_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionID.make("per_test6a"), reply: "always" })

      yield* Fiber.join(a)
      expect((yield* list()).map((item) => item.id)).toEqual([PermissionID.make("per_test6b")])

      yield* rejectAll()
      yield* Fiber.await(b)
    }),
  ),
)

it.live("reply - publishes replied event", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      let resolve!: (value: { sessionID: SessionID; requestID: PermissionID; reply: Permission.Reply }) => void
      const seen = Effect.promise<{
        sessionID: SessionID
        requestID: PermissionID
        reply: Permission.Reply
      }>(
        () =>
          new Promise((res) => {
            resolve = res
          }),
      )

      const fiber = yield* ask({
        id: PermissionID.make("per_test7"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)

      const unsub = yield* bus.subscribeCallback(Permission.Event.Replied, (event) => {
        resolve(event.properties)
      })

      try {
        yield* reply({ requestID: PermissionID.make("per_test7"), reply: "once" })
        yield* Fiber.join(fiber)
        expect(yield* seen).toEqual({
          sessionID: SessionID.make("session_test"),
          requestID: PermissionID.make("per_test7"),
          reply: "once",
        })
      } finally {
        unsub()
      }
    }),
  ),
)

it.live("permission requests stay isolated by directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })
    const runOne = withProvided(one)
    const runTwo = withProvided(two)

    const a = yield* ask({
      id: PermissionID.make("per_dir_a"),
      sessionID: SessionID.make("session_dir_a"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(runOne, Effect.forkScoped)

    const b = yield* ask({
      id: PermissionID.make("per_dir_b"),
      sessionID: SessionID.make("session_dir_b"),
      permission: "bash",
      patterns: ["pwd"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(runTwo, Effect.forkScoped)

    const onePending = yield* waitForPending(1).pipe(runOne)
    const twoPending = yield* waitForPending(1).pipe(runTwo)

    expect(onePending).toHaveLength(1)
    expect(twoPending).toHaveLength(1)
    expect(onePending[0].id).toBe(PermissionID.make("per_dir_a"))
    expect(twoPending[0].id).toBe(PermissionID.make("per_dir_b"))

    yield* reply({ requestID: onePending[0].id, reply: "reject" }).pipe(runOne)
    yield* reply({ requestID: twoPending[0].id, reply: "reject" }).pipe(runTwo)

    yield* Fiber.await(a)
    yield* Fiber.await(b)
  }),
)

it.live("pending permission rejects on instance dispose", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const run = withProvided(dir)
    const fiber = yield* ask({
      id: PermissionID.make("per_dispose"),
      sessionID: SessionID.make("session_dispose"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(run, Effect.forkScoped)

    expect(yield* waitForPending(1).pipe(run)).toHaveLength(1)
    yield* Effect.promise(() =>
      WithInstance.provide({ directory: dir, fn: () => void InstanceRuntime.disposeInstance(Instance.current) }),
    )

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
  }),
)

it.live("pending permission rejects on instance reload", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const run = withProvided(dir)
    const fiber = yield* ask({
      id: PermissionID.make("per_reload"),
      sessionID: SessionID.make("session_reload"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(run, Effect.forkScoped)

    expect(yield* waitForPending(1).pipe(run)).toHaveLength(1)
    yield* Effect.promise(() => reloadTestInstance({ directory: dir }))

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
  }),
)

it.live("reply - does nothing for unknown requestID", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      yield* reply({ requestID: PermissionID.make("per_unknown"), reply: "once" })
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - checks all patterns and stops on first deny", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )
      expect(err).toBeInstanceOf(Permission.DeniedError)
    }),
  ),
)

it.live("ask - allows all patterns when all match allow rules", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      }).pipe(Effect.provideService(PermissionMode.Ref, "ask"))
      expect(result).toBeUndefined()
    }),
  ),
)

it.live("ask - should deny even when an earlier pattern is ask", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "echo *", action: "ask" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  ),
)

it.live("ask - abort should clear pending request", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const run = withProvided(dir)

    const fiber = yield* ask({
      id: PermissionID.make("per_reload"),
      sessionID: SessionID.make("session_reload"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
    }).pipe(run, Effect.forkScoped)

    const pending = yield* waitForPending(1).pipe(run)
    expect(pending).toHaveLength(1)
    yield* Effect.promise(() => reloadTestInstance({ directory: dir }))

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
  }),
)

// 回归：等待授权的 fiber 被中断（如回合 abort / goal 重启撕掉在途轮）时，pending 会被 ensuring
// finalizer 删除——必须同时补发 permission.replied，否则客户端权限对话框成为永远点不掉的孤儿。
it.live("ask - interrupting a pending ask publishes replied (avoids orphan dialog)", () =>
  withDir({ git: true }, () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      let resolve!: (value: { sessionID: SessionID; requestID: PermissionID; reply: Permission.Reply }) => void
      const seen = Effect.promise<{ sessionID: SessionID; requestID: PermissionID; reply: Permission.Reply }>(
        () => new Promise((res) => (resolve = res)),
      )

      const fiber = yield* ask({
        id: PermissionID.make("per_interrupt"),
        sessionID: SessionID.make("session_interrupt"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)

      const unsub = yield* bus.subscribeCallback(Permission.Event.Replied, (event) => resolve(event.properties))
      try {
        yield* Fiber.interrupt(fiber)
        const replied = yield* seen.pipe(Effect.timeout("5 seconds"))
        expect(replied).toMatchObject({
          sessionID: SessionID.make("session_interrupt"),
          requestID: PermissionID.make("per_interrupt"),
        })
        expect(yield* list()).toHaveLength(0)
      } finally {
        unsub()
      }
    }),
  ),
)
