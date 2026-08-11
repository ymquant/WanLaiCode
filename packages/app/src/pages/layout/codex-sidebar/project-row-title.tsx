import type { JSX } from "solid-js"
import { displayName } from "../helpers"

/** 左侧边栏项目行列表标题：始终只渲染一段显示名。 */
export const ProjectRowTitle = (props: {
  project: { name?: string; worktree: string }
}): JSX.Element => (
  <span class="flex items-baseline min-w-0 w-full" data-project-row-title>
    <span class="truncate text-14-medium text-text-base">{displayName(props.project)}</span>
  </span>
)
