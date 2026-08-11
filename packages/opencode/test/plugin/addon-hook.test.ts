import { expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { loadAddonsFromPaths } from "@opencode-ai/addon"

async function makeFixtureAddon(hooks: object) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "addon-hook-integ-"))
  const pluginDir = path.join(base, "local-market", "test-addon", "local")
  const manifestDir = path.join(pluginDir, ".codex-plugin")
  await fs.mkdir(manifestDir, { recursive: true })
  await fs.writeFile(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({ name: "test-addon", version: "1.0.0", hooks: "hooks.json" }),
  )
  await fs.writeFile(path.join(pluginDir, "hooks.json"), JSON.stringify(hooks))
  return { base, pluginDir }
}

test("addon hooks are loaded from fixture and PreToolUse → tool.execute.before triggers", async () => {
  const { base } = await makeFixtureAddon({
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "printf 'hook_ran'" }] }],
    },
  })
  try {
    const result = await loadAddonsFromPaths([base])
    expect(result.addons).toHaveLength(1)
    const addon = result.addons[0]!
    expect(addon.hooks).toBeDefined()
    const hookFn = (addon.hooks as any)["tool.execute.before"]
    expect(typeof hookFn).toBe("function")
    const output: any = {}
    await hookFn({}, output)
    expect(output.metadata?.hookOutput).toBe("hook_ran")
  } finally {
    await fs.rm(base, { recursive: true })
  }
})

test("addon SessionStart hooks appear in unsupportedHookEvents", async () => {
  const { base } = await makeFixtureAddon({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
    },
  })
  try {
    const result = await loadAddonsFromPaths([base])
    const addon = result.addons[0]!
    expect(addon.unsupportedHookEvents).toContain("SessionStart")
    expect(addon.hooks).toBeUndefined()
  } finally {
    await fs.rm(base, { recursive: true })
  }
})

test("addon hooks with matcher only fire for matching tool", async () => {
  const { base } = await makeFixtureAddon({
    hooks: {
      PreToolUse: [
        {
          matcher: "^bash$",
          hooks: [{ type: "command", command: "printf 'matched'" }],
        },
      ],
    },
  })
  try {
    const result = await loadAddonsFromPaths([base])
    const addon = result.addons[0]!
    const hookFn = (addon.hooks as any)["tool.execute.before"]
    expect(typeof hookFn).toBe("function")

    const outputBash: any = {}
    await hookFn({ tool: "bash" }, outputBash)
    expect(outputBash.metadata?.hookOutput).toBe("matched")

    const outputPython: any = {}
    await hookFn({ tool: "python" }, outputPython)
    expect(outputPython.metadata?.hookOutput).toBeUndefined()
  } finally {
    await fs.rm(base, { recursive: true })
  }
})
