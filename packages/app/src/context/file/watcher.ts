import type { FileNode } from "@opencode-ai/sdk/v2"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => FileNode | undefined
  isDirLoaded: (path: string) => boolean
  isDirError?: (path: string) => boolean
  refreshDir: (path: string) => void
}

function hasErrorAncestor(path: string, isDirError?: (path: string) => boolean) {
  if (!isDirError) return false
  const parts = path.split("/")
  // 从 path 本身开始，逐级向上遍历到根目录（""），检查是否有任何一级祖先处于 error 状态。
  for (let i = parts.length; i >= 0; i -= 1) {
    const ancestor = parts.slice(0, i).join("/")
    if (isDirError(ancestor)) return true
  }
  return false
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const rawPath = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  // normalize 对「工作区根本身」返回 ""（drain 折叠到工作区根时会产生根事件）。不能像以前
  // 那样 `if (!path) return` 直接丢弃——否则根目录 change 到不了 refreshDir("")，工作区就是根
  // (或大量顶层目录变更折叠到根)时永不刷新。仅在非空路径上做 .git 过滤与 loadFile。
  if (path.startsWith(".git/")) return

  if (path !== "" && (ops.hasFile(path) || ops.isOpen?.(path))) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir = (() => {
      if (path === "") return ""
      const node = ops.node(path)
      if (node?.type !== "directory") return
      return path
    })()
    if (dir === undefined) return
    if (!ops.isDirLoaded(dir)) return
    if (hasErrorAncestor(dir, ops.isDirError)) return

    ops.refreshDir(dir)
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = path.split("/").slice(0, -1).join("/")
  if (!ops.isDirLoaded(parent)) return
  if (hasErrorAncestor(parent, ops.isDirError)) return

  ops.refreshDir(parent)
}

type InvalidatorOptions = WatcherOps & {
  debounceMs?: number
  schedule?: (fn: () => void) => void
}

// 把高频 watcher 事件按目标目录合并：同一目录在 debounce 窗口内只刷新一次，
// 避免文件频繁变化时对后端 list 形成请求风暴；窗口内的事件乱序也因合并刷新天然消解
// （刷新读取真实磁盘状态，与窗口内事件的先后顺序无关）。
export function createWatcherInvalidator(options: InvalidatorOptions) {
  const debounceMs = options.debounceMs ?? 120
  const pending = new Set<string>()
  let scheduled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    scheduled = false
    timer = undefined
    const dirs = [...pending]
    pending.clear()
    for (const dir of dirs) options.refreshDir(dir)
  }

  const schedule =
    options.schedule ??
    ((fn: () => void) => {
      timer = setTimeout(fn, debounceMs)
    })

  const enqueue = (dir: string) => {
    pending.add(dir)
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  return {
    handle(event: WatcherEvent) {
      invalidateFromWatcher(event, { ...options, refreshDir: enqueue })
    },
    // 组件卸载时取消挂起的 flush，避免对已销毁的 store 写入（仅清理默认 schedule 的 timer）。
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      scheduled = false
      pending.clear()
    },
  }
}
