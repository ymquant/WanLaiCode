export function createPromptResetBridge() {
  let handler: ((dir: string) => void) | undefined
  const pending = new Set<string>()
  return {
    reset(dir: string) {
      if (handler) {
        handler(dir)
        return
      }
      pending.add(dir)
    },
    register(next: (dir: string) => void) {
      handler = next
      for (const dir of pending) handler(dir)
      pending.clear()
    },
    clear() {
      handler = undefined
    },
  }
}
