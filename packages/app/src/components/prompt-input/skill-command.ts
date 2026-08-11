import type { ImageAttachmentPart, Prompt } from "@/context/prompt"

export function skillCommandText(name: string) {
  return `/${name.trim()} `
}

export function skillCommandPrompt(
  name: string,
  images: ImageAttachmentPart[] = [],
  location?: string,
): { prompt: Prompt; cursor: number } {
  const trimmed = name.trim()
  const text = skillCommandText(name)
  return {
    prompt: [{ type: "skill", name: trimmed, location, content: text, start: 0, end: text.length }, ...images],
    cursor: text.length,
  }
}
