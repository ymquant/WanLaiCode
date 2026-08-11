import os from "os"
import path from "path"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"

const providerID = "wanlai"
const topLevelBegin = "# BEGIN WANLAICODE MANAGED TOPLEVEL"
const topLevelEnd = "# END WANLAICODE MANAGED TOPLEVEL"
const providerBegin = "# BEGIN WANLAICODE MANAGED PROVIDER"
const providerEnd = "# END WANLAICODE MANAGED PROVIDER"
const legacyBegin = "# BEGIN WANLAICODE MANAGED BLOCK"
const legacyEnd = "# END WANLAICODE MANAGED BLOCK"
const restoreMetadataFile = "wanlai-restore.json"
const tokenCommandBase = "wanlai-codex-token"

type RuntimePlatform = ReturnType<typeof os.platform>

type RestoreMetadata = {
  config_backup?: string
  auth_backup?: string
  token_command_backup?: string
  auth_managed_key_hash?: string
  config_existed: boolean
  auth_existed: boolean
  token_command_existed?: boolean
}

export type CodexIntegrationStatus = {
  installed: boolean
  restorable: boolean
  config_path: string
  auth_path: string
  provider_id: typeof providerID
}

export type CodexImportResult = {
  ok: true
  installed: true
  changed: boolean
}

export type CodexRestoreResult = {
  ok: true
  installed: false
  restored_from_backup: boolean
}

export type CodexIntegrationPaths = {
  dir: string
  config: string
  auth: string
  tokenCommand: string
  restoreMetadata: string
}

export function codexIntegrationPaths(home = os.homedir(), platform: RuntimePlatform = os.platform()): CodexIntegrationPaths {
  const dir = path.join(home, ".codex")
  return {
    dir,
    config: path.join(dir, "config.toml"),
    auth: path.join(dir, "auth.json"),
    tokenCommand: path.join(dir, tokenCommandFile(platform)),
    restoreMetadata: path.join(dir, restoreMetadataFile),
  }
}

export async function codexIntegrationStatus(
  home?: string,
  platform: RuntimePlatform = os.platform(),
): Promise<CodexIntegrationStatus> {
  const paths = codexIntegrationPaths(home, platform)
  const config = await readText(paths.config)
  const auth = parseAuth(await readText(paths.auth))
  const installed =
    topLevelStringValue(config, "model_provider") === providerID &&
    hasWanlaiProvider(config) &&
    hasWanlaiAuthCommand(config) &&
    hasOpenAIAPIKey(auth) &&
    (await isTokenCommandReady(paths.tokenCommand, platform))
  return {
    installed,
    restorable:
      installed ||
      hasWanlaiProvider(config) ||
      Boolean(await readRestoreMetadata(paths)) ||
      Boolean(await latestBackup(paths.config)) ||
      Boolean(await latestBackup(paths.tokenCommand)),
    config_path: paths.config,
    auth_path: paths.auth,
    provider_id: providerID,
  }
}

export async function installCodexIntegration(input: {
  apiKey: string
  baseUrl: string
  home?: string
  platform?: RuntimePlatform
}): Promise<CodexImportResult> {
  const platform = input.platform ?? os.platform()
  const paths = codexIntegrationPaths(input.home, platform)
  await mkdir(paths.dir, { recursive: true })

  const before = {
    config: await readText(paths.config),
    auth: await readText(paths.auth),
    tokenCommand: await readText(paths.tokenCommand),
  }
  const metadata = {
    ...(await installMetadata(paths, before)),
    auth_managed_key_hash: hashSecret(input.apiKey),
  }
  const nextConfig = installConfig(before.config, input.baseUrl, paths.tokenCommand)
  const nextAuth = installAuth(before.auth, input.apiKey)
  const nextTokenCommand = tokenCommand(platform)

  await writeAtomic(paths.config, nextConfig, 0o600, platform)
  await writeAtomic(paths.auth, JSON.stringify(nextAuth, null, 2) + "\n", 0o600, platform)
  await writeAtomic(paths.tokenCommand, nextTokenCommand, 0o700, platform)
  await writeAtomic(paths.restoreMetadata, JSON.stringify(metadata, null, 2) + "\n", 0o600, platform)

  return {
    ok: true,
    installed: true,
    changed:
      before.config !== nextConfig ||
      before.auth !== JSON.stringify(nextAuth, null, 2) + "\n" ||
      before.tokenCommand !== nextTokenCommand,
  }
}

export async function restoreCodexIntegration(
  home?: string,
  platform: RuntimePlatform = os.platform(),
): Promise<CodexRestoreResult> {
  const paths = codexIntegrationPaths(home, platform)
  const metadata = await readRestoreMetadata(paths)
  if (metadata) {
    await restoreFromMetadata(paths, metadata)
    await restoreManagedAuth(paths, metadata)
    await rm(paths.restoreMetadata, { force: true })
    return { ok: true, installed: false, restored_from_backup: true }
  }

  const configBackup = await latestBackup(paths.config)
  const tokenCommandBackup = await latestBackup(paths.tokenCommand)
  const restoredAuth = await restoreManagedAuth(paths)
  if (configBackup || tokenCommandBackup || restoredAuth) {
    if (configBackup) await copyFile(configBackup, paths.config)
    if (tokenCommandBackup) await copyFile(tokenCommandBackup, paths.tokenCommand)
    return { ok: true, installed: false, restored_from_backup: true }
  }

  const restoredConfig = restoreConfig(await readText(paths.config))
  if (restoredConfig) {
    await writeAtomic(paths.config, restoredConfig, 0o600, platform)
  } else {
    await rm(paths.config, { force: true })
  }
  await rm(paths.tokenCommand, { force: true })
  await restoreManagedAuth(paths)
  return { ok: true, installed: false, restored_from_backup: false }
}

function installConfig(content: string, baseUrl: string, tokenCommandPath: string) {
  const cleaned = removeWanlaiConfig(content).trim()
  const parts = [topLevelBlock(), cleaned, providerBlock(baseUrl, tokenCommandPath)].filter(Boolean)
  return parts.join("\n\n") + "\n"
}

function restoreConfig(content: string) {
  const restored = removeWanlaiConfig(content).trim()
  return restored ? restored + "\n" : ""
}

function topLevelBlock() {
  return `${topLevelBegin}
model_provider = "wanlai"
model = "gpt-5.2-codex"
model_reasoning_effort = "high"
disable_response_storage = true
${topLevelEnd}`
}

function providerBlock(baseUrl: string, tokenCommandPath: string) {
  return `${providerBegin}
[model_providers.wanlai]
name = "Wanlai"
base_url = "${escapeTomlString(baseUrl)}"
wire_api = "responses"

[model_providers.wanlai.auth]
command = "${escapeTomlString(tokenCommandPath)}"
refresh_interval_ms = 300000
timeout_ms = 5000
${providerEnd}`
}

function tokenCommandFile(platform: RuntimePlatform) {
  return platform === "win32" ? `${tokenCommandBase}.cmd` : `${tokenCommandBase}.sh`
}

function tokenCommand(platform: RuntimePlatform) {
  if (platform === "win32") {
    return `@echo off\r
set "AUTH_FILE=%USERPROFILE%\\.codex\\auth.json"\r
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $auth = Get-Content -Raw $env:AUTH_FILE | ConvertFrom-Json; $key = $auth.OPENAI_API_KEY; if ([string]::IsNullOrWhiteSpace($key)) { exit 1 }; [Console]::Out.WriteLine($key)"\r
`
  }
  return `#!/bin/sh
set -eu
auth_file="\${HOME}/.codex/auth.json"
script='const fs=require("fs");const key=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).OPENAI_API_KEY;if(typeof key!=="string"||!key.trim())process.exit(1);process.stdout.write(key+"\\n")'
if command -v node >/dev/null 2>&1; then
  node -e "$script" "$auth_file"
  exit $?
fi
if command -v bun >/dev/null 2>&1; then
  bun -e "$script" "$auth_file"
  exit $?
fi
# CI 或最小化运行环境可能没有 node/bun；auth.json 由本集成写入，兜底用 POSIX awk 读取 OPENAI_API_KEY。
awk '
  BEGIN { in_key = 0; out = ""; esc = 0 }
  {
    line = $0
    for (i = 1; i <= length(line); i++) {
      ch = substr(line, i, 1)
      if (!in_key) {
        if (substr(line, i, 16) == "\\"OPENAI_API_KEY\\"") {
          in_key = 1
          i += 15
        }
        continue
      }
      if (out == "" && ch != "\\"") continue
      if (out == "" && ch == "\\"") {
        out = "__started__"
        continue
      }
      if (esc) {
        if (ch == "n") out = out "\\n"
        else if (ch == "r") out = out "\\r"
        else if (ch == "t") out = out "\\t"
        else out = out ch
        esc = 0
        continue
      }
      if (ch == "\\\\") {
        esc = 1
        continue
      }
      if (ch == "\\"") {
        sub(/^__started__/, "", out)
        if (out != "") {
          print out
          found = 1
        }
        exit found ? 0 : 1
      }
      out = out ch
    }
  }
  END { if (!found) exit 1 }
' "$auth_file"
`
}

function installAuth(content: string, apiKey: string): Record<string, unknown> {
  return {
    ...parseAuth(content),
    OPENAI_API_KEY: apiKey,
  }
}

function hasOpenAIAPIKey(auth: Record<string, unknown>) {
  return typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim() !== ""
}

function parseAuth(content: string): Record<string, unknown> {
  if (!content.trim()) return {}
  try {
    const parsed = JSON.parse(content)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function removeWanlaiConfig(content: string) {
  return removeTopLevelKeys(
    removeTableWithChildren(
      removeManagedBlock(
        removeManagedBlock(removeManagedBlock(content, topLevelBegin, topLevelEnd), providerBegin, providerEnd),
        legacyBegin,
        legacyEnd,
      ),
      "model_providers.wanlai",
    ),
    ["model_provider", "model", "model_reasoning_effort", "disable_response_storage"],
  )
}

function removeManagedBlock(content: string, begin: string, end: string) {
  const lines = content.split(/\r?\n/)
  const result: string[] = []
  const reduce = lines.reduce(
    (state, line) => {
      if (line.trim() === begin) return { skipping: true }
      if (state.skipping && line.trim() === end) return { skipping: false }
      if (!state.skipping) result.push(line)
      return state
    },
    { skipping: false },
  )
  return reduce.skipping ? content : result.join("\n")
}

function removeTableWithChildren(content: string, table: string) {
  const result: string[] = []
  content.split(/\r?\n/).reduce((skipping, line) => {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (match?.[1] === table || match?.[1].startsWith(`${table}.`)) return true
    if (match && skipping) {
      result.push(line)
      return false
    }
    if (!skipping) result.push(line)
    return skipping
  }, false)
  return result.join("\n")
}

function removeTopLevelKeys(content: string, keys: string[]) {
  return content
    .split(/\r?\n/)
    .reduce(
      (state, line) => {
        const enteredTable = state.inTopLevel && /^\s*\[/.test(line)
        const key = state.inTopLevel ? line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1] : undefined
        return {
          inTopLevel: enteredTable ? false : state.inTopLevel,
          lines: key && keys.includes(key) ? state.lines : [...state.lines, line],
        }
      },
      { inTopLevel: true, lines: [] as string[] },
    )
    .lines.join("\n")
}

function topLevelStringValue(content: string, key: string) {
  const line = content.split(/\r?\n/).reduce(
    (state, next) => {
      if (!state.inTopLevel || state.value) return state
      if (/^\s*\[/.test(next)) return { ...state, inTopLevel: false }
      const match = next.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`))
      return match ? { ...state, value: match[1] } : state
    },
    { inTopLevel: true, value: undefined as string | undefined },
  )
  return line.value
}

function hasWanlaiProvider(content: string) {
  return /^\s*\[model_providers\.wanlai\]\s*$/m.test(content)
}

function hasWanlaiAuthCommand(content: string) {
  return /^\s*\[model_providers\.wanlai\.auth\]\s*$/m.test(content)
}

async function backup(paths: CodexIntegrationPaths): Promise<RestoreMetadata> {
  const suffix = timestamp()
  const configExists = await exists(paths.config)
  const authExists = await exists(paths.auth)
  const tokenCommandExists = await exists(paths.tokenCommand)
  const metadata = {
    config_backup: configExists ? `${paths.config}.wanlai.bak-${suffix}` : undefined,
    auth_backup: authExists ? `${paths.auth}.wanlai.bak-${suffix}` : undefined,
    token_command_backup: tokenCommandExists ? `${paths.tokenCommand}.wanlai.bak-${suffix}` : undefined,
    config_existed: configExists,
    auth_existed: authExists,
    token_command_existed: tokenCommandExists,
  }
  if (metadata.config_backup) await copyFile(paths.config, metadata.config_backup)
  if (metadata.auth_backup) await copyFile(paths.auth, metadata.auth_backup)
  if (metadata.token_command_backup) await copyFile(paths.tokenCommand, metadata.token_command_backup)
  return metadata
}

async function installMetadata(
  paths: CodexIntegrationPaths,
  before: { config: string; auth: string; tokenCommand: string },
) {
  const metadata = await readRestoreMetadata(paths)
  if (!metadata) return backup(paths)

  const suffix = timestamp()
  const currentConfig = restoreConfig(before.config)
  const auth = parseAuth(before.auth)
  const currentKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : undefined
  const authChanged =
    metadata.auth_managed_key_hash && (!currentKey || hashSecret(currentKey) !== metadata.auth_managed_key_hash)
  const configChanged =
    currentConfig.trim() !== "" && currentConfig !== (metadata.config_backup ? await readText(metadata.config_backup) : "")

  return {
    ...metadata,
    config_backup: configChanged ? await writeBackup(paths.config, currentConfig, suffix) : metadata.config_backup,
    auth_backup: authChanged ? await writeBackup(paths.auth, before.auth, suffix) : metadata.auth_backup,
    config_existed: configChanged ? currentConfig.trim() !== "" : metadata.config_existed,
    auth_existed: authChanged ? before.auth.trim() !== "" : metadata.auth_existed,
  }
}

async function writeBackup(file: string, content: string, suffix: string) {
  if (!content.trim()) return undefined
  const backup = `${file}.wanlai.bak-${suffix}`
  await writeFile(backup, content)
  return backup
}

async function restoreFromMetadata(paths: CodexIntegrationPaths, metadata: RestoreMetadata) {
  if (metadata.config_existed && metadata.config_backup) {
    await copyFile(metadata.config_backup, paths.config)
  } else {
    await rm(paths.config, { force: true })
  }
  if (metadata.token_command_existed && metadata.token_command_backup) {
    await copyFile(metadata.token_command_backup, paths.tokenCommand)
  } else {
    await rm(paths.tokenCommand, { force: true })
  }
}

async function restoreManagedAuth(paths: CodexIntegrationPaths, metadata?: RestoreMetadata) {
  const managedHash = metadata?.auth_managed_key_hash
  if (!managedHash) return false

  const currentAuth = parseAuth(await readText(paths.auth))
  const currentKey = typeof currentAuth.OPENAI_API_KEY === "string" ? currentAuth.OPENAI_API_KEY : undefined
  if (!currentKey || hashSecret(currentKey) !== managedHash) return false

  const backupAuth = parseAuth(metadata.auth_backup ? await readText(metadata.auth_backup) : "")
  const backupKey = typeof backupAuth.OPENAI_API_KEY === "string" ? backupAuth.OPENAI_API_KEY : undefined
  const nextAuth = {
    ...currentAuth,
    ...(backupKey ? { OPENAI_API_KEY: backupKey } : {}),
  }
  if (!backupKey) delete nextAuth.OPENAI_API_KEY
  if (Object.keys(nextAuth).length === 0) {
    await rm(paths.auth, { force: true })
    return true
  }
  await writeAtomic(paths.auth, JSON.stringify(nextAuth, null, 2) + "\n", 0o600)
  return true
}

async function readRestoreMetadata(paths: CodexIntegrationPaths) {
  const content = await readText(paths.restoreMetadata)
  if (!content) return undefined
  try {
    const data = JSON.parse(content)
    return typeof data === "object" && data !== null ? (data as RestoreMetadata) : undefined
  } catch {
    return undefined
  }
}

async function latestBackup(file: string) {
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.wanlai.bak-`
  const names = await readdir(dir).catch(() => [] as string[])
  const name = names
    .filter((next) => next.startsWith(prefix))
    .sort()
    .at(-1)
  return name ? path.join(dir, name) : undefined
}

async function writeAtomic(file: string, content: string, mode: number, platform: RuntimePlatform = os.platform()) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  await writeFile(tmp, content, { mode })
  await rename(tmp, file)
  if (platform === "win32") return
  await chmod(file, mode)
}

async function readText(file: string) {
  return readFile(file, "utf8").catch(() => "")
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

async function isTokenCommandReady(file: string, platform: RuntimePlatform) {
  if (platform === "win32") return exists(file)
  return stat(file)
    .then((info) => info.isFile() && (info.mode & 0o111) !== 0)
    .catch(() => false)
}

function escapeTomlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "")
}
