export const appSnapshotDataUrl = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return `data:image/png;base64,${btoa(binary)}`
}
