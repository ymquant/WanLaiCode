import type { FileContent } from "@opencode-ai/sdk/v2"

export function AudioPreview(props: { content: FileContent; filename?: string }) {
  const dataUrl = () => {
    const b64 = props.content.content
    if (!b64) return ""
    const mime = props.content.mimeType || "audio/mpeg"
    return `data:${mime};base64,${b64}`
  }

  return (
    <div class="flex flex-col items-center justify-center gap-4 py-12 px-6 h-full">
      <div class="flex flex-col items-center gap-1">
        {props.filename && (
          <span class="text-14-semibold text-text-strong truncate max-w-xs">{props.filename}</span>
        )}
        <span class="text-13-regular text-text-weak">
          {props.content.mimeType || "Audio"}
        </span>
      </div>
      <audio controls class="max-w-md w-full" src={dataUrl()}>
        Your browser does not support the audio element.
      </audio>
    </div>
  )
}
