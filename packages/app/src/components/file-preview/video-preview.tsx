import type { FileContent } from "@opencode-ai/sdk/v2"

export function VideoPreview(props: { content: FileContent; filename?: string }) {
  const dataUrl = () => {
    const b64 = props.content.content
    if (!b64) return ""
    const mime = props.content.mimeType || "video/mp4"
    return `data:${mime};base64,${b64}`
  }

  return (
    <div class="flex flex-col items-center justify-center gap-4 py-8 px-6 h-full">
      <div class="flex flex-col items-center gap-1">
        {props.filename && (
          <span class="text-14-semibold text-text-strong truncate max-w-xs">{props.filename}</span>
        )}
        <span class="text-13-regular text-text-weak">
          {props.content.mimeType || "Video"}
        </span>
      </div>
      <video controls class="max-w-2xl w-full max-h-[60vh]" src={dataUrl()}>
        Your browser does not support the video element.
      </video>
    </div>
  )
}
