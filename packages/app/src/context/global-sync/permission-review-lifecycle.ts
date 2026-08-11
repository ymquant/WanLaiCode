import type { PermissionReviewState } from "./types"
import { directoryKey } from "./utils"

const key = (directory: string, sessionID: string, reviewID: string) => `${directoryKey(directory)}\n${sessionID}\n${reviewID}`

const expiry = (review: PermissionReviewState) => (review.status === "approved" ? 1200 : 5000)

export function createPermissionReviewLifecycle() {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const clear = (id: string) => {
    const timer = timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(id)
  }

  const clearMatching = (match: (id: string) => boolean) => {
    for (const id of timers.keys()) {
      if (match(id)) clear(id)
    }
  }

  return {
    sync(input: { directory: string; review: PermissionReviewState; remove: (reviewID: string) => void }) {
      const id = key(input.directory, input.review.sessionID, input.review.id)
      clear(id)
      if (input.review.completedAt === undefined) return
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          input.remove(input.review.id)
        }, expiry(input.review)),
      )
    },
    clearSession(directory: string, sessionID: string) {
      const prefix = `${directoryKey(directory)}\n${sessionID}\n`
      clearMatching((id) => id.startsWith(prefix))
    },
    clearDirectory(directory: string) {
      const prefix = `${directoryKey(directory)}\n`
      clearMatching((id) => id.startsWith(prefix))
    },
    dispose() {
      clearMatching(() => true)
    },
  }
}
