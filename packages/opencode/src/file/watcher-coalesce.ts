// parcel-watcher 事件在编译等场景下会瞬间产生海量变更。本模块提供纯逻辑：
// 跨批次按「状态转换」合并同一路径的事件，并在超过上限时渐进折叠到祖先目录，
// 保证输出量始终 ≤ cap，避免事件总线/SSE/渲染进程队列被打爆。

export type WatcherEventKind = "add" | "change" | "unlink"

export interface CoalescedEvent {
  file: string
  event: WatcherEventKind
}

const PARCEL_TO_EVENT: Record<string, WatcherEventKind> = {
  create: "add",
  update: "change",
  delete: "unlink",
}

export function parcelKindToEvent(type: string): WatcherEventKind | undefined {
  return PARCEL_TO_EVENT[type]
}

// UNC 根 \\server\share 或 //server/share（无更深层级）。
const UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/

// 兼容 posix / windows 分隔符取父目录。关键：必须让文件系统根（posix `/`、盘符根 `C:\`、
// UNC 根 \\server\share）成为「不动点」并原样返回根本身——否则当工作区就是根时，drain 的
// 渐进折叠既到不了工作区根（客户端把非根路径当文件/未知节点忽略，丢失刷新），也无法收敛
// 到 ≤ cap（各顶层目录停在自身、突破上限）。
export function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  if (idx < 0) return p // 无分隔符
  if (UNC_ROOT.test(p)) return p // UNC 根：父级即自身
  if (idx === 0) return p.slice(0, 1) // posix 根子路径 "/a" → "/"；"/" → "/"
  if (p[idx - 1] === ":") return p.slice(0, idx + 1) // 盘符根 "C:\a" → "C:\"；"C:\" → "C:\"
  return p.slice(0, idx)
}

// 按状态转换合并同一路径在窗口内的多次事件。关键：客户端 invalidateFromWatcher 对
// add/unlink（结构性，刷新父目录列表）与 change（内容，仅刷新已加载目录/已打开文件）
// 处理不同——对「未知文件节点的 change」会直接返回、不刷父目录。因此不能简单保留最后
// 一次 kind：新文件的 add→change 必须保留 add 语义，否则新文件不会出现在文件树。
export function mergeWatcherKind(prev: WatcherEventKind | undefined, next: WatcherEventKind): WatcherEventKind {
  if (prev === undefined) return next
  // 最新的结构性事件（创建/删除）决定最终存在态
  if (next === "add" || next === "unlink") return next
  // next === "change"（内容变更）：若此前是结构性事件，保留结构性语义确保父目录刷新
  if (prev === "add") return "add" // 新文件被修改，仍是「新增」
  if (prev === "unlink") return "add" // 删除后又变更＝重新出现，按结构性新增
  return "change"
}

export class WatcherBuffer {
  private readonly map = new Map<string, WatcherEventKind>()

  add(path: string, kind: WatcherEventKind): void {
    this.map.set(path, mergeWatcherKind(this.map.get(path), kind))
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  // 取出并清空缓冲。唯一路径数 ≤ cap 时逐文件输出（保留合并后的 kind）；超过 cap 时
  // 渐进折叠到祖先目录（每级取 parentDir）直到唯一目录数 ≤ cap，输出目录级 change 事件，
  // 确保输出量始终 ≤ cap（分散在大量目录的构建产物也不会把下游打满）。
  drain(cap: number): CoalescedEvent[] {
    if (this.map.size === 0) return []
    if (this.map.size <= cap) {
      const events: CoalescedEvent[] = []
      for (const [file, event] of this.map) events.push({ file, event })
      this.map.clear()
      return events
    }
    let dirs = new Set<string>()
    for (const file of this.map.keys()) dirs.add(parentDir(file))
    this.map.clear()
    // 逐级向上折叠，直到目录数 ≤ cap 或无法再收敛（已到各自根，size 不再变小）。
    while (dirs.size > cap) {
      const next = new Set<string>()
      for (const d of dirs) next.add(parentDir(d))
      if (next.size >= dirs.size) break
      dirs = next
    }
    return [...dirs].map((file) => ({ file, event: "change" as const }))
  }
}
