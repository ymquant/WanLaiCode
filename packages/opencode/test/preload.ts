// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// Set XDG env vars FIRST, before any src/ imports
// 用 mkdtemp 而不是 pid-based 命名,保证每个 bun test 进程独占新目录,杜绝
// 任何残留 (PID 复用 / 跨用户 EPERM 让 rm 静默失败 / SIGKILL 后 cleanup 没跑)。
// 上一版 `path.join(tmpdir, "opencode-test-data-" + process.pid) + rm + mkdir`
// 在 linux self-hosted runner 上观察到 /tmp 里堆了多个不同 PID 的残留目录
// 且权限错乱(root 拥有,runner 用户 rm 时 EPERM),导致残留 auth.json 漏 secret
// 到 Authorization 头 — THE-133 #2 全部由此引起。
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-data-"))
afterAll(async () => {
  const { Database } = await import("../src/storage/db")
  Database.close()
  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1) throw error
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["WANLAICODE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
// 禁掉 fetch 防止 mtime 过 TTL 时把 fixture 当 cache 覆盖（minify 写回）；
// 测刷新路径的 case 需用例内 toggle = false
process.env["WANLAICODE_DISABLE_MODELS_FETCH"] = "true"
// 测试钩子：跳过 Config.load 给每个 dir 起的后台 npm install。Windows self-hosted
// 上 arborist.reify 偶发 hang 90s+，本仓库 Plugin.init / WithInstance.provide 用例会卡。
process.env["WANLAICODE_DISABLE_NPM_INSTALL"] = "true"
process.env["WANLAICODE_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
// Pin the plugin-registry host root to a deterministic unreachable host so the
// registry tests' injected fetchImpl matches it. Must be set before any src/
// import because provider/wanlaicode's defaultConfig snapshots the env at load.
process.env["WANLAICODE_PLUGIN_REGISTRY_URL"] = "https://registry.test.invalid"

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["WANLAICODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["WANLAICODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir
process.env["WANLAICODE_DISABLE_DEFAULT_PLUGINS"] = "true"

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "wanlaicode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["WANLAICODE_API_KEY"]
delete process.env["WANLAICODE_SERVER_PASSWORD"]; delete process.env["OPENCODE_SERVER_PASSWORD"]
delete process.env["WANLAICODE_SERVER_USERNAME"]; delete process.env["OPENCODE_SERVER_USERNAME"]
delete process.env["WANLAICODE_DISABLE_SHARE"]; delete process.env["OPENCODE_DISABLE_SHARE"]
delete process.env["WANLAICODE_AUTH_CONTENT"]
delete process.env["OPENCODE_AUTH_CONTENT"]

// Use in-memory sqlite
process.env["WANLAICODE_DB"] = ":memory:"

// Now safe to import from src/
const { Log } = await import("@opencode-ai/core/util/log")
const { initProjectors } = await import("../src/server/projectors")

void Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

initProjectors()

export function clearAuthContentEnv() {
  delete process.env["WANLAICODE_AUTH_CONTENT"]
  delete process.env["OPENCODE_AUTH_CONTENT"]
}
