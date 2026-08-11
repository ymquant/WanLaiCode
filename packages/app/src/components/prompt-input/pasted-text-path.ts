import { uuid } from "@/utils/uuid"
import { pastedTextTitle } from "./pasted-text-title"

export function joinPath(base: string, ...parts: string[]) {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
  return [base.replace(/[\\/]+$/, ""), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""))]
    .filter(Boolean)
    .join(separator)
}

export function pastedTextDirectory(projectDirectory: string) {
  return joinPath(projectDirectory, ".wanlaicode", "pasted-text")
}

export function pastedTextPath(projectDirectory: string, title: string, ext = "txt") {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
  const base = title.toLowerCase().endsWith(`.${ext}`) ? title.slice(0, -(ext.length + 1)) : title
  return joinPath(pastedTextDirectory(projectDirectory), `${pastedTextTitle(base)}-${stamp}-${uuid().slice(0, 8)}.${ext}`)
}