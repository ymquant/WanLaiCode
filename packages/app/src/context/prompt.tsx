import { createSimpleContext } from "@opencode-ai/ui/context"
import { checksum } from "@opencode-ai/core/util/encode"
import { batch, createComputed, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import { useSessionKey } from "@/pages/session/session-layout"
import { Persist, persisted } from "@/utils/persist"
import { createPromptResetBridge } from "./prompt-reset"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

// 网页链接保留显示文本和目标地址，编辑器可把它渲染成可点击节点并在提交时还原 Markdown。
export interface LinkPart extends PartBase {
  type: "link"
  href: string
  /** 裸 URL 不带 Markdown 包装，提交时保留用户原本的纯文本形式。 */
  plain?: boolean
}

// 本地文件引用与网页链接分开建模，点击时直接打开工作区文件，不弹出网页链接菜单。
export interface FileReferencePart extends PartBase {
  type: "file-reference"
  path: string
  href: string
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
  // 记录粘贴文本的原始长度，用于决定是否展示「恢复到文本框」操作。
  pastedText?: {
    characterCount: number
  }
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

// 与 Codex 兼容的插件 mention pill。content / 显示文本都用 `@<name>` 短形态;
// 发到后端的 wire text 在 draftText 里替换回 `[@<name>](plugin://<addonKey>)` 完整 markdown。
export interface PluginAttachmentPart extends PartBase {
  type: "plugin"
  name: string
  addonKey: string
}

// Skill 在输入框中按 Codex mention chip 显示,wire text 仍保留 `/<name> ` 触发现有命令链路。
export interface SkillPart extends PartBase {
  type: "skill"
  name: string
  location?: string
}

export interface ConversationAttachmentPart extends PartBase {
  type: "conversation"
  id: string
  title: string
  transcript: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
  appSnapshot?: {
    appName: string
    bundleIdentifier?: string
    windowTitle: string
    displayID: string
    imageWidth: number
    imageHeight: number
    accessibilityText: string
    accessibilityTrusted: boolean
    textTruncated: boolean
    capturedAt: number
  }
}

export type ContentPart =
  | TextPart
  | LinkPart
  | FileReferencePart
  | FileAttachmentPart
  | AgentPart
  | PluginAttachmentPart
  | SkillPart
  | ConversationAttachmentPart
  | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

// parsePromptWithPluginMentions 是纯函数——实现在 prompt-parse.ts,可在 bun test 环境无副作用 import。
// 此处 re-export 保持对外接口不变。
export { parsePromptWithPluginMentions } from "./prompt-parse"

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return partB.type === "text" && partA.content === partB.content
    case "link":
      return partB.type === "link" && partA.content === partB.content && partA.href === partB.href && partA.plain === partB.plain
    case "file-reference":
      return partB.type === "file-reference" && partA.content === partB.content && partA.href === partB.href
    case "file":
      return (
        partB.type === "file" &&
        partA.path === partB.path &&
        isSelectionEqual(partA.selection, partB.selection) &&
        // 粘贴附件的恢复能力属于提示词状态，同一路径下元数据变化时也必须触发同步。
        partA.pastedText?.characterCount === partB.pastedText?.characterCount
      )
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "plugin":
      return partB.type === "plugin" && partA.name === partB.name && partA.addonKey === partB.addonKey
    case "skill":
      return partB.type === "skill" && partA.name === partB.name && partA.location === partB.location
    case "conversation":
      return (
        partB.type === "conversation" &&
        partA.id === partB.id &&
        partA.title === partB.title &&
        partA.transcript === partB.transcript
      )
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
  return false
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "link") return { ...part }
  if (part.type === "file-reference") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
  if (part.type === "plugin") return { ...part }
  if (part.type === "skill") return { ...part }
  if (part.type === "conversation") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

function contextItemKey(item: ContextItem) {
  if (item.type !== "file") return item.type
  const start = item.selection?.startLine
  const end = item.selection?.endLine
  const key = `${item.type}:${item.path}:${start}:${end}`

  if (item.commentID) {
    return `${key}:c=${item.commentID}`
  }

  const comment = item.comment?.trim()
  if (!comment) return key
  const digest = checksum(comment) ?? comment
  return `${key}:c=${digest.slice(0, 8)}`
}

function isCommentItem(item: ContextItem | (ContextItem & { key: string })) {
  return item.type === "file" && !!item.comment?.trim()
}

function createPromptActions(
  setStore: SetStoreFunction<{
    prompt: Prompt
    cursor?: number
    addToChatSnippets: string[]
    context: {
      items: (ContextItem & { key: string })[]
    }
  }>,
) {
  return {
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
        setStore("addToChatSnippets", [])
      })
    },
  }
}

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20

type PromptSession = ReturnType<typeof createPromptSession>

type Scope = {
  dir: string
  id?: string
}

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

function createPromptSession(dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`

  const [store, setStore, _, ready] = persisted(
    // 逐键输入都会落一次盘；这是全仓库唯一需要合并写的 key，其余 store（设置/布局/会话元数据）
    // 必须保持直写，容忍不了 400ms 的丢失窗口。
    { ...Persist.scoped(dir, id, "prompt", [legacy]), coalesce: true },
    createStore<{
      prompt: Prompt
      cursor?: number
      addToChatSnippets: string[]
      context: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      addToChatSnippets: [],
      context: {
        items: [],
      },
    }),
  )

  const actions = createPromptActions(setStore)

  return {
    ready,
    current: () => store.prompt,
    cursor: createMemo(() => store.cursor),
    dirty: () => !isPromptEqual(store.prompt, DEFAULT_PROMPT),
    addToChat: {
      snippets: () => store.addToChatSnippets ?? [],
      count: () => (store.addToChatSnippets ?? []).length,
      push(text: string) {
        const next = text.trim()
        if (!next) return
        setStore("addToChatSnippets", (list) => [...(list ?? []), next])
      },
      clear() {
        setStore("addToChatSnippets", [])
      },
      replace(texts: string[]) {
        setStore("addToChatSnippets", texts.map((s) => s.trim()).filter(Boolean))
      },
    },
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const key = contextItemKey(item)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
      removeComment(path: string, commentID: string) {
        setStore("context", "items", (items) =>
          items.filter((item) => !(item.type === "file" && item.path === path && item.commentID === commentID)),
        )
      },
      updateComment(path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) {
        setStore("context", "items", (items) =>
          items.map((item) => {
            if (item.type !== "file" || item.path !== path || item.commentID !== commentID) return item
            const value = { ...item, ...next }
            return { ...value, key: contextItemKey(value) }
          }),
        )
      },
      replaceComments(items: FileContextItem[]) {
        setStore("context", "items", (current) => [
          ...current.filter((item) => !isCommentItem(item)),
          ...items.map((item) => ({ ...item, key: contextItemKey(item) })),
        ])
      },
    },
    set: actions.set,
    reset: actions.reset,
  }
}

// 侧边栏在 PromptProvider 之外，经模块级注册桥接草稿预热：
// hover/按下会话行时提前读 (dir,id) 作用域的持久化草稿，打开时输入框即时可打字
let prewarmHandler: ((dir: string, id: string) => void) | undefined
export function prewarmPromptDraft(dir: string, id: string) {
  prewarmHandler?.(dir, id)
}

const resetBridge = createPromptResetBridge()
export function resetPromptDraft(dir: string) {
  resetBridge.reset(dir)
}

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    // 使用会话页统一的 sessionKey 解析，兼容常驻在 /:dir 父路由下的具体会话 URL。
    const { params } = useSessionKey()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      // 活跃会话的草稿实例不可淘汰：hover 预热大量其它会话时，若把活跃 entry dispose，
      // 其 context/cursor memo 会随 root 冻结，提交时会漏新增上下文或重发已删上下文
      const activeKey = `${params.dir}:${params.id ?? WORKSPACE_KEY}`
      const keys = cache.keys()
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const next = keys.next()
        if (next.done) return
        const key = next.value
        if (key === activeKey) continue
        const entry = cache.get(key)
        entry?.dispose()
        cache.delete(key)
      }
    }

    const owner = getOwner()
    const load = (dir: string, id: string | undefined) => {
      const key = `${dir}:${id ?? WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot(
        (dispose) => ({
          value: createPromptSession(dir, id),
          dispose,
        }),
        owner,
      )

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() => load(params.dir!, params.id))
    const pick = (scope?: Scope) => (scope ? load(scope.dir, scope.id) : session())

    // 预热工作区（新建会话）作用域的草稿读取，点「新建对话」时输入框无需再等异步 IPC
    createComputed(() => {
      if (params.dir) load(params.dir, undefined)
    })

    prewarmHandler = (dir, id) => load(dir, id)
    resetBridge.register((dir) => load(dir, undefined).reset())
    onCleanup(() => {
      prewarmHandler = undefined
      resetBridge.clear()
    })

    return {
      ready: () => session().ready,
      current: () => session().current(),
      cursor: () => session().cursor(),
      dirty: () => session().dirty(),
      addToChat: {
        snippets: () => session().addToChat.snippets(),
        count: () => session().addToChat.count(),
        push: (text: string) => session().addToChat.push(text),
        clear: () => session().addToChat.clear(),
        replace: (texts: string[], scope?: Scope) => pick(scope).addToChat.replace(texts),
      },
      context: {
        items: () => session().context.items(),
        add: (item: ContextItem) => session().context.add(item),
        remove: (key: string) => session().context.remove(key),
        removeComment: (path: string, commentID: string) => session().context.removeComment(path, commentID),
        updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
          session().context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[]) => session().context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: Scope) => pick(scope).set(prompt, cursorPosition),
      reset: (scope?: Scope) => pick(scope).reset(),
    }
  },
})
