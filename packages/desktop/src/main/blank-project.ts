import { existsSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import os from "node:os"

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export const BLANK_PROJECT_DEFAULT_BASE = "New project"

export function blankProjectParent(parent?: string) {
  const trimmed = parent?.trim()
  if (trimmed && /[\u0000-\u001F\u007F]/.test(trimmed)) throw new Error("Invalid project path")
  return trimmed || join(os.homedir(), "Documents")
}

export function sanitizeBlankProjectFolderName(name: string) {
  return name.replace(/[\u0000-\u001F\u007F<>:"/\\|?*]/g, "").replace(/\.+$/, "").trim()
}

export function assertBlankProjectFolderName(name: string) {
  const folder = sanitizeBlankProjectFolderName(name)
  if (!folder || folder === "." || folder === ".." || folder.includes("..")) throw new Error("Invalid project name")
  if (process.platform === "win32" && WINDOWS_RESERVED.test(folder.replace(/\.+$/, ""))) {
    throw new Error("Project name is reserved")
  }
  return folder
}

export function resolveBlankProjectTarget(parentInput: string | undefined, name: string) {
  const folder = assertBlankProjectFolderName(name)
  const parent = resolve(blankProjectParent(parentInput))
  const target = resolve(parent, folder)
  const rel = relative(parent, target)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Invalid project path")
  return target
}

export function blankProjectPathExists(parentInput: string | undefined, name: string) {
  try {
    return existsSync(resolveBlankProjectTarget(parentInput, name))
  } catch {
    return false
  }
}

export function nextBlankProjectFolderName(parent: string, base: string) {
  let i = 1
  let name = base
  while (existsSync(join(parent, name))) {
    i += 1
    name = `${base} ${i}`
  }
  return name
}
