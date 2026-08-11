import { pasteMode } from "./paste"
import { isPureJsonPaste, pasteStrategy, splitPasteSegments } from "./extract-json"
import { jsonAttachmentTitles } from "./json-attachment-title"
import { pastedTextAttachmentTitle } from "./pasted-text-title"

type PasteAttachmentExt = "txt" | "json"

type PasteOrchestratorInput = {
  addText(content: string): void
  addAttachment(content: string, ext?: PasteAttachmentExt, title?: string): Promise<string | undefined>
  insertNativeText?(content: string): boolean
  recordError(name: string, err: unknown, chars: number): void
}

export async function orchestratePastedText(text: string, input: PasteOrchestratorInput) {
  const insertText = async (content: string) => {
    const mode = pasteMode(content)
    if (mode === "attachment") {
      try {
        if (await input.addAttachment(content)) return
      } catch (err) {
        input.recordError("prompt.paste.textAttachment.failed", err, content.length)
      }
      input.addText(content)
      return
    }

    if (mode === "manual") {
      input.addText(content)
      return
    }

    if (input.insertNativeText?.(content)) return
    input.addText(content)
  }

  // 大段非纯 JSON 仍走主分支 txt 附件路径；超长纯 JSON 继续抽出为 json 卡片。
  if (pasteMode(text) === "attachment" && !isPureJsonPaste(text)) {
    await insertText(text)
    return
  }

  const segments = splitPasteSegments(text)
  if (segments.length === 0) return

  const strategy = pasteStrategy(segments)
  const jsonTitles = jsonAttachmentTitles(segments.flatMap((segment) => (segment.type === "json" ? [segment.content] : [])))
  let jsonTitleIndex = 0

  const insertAnchor = (title: string) => {
    input.addText(`@${title}\n`)
  }

  const addJsonAttachment = async (content: string) => {
    const title = jsonTitles[jsonTitleIndex] ?? pastedTextAttachmentTitle(content, "json")
    jsonTitleIndex += 1
    try {
      return await input.addAttachment(content, "json", title)
    } catch (err) {
      input.recordError("prompt.paste.jsonAttachment.failed", err, content.length)
    }
  }

  const insertJsonAttachment = async (content: string) => {
    const attached = await addJsonAttachment(content)
    if (attached) {
      insertAnchor(attached)
      return
    }
    await insertText(content)
  }

  if (strategy.type === "mixed-json" && strategy.textMode === "attachment") {
    const jsonAnchors: string[] = []
    for (const segment of strategy.segments) {
      if (segment.type !== "json") continue
      const attached = await addJsonAttachment(segment.content)
      jsonAnchors.push(attached ? `@${attached}` : segment.content)
    }

    let anchorIndex = 0
    const notes = strategy.segments
      .flatMap((segment) => {
        if (segment.type === "text") return segment.content ? [segment.content] : []
        const anchor = jsonAnchors[anchorIndex] ?? segment.content
        anchorIndex += 1
        return [anchor]
      })
      .join("\n\n")
      .trim()

    try {
      const attached = await input.addAttachment(notes, "txt", "notes.txt")
      if (attached) {
        insertAnchor(attached)
        return
      }
    } catch (err) {
      input.recordError("prompt.paste.textAttachment.failed", err, notes.length)
    }
    input.addText(notes)
    return
  }

  for (const segment of strategy.segments) {
    if (segment.type === "json") {
      await insertJsonAttachment(segment.content)
      continue
    }

    if (strategy.type === "mixed-json") {
      input.addText(segment.rawContent)
      continue
    }

    await insertText(segment.rawContent)
  }
}
