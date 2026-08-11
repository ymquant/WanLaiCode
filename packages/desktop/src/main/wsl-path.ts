import { execFileSync } from "node:child_process"

export function wslPath(path: string, mode: "windows" | "linux" | null): string {
  if (process.platform !== "win32") return path
  if (/[\u0000-\u001F\u007F]/.test(path)) throw new Error("Invalid path")

  const flag = mode === "windows" ? "-w" : "-u"
  try {
    const output = execFileSync("wsl", ["-e", "wslpath", flag, path])
    return output.toString().trim()
  } catch (error) {
    throw new Error(`Failed to run wslpath: ${String(error)}`, { cause: error })
  }
}
