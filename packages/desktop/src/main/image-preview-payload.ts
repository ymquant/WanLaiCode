export type ImagePreviewPayload = {
  src: string
  alt?: string
}

const payloads = new Map<string, ImagePreviewPayload>()

export function stashImagePreviewPayload(input: ImagePreviewPayload) {
  const id = crypto.randomUUID()
  payloads.set(id, input)
  return id
}

export function consumeImagePreviewPayload(id: string) {
  const payload = payloads.get(id)
  payloads.delete(id)
  return payload ?? null
}
