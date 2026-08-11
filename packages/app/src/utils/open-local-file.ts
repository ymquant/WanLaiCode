export const OPEN_LOCAL_FILE_EVENT = "wanlaicode:open-local-file"

export type OpenLocalFileEventDetail = {
  absolutePath: string
}

export function dispatchOpenLocalFile(input: string | OpenLocalFileEventDetail) {
  const detail = typeof input === "string" ? { absolutePath: input } : input
  if (!detail.absolutePath.trim()) return

  window.dispatchEvent(
    new CustomEvent<OpenLocalFileEventDetail>(OPEN_LOCAL_FILE_EVENT, {
      detail,
    }),
  )
}
