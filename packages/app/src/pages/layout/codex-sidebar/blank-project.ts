const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export const BLANK_PROJECT_DEFAULT_BASE = "New project"

export function sanitizeProjectFolderName(name: string) {
  return name.replace(/[\u0000-\u001F\u007F<>:"/\\|?*]/g, "").replace(/\.+$/, "").trim()
}

export function isValidProjectFolderName(name: string) {
  const folder = sanitizeProjectFolderName(name)
  if (!folder || folder === "." || folder === ".." || folder.includes("..")) return false
  if (WINDOWS_RESERVED.test(folder.replace(/\.+$/, ""))) return false
  return true
}

export function blankProjectCreateErrorKey(err: unknown) {
  if (!(err instanceof Error)) return undefined
  if (err.message.startsWith("Directory already exists:")) return "sidebar.blankProject.error.exists"
  if (err.message === "Invalid project name" || err.message === "Project name is reserved") {
    return "sidebar.blankProject.createDisabled.nameInvalid"
  }
  if (err.message === "Invalid project path") return "sidebar.blankProject.createDisabled.path"
  return undefined
}

export function isAutoIncrementDefaultName(name: string, base = BLANK_PROJECT_DEFAULT_BASE) {
  const folder = sanitizeProjectFolderName(name)
  if (!folder) return false
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+)?$`)
  return pattern.test(folder)
}

/** 与 desktop create-blank-project 相同的递增规则：New project → New project 2 → … */
export function nextAvailableProjectFolderName(base: string, exists: (folderName: string) => boolean) {
  let i = 1
  let name = base
  while (exists(name)) {
    i += 1
    name = `${base} ${i}`
  }
  return name
}

export function joinParentAndName(parent: string, name: string) {
  const trimmed = parent.trim().replace(/[\\/]+$/, "")
  if (!trimmed) return name.trim()
  const sep = trimmed.includes("\\") ? "\\" : "/"
  return `${trimmed}${sep}${name.trim()}`
}
