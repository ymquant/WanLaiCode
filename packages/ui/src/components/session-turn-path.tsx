const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/
const POSIX_ABSOLUTE_PATH = /^\//
const UNC_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/

export function isAbsoluteFilePath(filePath: string) {
  return WINDOWS_ABSOLUTE_PATH.test(filePath) || POSIX_ABSOLUTE_PATH.test(filePath) || UNC_PATH.test(filePath)
}

export function resolveWorkspaceFilePath(directory: string, filePath: string) {
  if (isAbsoluteFilePath(filePath)) return filePath

  const dir = directory.replace(/\\/g, "/")
  const file = filePath.replace(/\\/g, "/")
  const dirParts = dir.split("/")
  for (let i = dirParts.length; i > 0; i--) {
    const suffix = dirParts.slice(-i).join("/") + "/"
    if (file.startsWith(suffix)) {
      return dirParts.slice(0, -i).join("/") + "/" + file
    }
  }
  return dir + "/" + file
}
