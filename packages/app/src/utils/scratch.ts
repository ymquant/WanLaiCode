import { pathKey } from "./path-key"

const SCRATCH_SESSIONS_DIR = "scratch-sessions"

export const isScratchSessionPath = (path: string | undefined, scratch?: string) => {
  if (!path) return false
  const key = pathKey(path)
  if (scratch && key === pathKey(scratch)) return true
  return key.split("/").filter(Boolean).at(-1) === SCRATCH_SESSIONS_DIR
}
