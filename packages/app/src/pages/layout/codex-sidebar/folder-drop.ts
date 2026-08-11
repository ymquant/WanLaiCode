type FolderDropEntryLike = { isDirectory?: boolean }
type FolderDropItemLike = { webkitGetAsEntry?: () => FolderDropEntryLike | null }

type FolderDropOptions = {
  files?: ArrayLike<File>
  items?: ArrayLike<FolderDropItemLike>
  getPathForFile?: (file: File) => string | undefined
}

const normalizePath = (value: string) => {
  const normalized = value.replace(/\\/g, "/")
  const withoutDrivePrefix = /^\/[A-Za-z]:\//.test(normalized) ? normalized.slice(1) : normalized
  const trimmed = withoutDrivePrefix.replace(/\/+$/, "")
  if (trimmed === "") return "/"
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`
  return trimmed
}

const isAbsolutePath = (value: string) => {
  const normalized = normalizePath(value)
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
}

const getFilePath = (file: File, getPathForFile?: (file: File) => string | undefined) => {
  if (getPathForFile) {
    try {
      const path = getPathForFile(file)
      if (path && isAbsolutePath(path)) return normalizePath(path)
    } catch {
    }
  }
}

const getDirectoryEntry = (item: FolderDropItemLike) => item.webkitGetAsEntry?.()

export const hasDroppedDirectory = (items?: ArrayLike<FolderDropItemLike>) => {
  if (!items) return false
  for (let i = 0; i < items.length; i++) {
    if (getDirectoryEntry(items[i]!)?.isDirectory) return true
  }
  return false
}

export const resolveDroppedDirectoryPath = (options: FolderDropOptions) => {
  const items = options.items
  if (!items) return

  const files = options.files
  const dirIndices: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (getDirectoryEntry(items[i]!)?.isDirectory) dirIndices.push(i)
  }
  if (dirIndices.length === 0) return
  if (dirIndices.length !== 1) return

  const dirIndex = dirIndices[0]!
  if (!files || dirIndex >= files.length) return

  return getFilePath(files[dirIndex]!, options.getPathForFile)
}
