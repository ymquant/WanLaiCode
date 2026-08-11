import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { produce } from "solid-js/store"
import {
  ensureUnarchivedSessionInSidebar,
  invalidateArchivedSessionsList,
  refreshUnarchivedSessionSidebar,
  removeArchivedSessionFromListCache,
  runSessionMutationInflight,
  sessionAfterUnarchive,
} from "./sync"

export { sessionAfterUnarchive }

type SessionStoreDraft = { session: Session[] }

export function restoreArchivedSessionsToSidebar(
  globalSync: {
    child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  },
  removed: ReadonlyArray<{ dir: string; session: Session; index: number }>,
) {
  for (const item of removed) {
    const [, setStoreRef] = globalSync.child(item.dir, { bootstrap: false })
    const setStore = setStoreRef as (recipe: (draft: SessionStoreDraft) => void) => void
    setStore(
      produce((draft: SessionStoreDraft) => {
        if (draft.session.some((entry) => entry.id === item.session.id)) return
        const insertAt = Math.min(item.index, draft.session.length)
        draft.session.splice(insertAt, 0, sessionAfterUnarchive(item.session))
      }),
    )
  }
}

async function unarchiveSessionTask(input: {
  client: OpencodeClient
  globalSync: {
    data: { project: ReadonlyArray<{ id?: string; worktree: string; sandboxes?: string[] }> }
    project: { refreshSessions: (directory: string) => Promise<void> }
    child: (directory: string, options?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  }
  queryClient: QueryClient
  session: Pick<GlobalSession, "id" | "directory" | "projectID">
}) {
  const response = await input.client.session.update({
    sessionID: input.session.id,
    directory: input.session.directory,
    time: { archived: null as unknown as number },
  })
  const result = response.data
  if (!result || result.time.archived !== undefined) throw new Error("unarchive failed")

  removeArchivedSessionFromListCache(input.queryClient, input.session.id)
  invalidateArchivedSessionsList(input.queryClient)
  await refreshUnarchivedSessionSidebar(input.globalSync, input.session)
  ensureUnarchivedSessionInSidebar(input.globalSync, result)
  return result
}

export async function unarchiveSession(input: {
  client: OpencodeClient
  globalSync: {
    data: { project: ReadonlyArray<{ id?: string; worktree: string; sandboxes?: string[] }> }
    project: { refreshSessions: (directory: string) => Promise<void> }
    child: (directory: string, input?: { bootstrap?: boolean }) => readonly [unknown, unknown]
  }
  queryClient: QueryClient
  session: Pick<GlobalSession, "id" | "directory" | "projectID">
}) {
  return runSessionMutationInflight(input.session.id, () => unarchiveSessionTask(input))
}
