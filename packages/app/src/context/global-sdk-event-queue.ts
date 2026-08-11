import type { Event } from "@opencode-ai/sdk/v2/client"

export type QueuedEvent = { directory: string; payload: Event }

export const deltaKey = (directory: string, messageID: string, partID: string) =>
  `${directory}:${messageID}:${partID}`

type WatcherEventKind = "add" | "change" | "unlink"

// 与 opencode 端 watcher-coalesce.mergeWatcherKind 语义一致（跨包无法共享，重复实现）：
// add/unlink（结构性）与 change（内容）对下游 invalidateFromWatcher 处理不同，新文件的
// add→change 必须保留 add，否则父目录不刷新、新文件不出现在树里。
const mergeWatcherKind = (prev: WatcherEventKind, next: WatcherEventKind): WatcherEventKind => {
  if (next === "add" || next === "unlink") return next
  if (prev === "add" || prev === "unlink") return "add"
  return "change"
}

const watcherKind = (payload: Event): WatcherEventKind | undefined => {
  if (payload.type !== "file.watcher.updated") return undefined
  const event = (payload.properties as { event?: unknown }).event
  return event === "add" || event === "change" || event === "unlink" ? event : undefined
}

// 合并队列中被 coalesce 的同 key 事件：file.watcher.updated 按状态转换合并 kind（保留结构
// 性语义），其它类型直接用新事件替换（保持原有「保留最后一次」语义）。
export const mergeCoalescedPayload = (prev: Event, next: Event): Event => {
  const prevKind = watcherKind(prev)
  const nextKind = watcherKind(next)
  if (prevKind && nextKind) {
    const merged = mergeWatcherKind(prevKind, nextKind)
    if (merged !== nextKind) return { ...next, properties: { ...next.properties, event: merged } } as Event
  }
  return next
}

export const coalescedEventKey = (directory: string, payload: Event) => {
  if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
  if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
  if (payload.type === "message.part.updated") {
    const part = payload.properties.part
    return `message.part.updated:${directory}:${part.messageID}:${part.id}`
  }
  // 同一文件的高频重复变更（编译时反复写同一产物）合并为最后一次，避免队列被同文件刷屏。
  if (payload.type === "file.watcher.updated") {
    const file = (payload.properties as { file?: unknown }).file
    return `file.watcher.updated:${directory}:${typeof file === "string" ? file : ""}`
  }
}

export const filterStaleDeltas = (items: QueuedEvent[], staleDeltaCutoffs: ReadonlyMap<string, number>) => {
  if (staleDeltaCutoffs.size === 0) return items
  return items.filter((event, index) => {
    if (event.payload.type !== "message.part.delta") return true
    const props = event.payload.properties
    const cutoff = staleDeltaCutoffs.get(deltaKey(event.directory, props.messageID, props.partID))
    return cutoff === undefined || index >= cutoff
  })
}
