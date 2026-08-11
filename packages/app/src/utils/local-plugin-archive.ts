import type { Platform } from "@/context/platform"

const LOCAL_PLUGIN_ARCHIVE_SUFFIX = /\.(?:tar|tar\.gz|tgz)$/i

export async function pickLocalPluginArchive(platform: Pick<Platform, "openFilePickerDialog">, title: string) {
  const selected = await platform.openFilePickerDialog?.({
    title,
    multiple: false,
    extensions: ["tar", "tar.gz", "tgz"],
  })
  if (typeof selected !== "string") return
  return selected
}

function isAbsolutePath(value: string) {
  const normalized = value.replace(/\\/g, "/")
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
}

export function resolveDroppedLocalPluginArchive(input: {
  files?: ArrayLike<File>
  getPathForFile?: (file: File) => string | undefined
}) {
  if (!input.files || input.files.length !== 1 || !input.getPathForFile) return
  const file = input.files[0]
  if (!file || !LOCAL_PLUGIN_ARCHIVE_SUFFIX.test(file.name)) return

  try {
    const archivePath = input.getPathForFile(file)
    if (!archivePath || !isAbsolutePath(archivePath) || !LOCAL_PLUGIN_ARCHIVE_SUFFIX.test(archivePath)) return
    return archivePath
  } catch {
    return
  }
}
