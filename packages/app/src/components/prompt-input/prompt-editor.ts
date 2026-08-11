import type {
  AgentPart,
  ConversationAttachmentPart,
  FileReferencePart,
  FileAttachmentPart,
  ImageAttachmentPart,
  LinkPart,
  PluginAttachmentPart,
  Prompt,
  SkillPart,
} from "@/context/prompt"

export function promptEditorText(prompt: Prompt) {
  return prompt
    .filter((part) => part.type !== "image" && part.type !== "file")
    .map((part) => part.content)
    .join("")
}

type StructuredPart =
  | AgentPart
  | LinkPart
  | FileReferencePart
  | PluginAttachmentPart
  | SkillPart
  | ConversationAttachmentPart

const isStructuredPart = (part: Prompt[number]): part is StructuredPart =>
  part.type === "agent" ||
  part.type === "link" ||
  part.type === "file-reference" ||
  part.type === "plugin" ||
  part.type === "skill" ||
  part.type === "conversation"

const isImagePart = (part: Prompt[number]): part is ImageAttachmentPart => part.type === "image"

const isFilePart = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"

function restoreStructuredPart(part: StructuredPart, start: number, end: number): StructuredPart {
  return { ...part, start, end }
}

function structuredPartMatchText(part: StructuredPart) {
  return part.content
}

export function promptFromEditorText(
  text: string,
  previous: Prompt | ImageAttachmentPart[] = [],
): { prompt: Prompt; cursor: number } {
  const source: Prompt = previous
  const structured = source.filter(isStructuredPart).reduce(
    (state, part) => {
      const matchText = structuredPartMatchText(part)
      const start = text.indexOf(matchText, state.cursor)
      if (start === -1) return state
      const end = start + matchText.length
      return {
        cursor: end,
        parts: [...state.parts, { part, start, end }],
      }
    },
    { cursor: 0, parts: [] as { part: StructuredPart; start: number; end: number }[] },
  ).parts

  const parts = structured.reduce(
    (state, item) => {
      const before = text.slice(state.cursor, item.start)
      return {
        cursor: item.end,
        position: item.end,
        prompt: [
          ...state.prompt,
          ...(before
            ? [{ type: "text" as const, content: before, start: state.position, end: state.position + before.length }]
            : []),
          restoreStructuredPart(item.part, item.start, item.end),
        ],
      }
    },
    { cursor: 0, position: 0, prompt: [] as Prompt },
  )
  const after = text.slice(parts.cursor)
  const prompt = [
    ...parts.prompt,
    ...(after
      ? [{ type: "text" as const, content: after, start: parts.position, end: parts.position + after.length }]
      : []),
  ]

  return {
    prompt: [
      ...(prompt.length ? prompt : [{ type: "text" as const, content: "", start: 0, end: 0 }]),
      ...source.filter(isImagePart),
      ...source.filter(isFilePart),
    ],
    cursor: text.length,
  }
}
