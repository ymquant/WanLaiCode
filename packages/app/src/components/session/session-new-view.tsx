import { createMemo, type ParentProps } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/core/util/path"
import { pathKey } from "@/utils/path-key"
import { isScratchSessionPath } from "@/utils/scratch"

const ROOT_CLASS = "size-full flex flex-col"

interface NewSessionViewProps extends ParentProps {
  worktree: string
}

// Codex 风空会话欢迎页：居中大字 "我们该在 X 中做什么?"
export function NewSessionView(props: NewSessionViewProps) {
  const sync = useSync()
  const sdk = useSDK()
  const layout = useLayout()
  const language = useLanguage()

  // URL 是用户意图的权威；sync.project.worktree 在多 worktree 场景下会被服务端
  // path API 回退到根项目（如 p1），所以这里以 sdk.directory 为先
  const projectRoot = createMemo(() => sdk.directory || sync.project?.worktree)
  // 项目名解析：当前 root 不是散对话目录时，按 layout.projects 反查；散对话目录或解析失败时返回空
  // → 由 title memo 决定走 "我们该做什么？" noProject 兜底
  const projectName = createMemo(() => {
    const root = projectRoot()
    if (!root || isScratchSessionPath(root)) return ""
    const list = layout.projects.list()
    const target = pathKey(root)
    const matched = list.find((project) => pathKey(project.worktree) === target)
    if (matched) {
      const name = matched.name?.trim() || getFilename(matched.worktree)
      if (name) return name
    }
    const direct = sync.project?.name?.trim()
    if (direct) return direct
    return getFilename(root)
  })

  const title = createMemo(() => {
    const name = projectName()
    if (!name) return language.t("session.new.codex.title.noProject")
    return language.t("session.new.codex.title", { project: name })
  })

  return (
    <div class={ROOT_CLASS}>
      <div class="h-12 shrink-0" aria-hidden />
      <div class="flex-1 px-6 pb-8 flex items-end justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center">
          <h1
            class="text-text-strong tracking-[-0.01em] leading-tight select-text"
            style={{ "font-size": "26px", "font-weight": "500" }}
          >
            {title()}
          </h1>
        </div>
      </div>
      {props.children}
    </div>
  )
}
