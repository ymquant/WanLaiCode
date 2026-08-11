import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"

export function globalAutomationDirectory() {
  const directory = path.join(Global.Path.data, "automation", "global")
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

export function runtimeDirectory(directory: string | null | undefined) {
  return directory ?? globalAutomationDirectory()
}

