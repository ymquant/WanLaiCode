import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export const QUICK_CHAT_OPEN_EVENT = "wanlaicode:quick-chat-open"
export const QUICK_CHAT_ATTACH_EVENT = "wanlaicode:quick-chat-attach"

export type QuickChatReference = {
  id: string
  title: string
  transcript: string
}

// "unhandled" 覆盖的是「按钮可点但没人接事件」：子会话、permission/question 阻塞态、
// prompt 尚未 ready 时 PromptInput 并未挂载。这种情况必须能和成功区分开，
// 否则会提示添加成功而引用其实没插进去。
export type QuickChatAttachResult = "added" | "duplicate" | "unhandled"

// 事件回执：监听方把处理结果写回 detail.result。
// 不能用 dispatchEvent 的布尔返回值判断——它只表示「没被 preventDefault」，
// 零监听器时同样返回 true。
export type QuickChatAttachDetail = QuickChatReference & { result?: Exclude<QuickChatAttachResult, "unhandled"> }

export type QuickChatModelSelection = {
  model: { providerID: string; modelID: string; variant?: string }
}

let modelSelection: QuickChatModelSelection | undefined
let modelSelectionOwner: symbol | undefined

// owner 是写入方（目录页模型桥）的身份。目录 A→B 切换时 A 的 onCleanup 可能晚于 B 的
// effect 执行，无条件清空会抹掉 B 刚写入的快照，所以释放时必须确认自己仍是持有者。
export function updateQuickChatModelSelection(input: QuickChatModelSelection, owner: symbol) {
  modelSelection = { ...input, model: { ...input.model } }
  modelSelectionOwner = owner
}

export function releaseQuickChatModelSelection(owner: symbol) {
  if (modelSelectionOwner !== owner) return
  modelSelection = undefined
  modelSelectionOwner = undefined
}

export function quickChatModelSelection() {
  return modelSelection ? { ...modelSelection, model: { ...modelSelection.model } } : undefined
}

// 额度边界：只接受用户自己选过的模型——当前目录快照优先，其次全局最近使用。
// 两者都不可用时返回 undefined 让发送直接失败，绝不能回退到 provider 默认模型，
// 那正是本次要修的「用独立目录默认模型绕开额度限制」同一条路径。
export function resolveQuickChatModelSelection(input: {
  snapshot: QuickChatModelSelection | undefined
  recent: readonly QuickChatModelSelection["model"][]
  valid: (model: QuickChatModelSelection["model"]) => boolean
}): QuickChatModelSelection | undefined {
  const snapshot = input.snapshot
  if (snapshot && input.valid(snapshot.model)) return { model: { ...snapshot.model } }
  const recent = input.recent.find((model) => input.valid(model))
  return recent ? { model: { ...recent } } : undefined
}

export function quickChatModelContext(input: {
  model: { providerID: string; modelID: string; variant?: string }
}) {
  return {
    create: {
      model: { id: input.model.modelID, providerID: input.model.providerID, variant: input.model.variant },
    },
    prompt: {
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
    },
  }
}

export function openQuickChat(id?: string) {
  window.dispatchEvent(new CustomEvent(QUICK_CHAT_OPEN_EVENT, { detail: { id } }))
}

export function attachQuickChatToTask(reference: QuickChatReference): QuickChatAttachResult {
  const detail: QuickChatAttachDetail = { ...reference }
  window.dispatchEvent(new CustomEvent(QUICK_CHAT_ATTACH_EVENT, { detail }))
  return detail.result ?? "unhandled"
}

const visibleText = (parts: readonly Part[] | undefined) =>
  (parts ?? [])
    .flatMap((part) => {
      if (part.type !== "text") return []
      if (part.synthetic || part.ignored || !part.text.trim()) return []
      return [part.text.trim()]
    })
    .join("\n")

export function quickChatTranscript(input: {
  messages: readonly Pick<Message, "id" | "role">[]
  partsByMessage: Record<string, Part[] | undefined>
  maxChars?: number
}) {
  const rows = input.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return []
    const text = visibleText(input.partsByMessage[message.id])
    if (!text) return []
    return [`${message.role === "user" ? "User" : "Assistant"}: ${text}`]
  })
  const max = input.maxChars ?? 24_000
  const selected: string[] = []
  let size = 0

  for (const row of rows.toReversed()) {
    const next = row.length + (selected.length > 0 ? 2 : 0)
    if (selected.length > 0 && size + next > max) break
    selected.push(row.length > max ? row.slice(row.length - max) : row)
    size += next
  }

  return selected.reverse().join("\n\n")
}
