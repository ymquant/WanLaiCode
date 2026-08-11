import type { FileContent } from "@opencode-ai/sdk/v2"

export type FileSelection = {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export type SelectedLineRange = {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

export type FileViewState = {
  scrollTop?: number
  scrollLeft?: number
  selectedLines?: SelectedLineRange | null
}

export type FileState = {
  path: string
  name: string
  loaded?: boolean
  loading?: boolean
  error?: string
  content?: FileContent
}

/** 读取失败时把文件状态切换到可重试的错误态，避免旧内容继续遮住失败提示。 */
export function applyFileLoadError(state: FileState, message: string) {
  state.loaded = false
  state.loading = false
  state.content = undefined
  state.error = message
}

export function selectionFromLines(range: SelectedLineRange): FileSelection {
  const startLine = Math.min(range.start, range.end)
  const endLine = Math.max(range.start, range.end)
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}
