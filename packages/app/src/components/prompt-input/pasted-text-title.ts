import { jsonAttachmentTitles } from "./json-attachment-title"

export function pastedTextTitle(text: string) {
  const title = text
    .trim()
    .split(/\s+/)
    .join(" ")
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
  return (title || "pasted-text").slice(0, 48)
}

export function pastedTextAttachmentTitle(text: string, ext: "txt" | "json" = "txt") {
  if (ext === "json") return jsonAttachmentTitles([text])[0] ?? "JSON-1.json"
  return pastedTextTitle(text)
}

/** Card/anchor label aligned with main: human title, not the unique on-disk stamped filename. */
export function pastedAttachmentLabel(title: string, ext: "txt" | "json" = "txt") {
  if (title.toLowerCase().endsWith(`.${ext}`)) return title
  if (ext === "json") return `${title}.json`
  return title
}
