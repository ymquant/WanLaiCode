import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@opencode-ai/ui/toast"
import { usePrompt, type ContentPart, type FileAttachmentPart, type ImageAttachmentPart } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { uuid } from "@/utils/uuid"
import {
  recordIssueAction,
  recordIssueEvent,
  stableHash,
  summarizeDragFiles,
  summarizeDroppedText,
} from "@/utils/issue-report-snapshot"
import { getCursorPosition } from "./editor-dom"
import { isFileListText, normalizePaste, pasteMode } from "./paste"
import { orchestratePastedText } from "./paste-orchestrator"
import { pastedTextAttachmentTitle, pastedAttachmentLabel } from "./pasted-text-title"
import { pastedTextDirectory, pastedTextPath } from "./pasted-text-path"
import { attachmentMime, isAbsolutePath, isImageMime, resolveDroppedFilePath, shouldEmbedAttachment } from "./files"

export { pastedTextAttachmentTitle, pastedTextTitle, pastedAttachmentLabel } from "./pasted-text-title"

type PromptAttachmentsInput = {
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
  projectDirectory: () => string
}

function normalizeDataUrl(value: string, mime: string) {
  const marker = value.indexOf(",")
  if (marker === -1) return value
  return `data:${mime};base64,${value.slice(marker + 1)}`
}

function fileReaderDataUrl(file: File, mime: string) {
  if (typeof FileReader === "undefined") return
  const reader = new FileReader()
  if (typeof reader.readAsDataURL !== "function") return
  return new Promise<string>((resolve) => {
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? normalizeDataUrl(reader.result, mime) : "")
    })
    try {
      reader.readAsDataURL(file)
    } catch {
      resolve("")
    }
  })
}

async function arrayBufferDataUrl(file: File, mime: string) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const chunkSize = 0x8000
    let binary = ""
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return `data:${mime};base64,${btoa(binary)}`
  } catch {
    return ""
  }
}

async function dataUrl(file: File, mime: string) {
  const native = fileReaderDataUrl(file, mime)
  if (!native) return arrayBufferDataUrl(file, mime)
  return (await native) || arrayBufferDataUrl(file, mime)
}

function basename(path: string) {
  const normalized = path.replace(/[\\/]+$/, "")
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

function imageMimeFromPath(path: string) {
  const name = basename(path)
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  if (ext === "png") return "image/png"
  if (ext === "gif") return "image/gif"
  if (ext === "webp") return "image/webp"
  if (["jpeg", "jpg"].includes(ext)) return "image/jpeg"
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = usePrompt()
  const language = useLanguage()
  const platform = usePlatform()

  const warn = () => {
    showToast({
      title: language.t("prompt.toast.pasteUnsupported.title"),
      description: language.t("prompt.toast.pasteUnsupported.description"),
    })
  }

  const getFilePath = (file: File) => {
    if (platform.getPathForFile) {
      try {
        const path = platform.getPathForFile(file)
        if (path && isAbsolutePath(path)) return path
      } catch {
        // fallback
      }
    }
    const withPath = file as File & { path?: string; webkitRelativePath?: string }
    if (withPath.path && isAbsolutePath(withPath.path)) return withPath.path
    if (withPath.webkitRelativePath) return withPath.webkitRelativePath
    return file.name
  }

  const addReference = (path: string) => {
    const editor = input.editor()
    if (!editor) return false

    const cursorPosition = prompt.cursor() ?? getCursorPosition(editor)
    const current = prompt.current()
    const rawText = current.map((part) => ("content" in part ? part.content : "")).join("")
    const textBeforeCursor = rawText.substring(0, cursorPosition)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)

    const { parts, cursor } = atMatch
      ? (() => {
          const matchStart = atMatch.index ?? cursorPosition - atMatch[0].length
          const matchEnd = cursorPosition
          let accumulated = 0
          return {
            parts: current.flatMap((part) => {
              if (part.type !== "text") return [part]
              const partEnd = accumulated + part.content.length
              if (matchStart >= accumulated && matchEnd <= partEnd) {
                const before = part.content.slice(0, matchStart - accumulated)
                const after = part.content.slice(matchEnd - accumulated)
                const result: typeof current = []
                if (before) result.push({ ...part, content: before, start: accumulated, end: accumulated + before.length })
                if (after)
                  result.push({
                    ...part,
                    content: after,
                    start: accumulated + before.length,
                    end: accumulated + before.length + after.length,
                  })
                accumulated = partEnd
                return result
              }
              accumulated = partEnd
              return [part]
            }),
            cursor: cursorPosition - atMatch[0].length,
          }
        })()
      : { parts: [...current], cursor: cursorPosition }

    const attachment: FileAttachmentPart = {
      type: "file",
      path,
      content: "@" + basename(path),
      start: 0,
      end: 0,
    }
    prompt.set([...parts, attachment], cursor)
    return true
  }

  const addImage = async (file: File, mime: string, startedAt = performance.now()) => {
    const editor = input.editor()
    if (!editor) return false

    const url = await dataUrl(file, mime)
    if (!url) return false
    recordIssueAction("prompt.attachment.loaded", {
      file: summarizeDragFiles([file])[0],
      mime,
      data_url_bytes: url.length,
      duration_ms: Math.round(performance.now() - startedAt),
    })

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: file.name,
      mime,
      dataUrl: url,
    }
    const cursor = prompt.cursor() ?? getCursorPosition(editor)
    prompt.set([...prompt.current(), attachment], cursor)
    return true
  }

  const add = async (file: File, toast = true) => {
    const startedAt = performance.now()
    const mime = await attachmentMime(file)
    if (!mime) {
      if (toast) warn()
      recordIssueAction("prompt.attachment.rejected", {
        file: summarizeDragFiles([file])[0],
        duration_ms: Math.round(performance.now() - startedAt),
      })
      return false
    }

    const filePath = getFilePath(file)
    if (shouldEmbedAttachment(mime)) return addImage(file, mime, startedAt)
    recordIssueAction("prompt.attachment.fileReference", {
      file: summarizeDragFiles([file])[0],
      mime,
      path_hash: stableHash(filePath),
      duration_ms: Math.round(performance.now() - startedAt),
    })
    return addReference(filePath)
  }

  const addAttachment = (file: File) => add(file)

  const addAttachments = async (files: File[], toast = true) => {
    let found = false

    for (const file of files) {
      const ok = await add(file, false)
      if (ok) found = true
    }

    if (!found && files.length > 0 && toast) warn()
    return found
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const addPastedTextAttachment = async (
    text: string,
    ext: "txt" | "json" = "txt",
    title = pastedTextAttachmentTitle(text, ext),
  ) => {
    const editor = input.editor()
    const writeFile = platform.writeFile
    if (!editor || !writeFile) return

    const label = pastedAttachmentLabel(title, ext)
    const filePath = pastedTextPath(input.projectDirectory(), title, ext)
    // 超长粘贴和 Codex 对齐：先落成本地 txt 附件，避免把大段文本直接塞进编辑器导致会话爆上下文。
    await platform.ensureDirectory?.(pastedTextDirectory(input.projectDirectory()))
    await writeFile(filePath, text)
    recordIssueAction(ext === "json" ? "prompt.paste.jsonAttachment" : "prompt.paste.textAttachment", {
      chars: text.length,
      path_hash: stableHash(filePath),
    })
    const attachment: FileAttachmentPart = {
      type: "file",
      path: filePath,
      content: "@" + label,
      start: 0,
      end: 0,
      pastedText: { characterCount: text.length },
    }
    if (!input.addPart(attachment)) {
      const cursor = prompt.cursor() ?? getCursorPosition(editor)
      prompt.set([...prompt.current(), attachment], cursor)
    }
    input.focusEditor()
    return label
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    const plainText = clipboardData.getData("text/plain") ?? ""

    if (files.length > 0) {
      await addAttachments(files)
      // 剪贴板同时带文字时不能就此返回：社区「一键复制全部」这类图文一体的内容
      // 会只剩附件、正文整段丢掉。图片照旧进附件，文字继续走下面的插入流程。
      // 顶部已 preventDefault，文本插入全程由本函数负责，不存在被浏览器重复插入的风险。
      // 例外：访达/资源管理器复制文件时会把路径塞进 text/plain，那不是正文，照旧丢弃。
      if (!plainText || isFileListText(plainText, files.map((file) => file.name))) return
    }

    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await addAttachment(file)
        return
      }
    }

    if (!plainText) return

    const text = normalizePaste(plainText)
    const putText = (content: string) => {
      if (input.addPart({ type: "text", content, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content, start: 0, end: 0 })
    }

    await orchestratePastedText(text, {
      addText: putText,
      addAttachment: addPastedTextAttachment,
      insertNativeText: (content) =>
        typeof document.execCommand === "function" && document.execCommand("insertText", false, content),
      recordError: (name, err, chars) => {
        recordIssueEvent({
          type: "error",
          name,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          data: { chars },
        })
      },
    })
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return

    const editor = input.editor()
    if (!editor || !editor.contains(event.target as Node)) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
      return
    }
    if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return

    const editor = input.editor()
    if (!editor) {
      if (!event.relatedTarget) {
        input.setDraggingType(null)
      }
      return
    }

    if (editor.contains(event.relatedTarget as Node)) return
    input.setDraggingType(null)
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    input.setDraggingType(null)

    const editor = input.editor()
    if (!editor || !editor.contains(event.target as Node)) return

    const plainText = event.dataTransfer?.getData("text/plain")
    const types = Array.from(event.dataTransfer?.types ?? [])
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = resolveDroppedFilePath(input.projectDirectory(), plainText.slice(filePrefix.length))
      recordIssueAction("prompt.drop.fileReference", {
        types,
        plain_text_length: plainText.length,
        path_hash: stableHash(filePath),
      })
      const imageMime = imageMimeFromPath(filePath)
      if (imageMime && platform.readFileAsDataURL) {
        try {
          const url = await platform.readFileAsDataURL(filePath, imageMime)
          if (url) {
            input.focusEditor()
            const attachment: ImageAttachmentPart = {
              type: "image",
              id: uuid(),
              filename: basename(filePath),
              mime: imageMime,
              dataUrl: url,
            }
            const cursor = prompt.cursor() ?? getCursorPosition(editor)
            prompt.set([...prompt.current(), attachment], cursor)
            return
          }
        } catch (err) {
          recordIssueEvent({
            type: "error",
            name: "prompt.drop.imageDataUrl.failed",
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            data: { path_hash: stableHash(filePath), mime: imageMime },
          })
        }
      }
      addReference(filePath)
      return
    }

    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0) {
      recordIssueAction("prompt.drop.textPlain", {
        types,
        text: summarizeDroppedText(plainText ?? ""),
        branch: "ignored",
      })
      return
    }

    let found = false
    recordIssueAction("prompt.drop.files", {
      types,
      plain_text_length: plainText?.length ?? 0,
      plain_text_summary: plainText ? summarizeDroppedText(plainText) : undefined,
      files: summarizeDragFiles(files),
      branch: "attachments",
    })
    try {
      for (const file of files) {
        const startedAt = performance.now()
        const mime = await attachmentMime(file)
        if (!mime) continue
        found = true
        if (isImageMime(mime)) {
          await addImage(file, mime, startedAt)
          continue
        }
        const filePath = getFilePath(file)
        recordIssueAction("prompt.drop.fileReference", {
          types,
          file: summarizeDragFiles([file])[0],
          path_hash: stableHash(filePath),
          branch: "dropFilePath",
          duration_ms: Math.round(performance.now() - startedAt),
        })
        addReference(filePath)
      }
      if (!found) warn()
    } catch (err) {
      recordIssueEvent({
        type: "error",
        name: "prompt.drop.files.failed",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      throw err
    }
  }

  onMount(() => {
    makeEventListener(document, "dragover", handleGlobalDragOver)
    makeEventListener(document, "dragleave", handleGlobalDragLeave)
    makeEventListener(document, "drop", handleGlobalDrop)
  })

  return {
    addAttachment,
    addAttachments,
    addReference,
    removeAttachment,
    handlePaste,
  }
}
