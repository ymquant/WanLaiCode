import JSZip from "jszip"

export const MAX_ZIP_ENTRIES = 5_000
export const MAX_UNZIP_SIZE = 50 * 1024 * 1024

class OfficeZipBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OfficeZipBudgetError"
  }
}

interface ZipStream {
  on(event: "data", cb: (data: Uint8Array) => void): void
  on(event: "end", cb: () => void): void
  on(event: "error", cb: (error: Error) => void): void
  pause(): void
  resume(): void
}

interface StreamableEntry {
  internalStream(type: "uint8array"): ZipStream
}

function streamEntry(entry: StreamableEntry, onChunk: (len: number) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream("uint8array")
    let aborted = false
    stream.on("data", (chunk: Uint8Array) => {
      if (aborted) return
      const len = chunk instanceof Uint8Array ? chunk.length : (chunk as unknown as ArrayBuffer).byteLength
      if (onChunk(len)) {
        aborted = true
        stream.pause()
        reject(new OfficeZipBudgetError("Office file uncompressed size exceeds limit"))
      }
    })
    stream.on("end", () => {
      if (!aborted) resolve()
    })
    stream.on("error", (error: Error) => {
      if (!aborted) reject(error)
    })
    stream.resume()
  })
}

export async function validateOfficeZip(bytes: Uint8Array): Promise<Uint8Array> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return bytes
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new OfficeZipBudgetError("Office file has too many entries")
  }

  let total = 0
  for (const entry of entries) {
    await streamEntry(entry as unknown as StreamableEntry, (len) => {
      total += len
      return total > MAX_UNZIP_SIZE
    })
  }
  return bytes
}
