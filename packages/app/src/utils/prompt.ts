import type { AgentPart as MessageAgentPart, FilePart, Part, TextPart } from "@opencode-ai/sdk/v2"
import type {
  AgentPart,
  ConversationAttachmentPart,
  FileAttachmentPart,
  ImageAttachmentPart,
  Prompt,
} from "@/context/prompt"
import { parseAddToChatUserMessageDisplay } from "@opencode-ai/core/util/add-to-chat-composed-message"
import { parseConversationReferences } from "@opencode-ai/core/util/conversation-reference"
import { createPathHelpers, decodeFilePath, stripFileProtocol, stripQueryAndHash } from "@/context/file/path"
import { fallbackFileReference, isTrustedFileReference } from "@/utils/file-reference"
import { findPromptLinkMatches } from "@/utils/prompt-links"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      matchValue?: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

function pathFromFilePart(part: FilePart) {
  if (part.source?.type === "file") return part.source.path
  if (!part.url.startsWith("file://")) return
  const path = decodeFilePath(stripQueryAndHash(stripFileProtocol(part.url)))
  if (/^\/[A-Za-z]:/.test(path)) return path.slice(1)
  return path
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 * This is used by undo to restore the original user prompt.
 */
export function extractPromptFromParts(parts: Part[], opts?: { directory?: string; attachmentName?: string }): Prompt {
  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const directory = opts?.directory
  const attachmentName = opts?.attachmentName ?? "attachment"
  const pathHelpers = directory ? createPathHelpers(() => directory) : undefined
  const conversations = new Map(
    parts.flatMap((part) => {
      if (part.type !== "text" || !part.synthetic) return []
      const metadata = part.metadata?.conversation_reference
      if (!metadata || typeof metadata !== "object") return []
      if (!("id" in metadata) || !("title" in metadata)) return []
      if (typeof metadata.id !== "string" || typeof metadata.title !== "string") return []
      const transcript = part.text.includes("\n\n") ? part.text.slice(part.text.indexOf("\n\n") + 2) : part.text
      return [[metadata.id, { title: metadata.title, transcript }] as const]
    }),
  )

  const toRelative = (path: string) => {
    if (!pathHelpers) return path
    // 历史恢复必须复用文件上下文的跨平台规范化：只在完整工作区边界命中时剥离根目录，
    // 同时把 Windows 反斜杠转为正斜杠，保证再次提交仍指向同一个文件。
    return pathHelpers.normalize(path)
  }

  const inline: Inline[] = []
  const detached: Extract<Inline, { type: "file" }>[] = []
  const images: ImageAttachmentPart[] = []

  for (const part of parts) {
    if (part.type === "file") {
      const filePart = part as FilePart
      const sourceText = filePart.source?.text
      if (sourceText) {
        const value = sourceText.value
        const start = sourceText.start
        const end = sourceText.end
        const sourcePath = filePart.source?.type === "file" ? filePart.source.path : undefined
        const rawPath = sourcePath ?? (isTrustedFileReference(value) ? value.slice(1) : value)
        // 剥离可能的 @ 前导（如 resource/symbol 源的 value 本身是 @token）
        const path = toRelative(rawPath.startsWith("@") ? rawPath.slice(1) : rawPath)
        const displayValue = isTrustedFileReference(value, sourcePath ?? path)
          ? value
          : sourcePath
            ? fallbackFileReference(sourcePath)
            : fallbackFileReference(path)
        const item = {
          type: "file" as const,
          start,
          end,
          value: displayValue,
          matchValue: value,
          path,
          selection: selectionFromFileUrl(filePart.url),
        }
        if (start === end) detached.push(item)
        else inline.push(item)
        continue
      }

      if (filePart.url.startsWith("data:")) {
        images.push({
          type: "image",
          id: filePart.id,
          filename: filePart.filename ?? attachmentName,
          mime: filePart.mime,
          dataUrl: filePart.url,
        })
        continue
      }

      if (!filePart.url.startsWith("file://")) continue
      const path = pathFromFilePart(filePart)
      if (!path) continue
      detached.push({
        type: "file",
        start: text.length,
        end: text.length,
        value: fallbackFileReference(path),
        path: toRelative(path),
        selection: selectionFromFileUrl(filePart.url),
      })
    }

    if (part.type === "agent") {
      const agentPart = part as MessageAgentPart
      const source = agentPart.source
      if (!source) continue
      inline.push({
        type: "agent",
        start: source.start,
        end: source.end,
        value: source.value,
        name: agentPart.name,
      })
    }
  }

  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  const result: Prompt = []
  const unmatchedFiles: Extract<Inline, { type: "file" }>[] = []
  let position = 0
  let cursor = 0

  const pushPlainText = (content: string) => {
    let cursor = 0
    for (const link of findPromptLinkMatches(content)) {
      const before = content.slice(cursor, link.start)
      if (before) {
        result.push({ type: "text", content: before, start: position, end: position + before.length })
        position += before.length
      }
      if (link.kind === "file") {
        result.push({
          type: "file-reference",
          path: link.href,
          href: link.href,
          content: link.displayText,
          start: position,
          end: position + link.displayText.length,
        })
      } else {
        result.push({
          type: "link",
          href: link.href,
          ...(link.plain ? { plain: true } : {}),
          content: link.displayText,
          start: position,
          end: position + link.displayText.length,
        })
      }
      position += link.displayText.length
      cursor = link.end
    }
    const after = content.slice(cursor)
    if (!after) return
    result.push({ type: "text", content: after, start: position, end: position + after.length })
    position += after.length
  }

  const pushText = (content: string) => {
    const references = parseConversationReferences(content)
    if (references.length === 0) {
      pushPlainText(content)
      return
    }

    let offset = 0
    for (const reference of references) {
      pushPlainText(content.slice(offset, reference.start))
      const context = conversations.get(reference.id)
      const part: ConversationAttachmentPart = {
        type: "conversation",
        id: reference.id,
        title: reference.title,
        transcript: context?.transcript ?? "",
        content: reference.title,
        start: position,
        end: position + reference.title.length,
      }
      result.push(part)
      position += reference.title.length
      offset = reference.end
    }
    pushPlainText(content.slice(offset))
  }

  const pushFile = (item: Extract<Inline, { type: "file" }>) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    result.push(attachment)
    position += content.length
  }

  const pushAgent = (item: Extract<Inline, { type: "agent" }>) => {
    const content = item.value
    const mention: AgentPart = {
      type: "agent",
      name: item.name,
      content,
      start: position,
      end: position + content.length,
    }
    result.push(mention)
    position += content.length
  }

  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.type === "file" ? item.matchValue ?? item.value : item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const fallbackMatch = item.type === "file" && expected !== item.value ? item.value : undefined
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    const resolvedStart = start === -1 && fallbackMatch ? text.indexOf(fallbackMatch, cursor) : start
    if (resolvedStart === -1) {
      if (item.type === "file") unmatchedFiles.push(item)
      continue
    }
    const end = mismatch ? resolvedStart + (start === -1 && fallbackMatch ? fallbackMatch.length : expected.length) : item.end

    pushText(text.slice(cursor, resolvedStart))

    if (item.type === "file") pushFile(item)
    if (item.type === "agent") pushAgent(item)

    cursor = end
  }

  pushText(text.slice(cursor))
  detached.forEach(pushFile)
  unmatchedFiles.forEach(pushFile)

  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  if (images.length === 0) return result
  return [...result, ...images]
}

export type EditorRestoreFromUserParts = {
  prompt: Prompt
  addToChatSnippets: string[]
}

/**
 * Restore the prompt editor from a persisted user message: strip add-to-chat wire formatting from
 * the text part while returning excerpt bodies for `prompt.addToChat.replace`.
 */
export function restoreEditorFromUserParts(
  parts: Part[],
  opts?: { directory?: string; attachmentName?: string },
): EditorRestoreFromUserParts {
  const textPart = textPartValue(parts)
  const full = textPart?.text ?? ""
  const parsed = parseAddToChatUserMessageDisplay(full)
  if (!parsed) {
    return { prompt: extractPromptFromParts(parts, opts), addToChatSnippets: [] }
  }
  const nextParts = parts.map((part) => {
    if (part.type !== "text") return part
    const tp = part as TextPart
    if (tp.synthetic || tp.ignored) return part
    return { ...tp, text: parsed.body }
  })
  return {
    prompt: extractPromptFromParts(nextParts, opts),
    addToChatSnippets: parsed.excerpts,
  }
}
