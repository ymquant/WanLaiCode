import { env } from "../flag/flag"

export const WANLAICODE_RUN_ID = "WANLAICODE_RUN_ID"
export const WANLAICODE_PROCESS_ROLE = "WANLAICODE_PROCESS_ROLE"
const LEGACY_RUN_ID = "OPENCODE_RUN_ID"
const LEGACY_PROCESS_ROLE = "OPENCODE_PROCESS_ROLE"

function runIdKey() {
  return process.env[WANLAICODE_RUN_ID] !== undefined || process.env[LEGACY_RUN_ID] === undefined
    ? WANLAICODE_RUN_ID
    : LEGACY_RUN_ID
}

function processRoleKey() {
  return process.env[WANLAICODE_PROCESS_ROLE] !== undefined || process.env[LEGACY_PROCESS_ROLE] === undefined
    ? WANLAICODE_PROCESS_ROLE
    : LEGACY_PROCESS_ROLE
}

export function ensureRunID() {
  const key = runIdKey()
  return (process.env[key] ??= crypto.randomUUID())
}

export function ensureProcessRole(fallback: "main" | "worker") {
  const key = processRoleKey()
  return (process.env[key] ??= fallback)
}

export function ensureProcessMetadata(fallback: "main" | "worker") {
  return {
    runID: ensureRunID(),
    processRole: ensureProcessRole(fallback),
  }
}

export function sanitizedProcessEnv(overrides?: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return overrides ? Object.assign(env, overrides) : env
}

/** @deprecated Use WANLAICODE_RUN_ID */
export const OPENCODE_RUN_ID = LEGACY_RUN_ID
/** @deprecated Use WANLAICODE_PROCESS_ROLE */
export const OPENCODE_PROCESS_ROLE = LEGACY_PROCESS_ROLE
