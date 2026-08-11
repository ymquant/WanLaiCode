import { decodeFilePath } from "@/context/file/path"

export function isMarkdownProjectFilePath(input: string) {
  return /\.(md|markdown|mdx)$/i.test(decodeFilePath(input))
}
