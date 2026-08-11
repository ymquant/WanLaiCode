import { ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export { ACCEPTED_FILE_TYPES }

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/
const POSIX_ABSOLUTE_PATH = /^\//
const UNC_PATH = /^(?:\\\\|\/\/)/

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export function isAbsolutePath(path: string) {
  return WINDOWS_ABSOLUTE_PATH.test(path) || POSIX_ABSOLUTE_PATH.test(path) || UNC_PATH.test(path)
}

export function isImageMime(mime: string) {
  return mime.startsWith("image/")
}

export function resolveDroppedFilePath(directory: string, path: string) {
  if (isAbsolutePath(path)) return path
  const separator = path.startsWith("/") || path.startsWith("\\") ? "" : "/"
  return directory.replace(/[\\/]+$/, "") + separator + path
}

export function shouldEmbedAttachment(mime: string) {
  return isImageMime(mime)
}

export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type

  const suffix = ext(file.name)
  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (textMime(type)) return "text/plain"
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (textBytes(bytes)) return "text/plain"
  // 解除文件类型限制：任意文件都可作为附件（非图片走文件引用），不再拒绝二进制文件。
  return type || "application/octet-stream"
}
