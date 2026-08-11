import type { Platform } from "@/context/platform"

export type FileManagerInfo = {
  nameKey: "os.fileManager.macos" | "os.fileManager.windows" | "os.fileManager.linux"
  iconId: "finder" | "file-explorer"
}

export function fileManagerInfo(os: Platform["os"]): FileManagerInfo {
  switch (os) {
    case "windows":
      return { nameKey: "os.fileManager.windows", iconId: "file-explorer" }
    case "linux":
      return { nameKey: "os.fileManager.linux", iconId: "file-explorer" }
    default:
      return { nameKey: "os.fileManager.macos", iconId: "finder" }
  }
}
