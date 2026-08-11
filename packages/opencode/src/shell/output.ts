import { createPtyOutputDecoder } from "@/pty/output-decoder"

function hasEnv(env: NodeJS.ProcessEnv, key: string) {
  if (process.platform !== "win32") return env[key] !== undefined
  const target = key.toLowerCase()
  return Object.keys(env).some((name) => name.toLowerCase() === target)
}

export function withWindowsUtf8ShellEnv(env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32") return env
  return {
    ...env,
    ...(!hasEnv(env, "LC_ALL") ? { LC_ALL: "C.UTF-8" } : {}),
    ...(!hasEnv(env, "LC_CTYPE") ? { LC_CTYPE: "C.UTF-8" } : {}),
    ...(!hasEnv(env, "LANG") ? { LANG: "C.UTF-8" } : {}),
    ...(!hasEnv(env, "PYTHONIOENCODING") ? { PYTHONIOENCODING: "utf-8" } : {}),
    ...(!hasEnv(env, "PYTHONUTF8") ? { PYTHONUTF8: "1" } : {}),
  }
}

export function createShellOutputDecoder() {
  return createPtyOutputDecoder()
}
