import { expect, test, mock } from "bun:test"
import { convertHooksFile, loadAndConvertHooks, type CodexHooksFile } from "./hooks-adapter"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

// --- convertHooksFile tests ---

test("maps PreToolUse → tool.execute.before", () => {
  const file: CodexHooksFile = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  expect(typeof hooks["tool.execute.before"]).toBe("function")
})

test("maps PermissionRequest → permission.ask", () => {
  const file: CodexHooksFile = {
    hooks: {
      PermissionRequest: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  expect(typeof hooks["permission.ask"]).toBe("function")
})

test("maps PostToolUse → tool.execute.after", () => {
  const file: CodexHooksFile = {
    hooks: {
      PostToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  expect(typeof hooks["tool.execute.after"]).toBe("function")
})

test("maps UserPromptSubmit → command.execute.before", () => {
  const file: CodexHooksFile = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  expect(typeof hooks["command.execute.before"]).toBe("function")
})

test("SessionStart is skipped + listed as unsupported", () => {
  const file: CodexHooksFile = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  }
  const { hooks, unsupportedEvents } = convertHooksFile(file, "/tmp")
  expect(Object.keys(hooks)).toHaveLength(0)
  expect(unsupportedEvents).toContain("SessionStart")
})

test("Stop is skipped + listed as unsupported", () => {
  const file: CodexHooksFile = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }],
    },
  }
  const { hooks, unsupportedEvents } = convertHooksFile(file, "/tmp")
  expect(Object.keys(hooks)).toHaveLength(0)
  expect(unsupportedEvents).toContain("Stop")
})

test("prompt handler returns null (not added to hooks)", () => {
  const file: CodexHooksFile = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "prompt" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  expect(hooks["tool.execute.before"]).toBeUndefined()
})

test("agent handler returns null (not added to hooks)", () => {
  const file: CodexHooksFile = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "agent" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  expect(hooks["tool.execute.before"]).toBeUndefined()
})

test("matcher with valid regex filters tool name", async () => {
  const file: CodexHooksFile = {
    hooks: {
      PreToolUse: [
        {
          matcher: "^bash$",
          hooks: [{ type: "command", command: "printf matched" }],
        },
      ],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  const fn = hooks["tool.execute.before"]!

  const outputMatch = {} as any
  await fn({ tool: "bash", sessionID: "s", callID: "c" }, outputMatch)
  expect(outputMatch.metadata?.hookOutput).toBe("matched")

  const outputNoMatch = {} as any
  await fn({ tool: "python", sessionID: "s", callID: "c" }, outputNoMatch)
  expect(outputNoMatch.metadata).toBeUndefined()
})

test("matcher with invalid regex falls back to string equality", async () => {
  const file: CodexHooksFile = {
    hooks: {
      PreToolUse: [
        {
          matcher: "[invalid",
          hooks: [{ type: "command", command: "printf hit" }],
        },
      ],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  const fn = hooks["tool.execute.before"]!

  const outputMatch = {} as any
  await fn({ tool: "[invalid", sessionID: "s", callID: "c" }, outputMatch)
  expect(outputMatch.metadata?.hookOutput).toBe("hit")

  const outputNoMatch = {} as any
  await fn({ tool: "bash", sessionID: "s", callID: "c" }, outputNoMatch)
  expect(outputNoMatch.metadata).toBeUndefined()
})

test("command execution injects output into output.metadata.hookOutput", async () => {
  const file: CodexHooksFile = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "printf 'hello world'" }] }],
    },
  }
  const { hooks } = convertHooksFile(file, "/tmp")
  const fn = hooks["tool.execute.before"]!

  const output = {} as any
  await fn({ tool: "", sessionID: "s", callID: "c" }, output)
  expect(output.metadata?.hookOutput).toBe("hello world")
})

// --- loadAndConvertHooks tests ---

test("loadAndConvertHooks: string form loads hooks.json file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addon-hooks-test-"))
  try {
    const hooksFile: CodexHooksFile = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "printf fileloaded" }] }],
      },
    }
    await fs.writeFile(path.join(dir, "hooks.json"), JSON.stringify(hooksFile))
    const result = await loadAndConvertHooks(dir, "hooks.json")
    expect(result).not.toBeNull()
    expect(typeof result!.hooks["tool.execute.before"]).toBe("function")
    const output = {} as any
    await result!.hooks["tool.execute.before"]!({ tool: "", sessionID: "s", callID: "c" }, output)
    expect(output.metadata?.hookOutput).toBe("fileloaded")
  } finally {
    await fs.rm(dir, { recursive: true })
  }
})

test("loadAndConvertHooks: string[] form loads multiple files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addon-hooks-test-"))
  try {
    await fs.writeFile(
      path.join(dir, "hooks1.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo a" }] }] } }),
    )
    await fs.writeFile(
      path.join(dir, "hooks2.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo b" }] }] } }),
    )
    const result = await loadAndConvertHooks(dir, ["hooks1.json", "hooks2.json"])
    expect(result).not.toBeNull()
    expect(typeof result!.hooks["tool.execute.before"]).toBe("function")
    expect(typeof result!.hooks["tool.execute.after"]).toBe("function")
  } finally {
    await fs.rm(dir, { recursive: true })
  }
})

test("loadAndConvertHooks: inline CodexHooksFile object", async () => {
  const hooksField = {
    hooks: {
      PostToolUse: [{ hooks: [{ type: "command", command: "printf inline" }] }],
    },
  }
  const result = await loadAndConvertHooks("/tmp", hooksField)
  expect(result).not.toBeNull()
  expect(typeof result!.hooks["tool.execute.after"]).toBe("function")
})

test("loadAndConvertHooks: inline HookInlineObject form (path + events)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addon-hooks-test-"))
  try {
    const scriptPath = path.join(dir, "hook.sh")
    await fs.writeFile(scriptPath, "#!/bin/sh\nprintf 'ran'")
    await fs.chmod(scriptPath, 0o755)
    const hooksField = { path: scriptPath, events: ["PreToolUse"] }
    const result = await loadAndConvertHooks(dir, hooksField)
    expect(result).not.toBeNull()
    expect(typeof result!.hooks["tool.execute.before"]).toBe("function")
  } finally {
    await fs.rm(dir, { recursive: true })
  }
})

test("loadAndConvertHooks: array of HookInlineObjects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addon-hooks-test-"))
  try {
    const script = path.join(dir, "hook.sh")
    await fs.writeFile(script, "#!/bin/sh\nprintf 'ok'")
    await fs.chmod(script, 0o755)
    const hooksField = [
      { path: script, events: ["PreToolUse"] },
      { path: script, events: ["PostToolUse"] },
    ]
    const result = await loadAndConvertHooks(dir, hooksField)
    expect(result).not.toBeNull()
    expect(typeof result!.hooks["tool.execute.before"]).toBe("function")
    expect(typeof result!.hooks["tool.execute.after"]).toBe("function")
  } finally {
    await fs.rm(dir, { recursive: true })
  }
})

test("loadAndConvertHooks: returns null for null/undefined", async () => {
  expect(await loadAndConvertHooks("/tmp", null)).toBeNull()
  expect(await loadAndConvertHooks("/tmp", undefined)).toBeNull()
})
