type SaveTextFile = (input: { defaultPath: string; content: string }) => Promise<string | null>

export async function exportSessionTranscript(input: {
  filename: string
  content: string
  save?: SaveTextFile
  download: (filename: string, content: string) => void
}) {
  if (input.save) {
    return !!(await input.save({ defaultPath: input.filename, content: input.content }))
  }

  input.download(input.filename, input.content)
  return true
}
