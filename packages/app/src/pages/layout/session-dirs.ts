import { pathKey } from "@/utils/path-key"
import { isScratchSessionPath } from "@/utils/scratch"

export function resolveVisibleSessionDirs<Project>(input: {
  activeDir: string | undefined
  scratchDir: string | undefined
  project: Project | undefined
  workspaceEnabled: boolean
  workspaceExpanded: Record<string, boolean | undefined>
  projectWorktree: (project: Project) => string
  workspaceIds: (project: Project) => readonly string[]
}) {
  if (isScratchSessionPath(input.activeDir, input.scratchDir)) return input.activeDir ? [input.activeDir] : []

  const project = input.project
  if (!project) return []
  const worktree = input.projectWorktree(project)
  if (!input.workspaceEnabled) return [worktree]

  return input.workspaceIds(project).filter((directory) => {
    const expanded = input.workspaceExpanded[directory] ?? directory === worktree
    const active = input.activeDir ? pathKey(directory) === pathKey(input.activeDir) : false
    return expanded || active
  })
}
