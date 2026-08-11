import { getFilename } from "@opencode-ai/core/util/path"
import { type AgentPartInput, type FilePartInput, type Part, type TextPartInput } from "@opencode-ai/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type {
  AgentPart,
  ConversationAttachmentPart,
  FileAttachmentPart,
  ImageAttachmentPart,
  Prompt,
  SkillPart,
} from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  /** Text sent to the server (e.g. add-to-chat wire format). */
  text: string
  /** When set, optimistic UI uses this for the user text part instead of `text`. */
  optimisticText?: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"
const isSkillPart = (part: Prompt[number]): part is SkillPart => part.type === "skill"
const isConversationAttachment = (part: Prompt[number]): part is ConversationAttachmentPart =>
  part.type === "conversation"
export const appSnapshotContext = (attachment: ImageAttachmentPart) => {
  const snapshot = attachment.appSnapshot
  if (!snapshot) return
  const header = JSON.stringify({
    app: snapshot.appName,
    bundle_identifier: snapshot.bundleIdentifier,
    window: snapshot.windowTitle,
    capture_scope: "display",
    display_id: snapshot.displayID,
    image_width: snapshot.imageWidth,
    image_height: snapshot.imageHeight,
    captured_at: new Date(snapshot.capturedAt).toISOString(),
    accessibility_text_truncated: snapshot.textTruncated,
  })
  const body = snapshot.accessibilityTrusted
    ? snapshot.accessibilityText.trim() || "No readable accessibility text was exposed by the foreground application."
    : "Accessibility permission was unavailable, so this snapshot contains visual content only."
  return `App snapshot metadata: ${header}\nAccessible foreground application text (including off-screen content when exposed by macOS):\n${body}`
}
const skillArguments = (prompt: Prompt, skill: SkillPart) =>
  prompt
    .slice(prompt.indexOf(skill) + 1)
    .flatMap((part) =>
      part.type === "text" || part.type === "link" || part.type === "file-reference" ? [part.content] : [],
    )
    .join("")
    .trim()

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const textPartId = Identifier.ascending("part")
  const userText = input.text
  const optimisticUserText = input.optimisticText ?? userText
  const skill = input.prompt.find(isSkillPart)
  const argumentsText = skill ? skillArguments(input.prompt, skill) : ""
  const requestParts: PromptRequestPart[] = [
    {
      id: textPartId,
      type: "text",
      text: userText,
      ...(skill
        ? {
            metadata: {
              skill: {
                name: skill.name,
                ...(skill.location ? { location: skill.location } : {}),
                ...(argumentsText ? { arguments: argumentsText } : {}),
              },
            },
          }
        : {}),
    },
  ]

  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url: `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: getFilename(attachment.path),
    } satisfies PromptRequestPart
  })

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = absolute(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) return [filePart]

    const mentions = parseCommentMentions(comment).flatMap((path) => {
      const url = `file://${encodeFilePath(absolute(input.sessionDirectory, path))}`
      if (used.has(url)) return []
      used.add(url)
      return [
        {
          id: Identifier.ascending("part"),
          type: "file",
          mime: "text/plain",
          url,
          filename: getFilename(path),
        } satisfies PromptRequestPart,
      ]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
        metadata: createCommentMetadata({
          path: item.path,
          selection: item.selection,
          comment,
          preview: item.preview,
          origin: item.commentOrigin,
        }),
      } satisfies PromptRequestPart,
      filePart,
      ...mentions,
    ]
  })

  const images = input.images.map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    } satisfies PromptRequestPart
  })

  const conversations = input.prompt.filter(isConversationAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "text",
      text: [`Conversation reference: ${attachment.title}`, attachment.transcript].filter(Boolean).join("\n\n"),
      synthetic: true,
      metadata: {
        conversation_reference: {
          id: attachment.id,
          title: attachment.title,
        },
      },
    } satisfies PromptRequestPart
  })

  const appSnapshots = input.images.flatMap((attachment) => {
    const text = appSnapshotContext(attachment)
    if (!text) return []
    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text,
        synthetic: true,
        metadata: { app_snapshot: true },
      } satisfies PromptRequestPart,
    ]
  })

  requestParts.push(...conversations, ...files, ...context, ...agents, ...appSnapshots, ...images)

  const optimisticParts = requestParts.map((part) => {
    if (part.type === "text" && part.id === textPartId && optimisticUserText !== userText) {
      return toOptimisticPart({ ...part, text: optimisticUserText }, input.sessionID, input.messageID)
    }
    return toOptimisticPart(part, input.sessionID, input.messageID)
  })

  return {
    requestParts,
    optimisticParts,
  }
}
