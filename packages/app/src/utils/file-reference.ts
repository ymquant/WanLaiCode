import { getFilename } from "@opencode-ai/core/util/path"

/** 匹配数字占位符引用，如 @123456、@1749705472_000 */
export const NUMERIC_FILE_REFERENCE = /^@\d+(?:[._-]\d+)*$/

/** 从路径派生短形态引用，如 @report.pdf */
export const fallbackFileReference = (path: string) => "@" + getFilename(path)

/** 判断 file part 的 content 是否是可信的引用（非数字占位符，或匹配 fallback 短形态） */
export function isTrustedFileReference(content: string, path?: string) {
  if (!content.startsWith("@")) return false
  if (path && content === fallbackFileReference(path)) return true
  return !NUMERIC_FILE_REFERENCE.test(content)
}
