import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

import type { Scope } from "./schema"

type Context = {
  directory: string
  project: {
    worktree: string
  }
}

export function rootCandidate(ctx: Context) {
  if (ctx.project.worktree !== "/") return ctx.project.worktree
  return ctx.directory
}

export function normalizeRoot(input: string) {
  const resolved = path.resolve(input)
  const root = path.parse(resolved).root
  const trimmed = resolved === root ? resolved : resolved.replace(/[\\/]+$/, "")
  if (process.platform !== "win32") return trimmed
  return trimmed.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()).replaceAll("\\", "/")
}

export async function canonicalRoot(ctx: Context) {
  const candidate = rootCandidate(ctx)
  return normalizeRoot(await realpath(candidate).catch(() => path.resolve(candidate)))
}

export function projectKey(root: string) {
  const normalized = normalizeRoot(root)
  const basename = path.basename(normalized).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"
  return `${basename}-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`
}

export function globalDirectory(data = Global.Path.data) {
  return path.join(data, "memory", "global")
}

export function projectDirectory(data: string, key: string) {
  return path.join(data, "memory", "projects", key)
}

export async function scopeDirectory(ctx: Context, scope: Scope, data = Global.Path.data) {
  if (scope === "global") return globalDirectory(data)
  return projectDirectory(data, projectKey(await canonicalRoot(ctx)))
}

export const MemoryPaths = {
  rootCandidate,
  normalizeRoot,
  canonicalRoot,
  projectKey,
  globalDirectory,
  projectDirectory,
  scopeDirectory,
}
