import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { serializePromptLink } from "@/utils/prompt-links"
import { imageGenerationClientConfig } from "@/utils/session-error-messages"
import { resolveError } from "@opencode-ai/core/error/resolve"
import { composeAddToChatUserMessage } from "@opencode-ai/core/util/add-to-chat-composed-message"
import { buildPluginMention } from "@opencode-ai/core/util/mention"
import { buildConversationReference } from "@opencode-ai/core/util/conversation-reference"
import { isImageGenerationModel } from "./image-generation"
import { isFreeModel } from "@/components/model-filter"
import { isWanlaiCodeNoEntitlementProvider } from "@/hooks/use-providers"
import { retry } from "@opencode-ai/core/util/retry"
import { createOptimisticSession, isTransportError, newSessionID } from "./optimistic-session"
import { followupActualSteerTarget, followupFailureIsStaleSteerTarget } from "@/pages/session/followup-queue"

export function shouldDivertToGoal(input: { active: boolean; text: string; mode?: "normal" | "shell" }): boolean {
  if (!input.active) return false
  if (input.mode !== undefined && input.mode !== "normal") return false
  const text = input.text.trim()
  if (!text) return false
  // 斜杠命令放行走命令路径，不被吞成「替换目标」
  if (text.startsWith("/")) return false
  return true
}

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()
const DIRECT_RENAME_SLASHES = new Set(["rename", "重命名", "重新命名"])

function directRenameTitle(text: string) {
  const match = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return
  if (!DIRECT_RENAME_SLASHES.has(match[1])) return
  const title = match[2]?.trim()
  if (!title) return
  return title
}

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  /** Snapshot when queuing; wire text is composed only inside `sendFollowupDraft`. */
  addToChatSnippets?: string[]
  context: (ContextItem & { key: string })[]
  images?: ImageAttachmentPart[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  // 显式生图引导会先进入统一 follow-up 通道；把用户当时选择的尺寸和数量一并快照，避免接力发送时丢失配置。
  imageGeneration?: {
    count?: number
    size?: string
    output_format?: "png" | "jpeg" | "webp"
    error_messages?: Record<string, string>
    failure_prefix?: string
    loading_text?: string
  }
}

// 引导只有拿到 durable ACK 才能从本地草稿交接为真实消息；超时后会按固定 messageID 查询服务端，避免盲目重发。
export const STEER_ACK_TIMEOUT_MS = 30_000

// 缺少发送时快照的 active turn 说明引导意图已失效，必须在创建 optimistic 气泡前阻止请求。
export class MissingSteerTargetError extends Error {
  readonly name = "MissingSteerTargetError"

  constructor() {
    super("Manual steer requires a target turn ID")
  }
}

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  globalSync: ReturnType<typeof useGlobalSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  imageGeneration?: FollowupDraft["imageGeneration"]
  messageID?: string
  optimisticBusy?: boolean
  keepOptimisticOnFailure?: boolean
  noReply?: boolean
  steer?: boolean
  // steer 首次请求绑定用户产生意图时的快照；仅服务端 expected mismatch 回报的实际活动 turn 可以改绑一次。
  targetTurnID?: string
  // 官方会先把 steering item 追加到当前 turn，再等待权威 turnID；该临时目标只负责等待期间的 UI 归组。
  optimisticTargetTurnID?: string
  // busy 事件可能先于 turnID 到达；发送链必须保持同一 steer 请求并等待，不能退化成普通队列。
  waitForSteerTarget?: () => Promise<string>
  /** 服务端发现本地目标过期但仍有活动回合时，更新调用方的顺序锁目标。 */
  onSteerRetarget?: (turnID: string) => void
  /** steer 目标已经失效且没有可重试活动回合时，通知调用方后续按普通回合跟踪。 */
  onSteerFallback?: () => void
  /** 仅本地主机兼容官方旧版 NoActiveTurn 文本；远程主机必须依赖稳定领域错误。 */
  localHost?: boolean
  /** 页面重挂或用户停止后，旧发送链只能结束请求，不能再次写 optimistic 状态或开启 fallback 回合。 */
  canContinue?: () => boolean
  /** 停止发生在 durable ACK 前时主动取消网络等待，让会话级发送锁立即交给恢复项。 */
  signal?: AbortSignal
  steerAckTimeoutMs?: number
  // 主会话恢复时可追加隐藏上下文；它只进入请求载荷，不参与可见 optimistic 消息的渲染。
  syntheticContext?: string[]
  // 所有 follow-up 入口必须先持久化权限模式，成功后才能写 optimistic 状态或调用会话 API。
  preflight: () => Promise<void>
  // 直接提交在权限预检前快照命令表，避免切换目录后把旧输入按新目录命令重新分类。
  commands?: readonly { name: string }[]
  before?: () => Promise<boolean> | boolean
  /** 当前显示语言的 BCP47 标签（如 zh-Hans），用于让 Agent 默认按设置语言思考/回复 */
  language?: string
  translateContent?: boolean
}

const draftText = (prompt: Prompt) =>
  prompt
    .map((part) => {
      // plugin pill 的 content 是短形态 `@<name>`(便于 UI / cursor 对齐),
      // 写到 wire 时还原成完整 `[@<name>](plugin://<addonKey>)` 与 Codex 1:1。
      if (part.type === "plugin") return buildPluginMention(part.name, part.addonKey)
      if (part.type === "skill") return part.content
      if (part.type === "conversation") return buildConversationReference({ id: part.id, title: part.title })
      if (part.type === "link") return part.plain ? part.content : serializePromptLink(part.content, part.href)
      if (part.type === "file-reference") return serializePromptLink(part.content, part.href)
      // file part 是附件，不添加到文本中
      if (part.type === "file") return ""
      return "content" in part ? part.content : ""
    })
    .join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const compactPromptPart = (part: Prompt[number]) => {
  if (part.type === "image") {
    return {
      type: part.type,
      id: part.id,
      filename: part.filename,
      mime: part.mime,
      dataUrlHead: part.dataUrl.slice(0, 96),
      dataUrlLength: part.dataUrl.length,
    }
  }
  if (part.type === "file")
    return { type: part.type, path: part.path, selection: part.selection, content: part.content }
  if (part.type === "link" || part.type === "file-reference") {
    return { type: part.type, href: part.href, content: part.content, ...(part.type === "link" && part.plain ? { plain: true } : {}) }
  }
  if (part.type === "agent") return { type: part.type, name: part.name, content: part.content }
  if (part.type === "plugin")
    return { type: part.type, name: part.name, addonKey: part.addonKey, content: part.content }
  if (part.type === "skill") return { type: part.type, name: part.name, location: part.location, content: part.content }
  if (part.type === "conversation") {
    return {
      type: part.type,
      id: part.id,
      title: part.title,
      transcript: part.transcript,
      content: part.content,
    }
  }
  return { type: part.type, content: part.content }
}

const snapshotImageAttachment = (image: ImageAttachmentPart): ImageAttachmentPart => ({
  ...image,
  // 屏幕快照元数据也属于提交身份；后续捕获更新不能改写已经进入权限预检的旧请求。
  ...(image.appSnapshot ? { appSnapshot: { ...image.appSnapshot } } : {}),
})

export function snapshotPromptForSubmit(prompt: Prompt): Prompt {
  // Solid store 返回的是活代理；提交边界必须复制每个 part，避免用户继续输入时原地改写旧请求和队列草稿。
  return prompt.map((part) => {
    if (part.type === "image") return snapshotImageAttachment(part)
    if (part.type !== "file") return { ...part }
    return {
      ...part,
      ...(part.selection ? { selection: { ...part.selection } } : {}),
      ...(part.pastedText ? { pastedText: { ...part.pastedText } } : {}),
    }
  })
}

const submitKey = (input: {
  sessionID: string
  directory: string
  mode: "normal" | "shell"
  prompt: Prompt
  snippets: readonly string[]
  context: readonly (ContextItem & { key?: string })[]
  images?: readonly ImageAttachmentPart[]
}) =>
  JSON.stringify({
    sessionID: input.sessionID,
    directory: input.directory,
    mode: input.mode,
    prompt: input.prompt.map(compactPromptPart),
    snippets: input.snippets,
    context: input.context.map((item) => ({
      key: item.key,
      type: item.type,
      path: item.path,
      selection: item.selection,
      comment: item.comment,
    })),
    images: (input.images ?? []).map(compactPromptPart),
  })

/** Wire-format user text for the session API (add-to-chat merge or plain body). */
export function followupWireUserText(draft: FollowupDraft) {
  const snippets = draft.addToChatSnippets ?? []
  const body = draftText(draft.prompt)
  if (snippets.length === 0) return body
  return composeAddToChatUserMessage(snippets, body)
}

export function buildFollowupOptimisticUser(input: {
  draft: FollowupDraft
  messageID: string
  steerTargetTurnID?: string
  createdAt?: number
}) {
  const bodyOnly = draftText(input.draft.prompt)
  const wireText = followupWireUserText(input.draft)
  const images = input.draft.images ?? draftImages(input.draft.prompt)
  const hasSnippets = (input.draft.addToChatSnippets?.length ?? 0) > 0
  const optimisticText = hasSnippets && bodyOnly.trim() !== "" && wireText !== bodyOnly ? bodyOnly : undefined
  const { optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text: wireText,
    optimisticText,
    sessionID: input.draft.sessionID,
    messageID: input.messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })
  const message: Message = {
    id: input.messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: input.createdAt ?? Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
    // provisional 与权威目标共用同一字段，后续 optimistic.add 会按同一 messageID 原位更新而不是新增顶层回合。
    steerTargetTurnID: input.steerTargetTurnID,
  }
  return { message, parts: optimisticParts }
}

// slash command 不能携带 steer synthetic part；统一识别已注册命令，让忙态命令留在本地队列等待空闲执行。
export function resolveKnownSlashCommand(text: string, commands: readonly { name: string }[]) {
  const [head, ...tail] = text.trim().split(/\s/)
  if (!head?.startsWith("/")) return
  const command = head.slice(1)
  if (!commands.some((item) => item.name === command)) return
  return { command, arguments: tail.join(" ") }
}

export function resolveFollowupSlashCommand(
  draft: Pick<FollowupDraft, "prompt" | "imageGeneration">,
  commands: readonly { name: string }[],
) {
  // 显式生图模式下，整段文本都是图片提示词；即使开头像已注册命令，也不能改走 command API。
  if (draft.imageGeneration) return
  return resolveKnownSlashCommand(draftText(draft.prompt), commands)
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const commands = [...(input.commands ?? input.sync.data.command)]
  // 权限模式落盘是普通发送和 steer 的共同前置屏障，失败时不得留下 optimistic 消息或触发任何网络请求。
  await input.preflight()
  // 只有调用方明确提供官方式 turnID 等待器时，才允许无权威目标的 steer 先进入 optimistic 时间线。
  if (input.steer && !input.targetTurnID && !input.waitForSteerTarget) throw new MissingSteerTargetError()
  const bodyOnly = draftText(input.draft.prompt)
  const wireText = followupWireUserText(input.draft)
  const images = input.draft.images ?? draftImages(input.draft.prompt)
  const [, setStore] = input.globalSync.child(input.draft.sessionDirectory)
  // steer inactive 后会复用同一消息切换成普通 start-turn；后续失败必须按普通请求收尾，不能继续沿用 steer 的状态保护。
  const lifecycle = { fallbackStarted: false }
  const assertCanContinue = () => {
    if (input.canContinue?.() === false) {
      // 用稳定的 AbortError 结束旧请求；外层会释放 claim，但不会把它误判成 steer inactive 再开新回合。
      throw Object.assign(new Error("Follow-up sender is no longer current"), { name: "AbortError" })
    }
  }

  const setBusy = () => {
    if (!input.optimisticBusy) return
    // steer 复用后端已有 active turn；覆盖成无 turnID 的乐观 busy 会丢掉权威绑定并让后续引导无法快照目标。
    if (input.steer) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    // steer 复用的是已经运行中的回合；请求失败只能恢复草稿，不能把仍在执行的原回合伪造为 idle。
    if (input.steer && !lifecycle.fallbackStarted) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const resolvedCommand = resolveFollowupSlashCommand(input.draft, commands)
  if (resolvedCommand) {
    const messageID = input.messageID ?? Identifier.ascending("message")
    const hasSnippets = (input.draft.addToChatSnippets?.length ?? 0) > 0
    const optimisticText = hasSnippets && bodyOnly.trim() !== "" && wireText !== bodyOnly ? bodyOnly : undefined
    const { optimisticParts } = buildRequestParts({
      prompt: input.draft.prompt,
      context: input.draft.context,
      images,
      text: wireText,
      optimisticText,
      sessionID: input.draft.sessionID,
      messageID,
      sessionDirectory: input.draft.sessionDirectory,
    })
    const message: Message = {
      id: messageID,
      sessionID: input.draft.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.draft.agent,
      model: { ...input.draft.model, variant: input.draft.variant },
    }

    const add = () =>
      input.sync.session.optimistic.add({
        directory: input.draft.sessionDirectory,
        sessionID: input.draft.sessionID,
        message,
        parts: optimisticParts,
      })

    const remove = () =>
      input.sync.session.optimistic.remove({
        directory: input.draft.sessionDirectory,
        sessionID: input.draft.sessionID,
        messageID,
      })

    batch(() => {
      setBusy()
      add()
    })
    try {
      if (!(await wait())) {
        setIdle()
        if (!input.keepOptimisticOnFailure) remove()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        messageID,
        command: resolvedCommand.command,
        arguments: resolvedCommand.arguments,
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      if (!input.keepOptimisticOnFailure) remove()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const hasSnippets = (input.draft.addToChatSnippets?.length ?? 0) > 0
  const optimisticText = hasSnippets && bodyOnly.trim() !== "" && wireText !== bodyOnly ? bodyOnly : undefined
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text: wireText,
    optimisticText,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })
  const requestPartsWithSyntheticContext = [
    ...requestParts,
    ...((input.syntheticContext ?? []).flatMap((text) =>
      text.trim()
        ? [
            {
              type: "text" as const,
              text,
              synthetic: true,
              metadata: { manual_steer_context: true },
            },
          ]
        : [],
    )),
  ]
  // steer 重试与 inactive fallback 必须复用完全相同的稳定 messageID 和用户输入载荷。
  // 调用方显式提供的恢复上下文也固化进同一载荷，重试与 fallback 不能重复构造或丢失。
  const payload = {
    sessionID: input.draft.sessionID,
    agent: input.draft.agent,
    model: input.draft.model,
    messageID,
    parts: requestPartsWithSyntheticContext,
    variant: input.draft.variant,
    language: input.language,
    translateContent: input.translateContent,
    imageGeneration: input.imageGeneration ?? input.draft.imageGeneration,
  }
  const message = buildFollowupOptimisticUser({
    draft: input.draft,
    messageID,
    // 对齐 ChatGPT 的 steeringUserMessage：权威目标未到时先用可见 turn 归组，拿到 turnID 后再原位改绑。
    steerTargetTurnID: input.steer ? (input.targetTurnID ?? input.optimisticTargetTurnID) : undefined,
  }).message

  const add = () => {
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })
  }

  const remove = () => {
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })
  }

  const updateOptimisticSteerTarget = (targetTurnID?: string) =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message: { ...message, steerTargetTurnID: targetTurnID },
      parts: optimisticParts,
    })

  const requestWithAckTimeout = async <T>(request: (signal: AbortSignal) => Promise<T>) => {
    // 官方 steer RPC 与普通 start-turn 都有相同的有界 ACK 等待；fallback 也必须可终止，否则会话级提交锁会永久占用。
    const controller = new AbortController()
    const timeoutError = Object.assign(new Error("Follow-up durable ACK timed out"), { name: "TimeoutError" })
    const timeoutID = window.setTimeout(
      () => controller.abort(timeoutError),
      input.steerAckTimeoutMs ?? STEER_ACK_TIMEOUT_MS,
    )
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? timeoutError), {
        once: true,
      })
    })
    const abortFromCaller = () =>
      controller.abort(
        input.signal?.reason ?? Object.assign(new Error("Follow-up sender was stopped"), { name: "AbortError" }),
      )
    if (input.signal?.aborted) abortFromCaller()
    else input.signal?.addEventListener("abort", abortFromCaller, { once: true })
    try {
      return await Promise.race([request(controller.signal), timeout])
    } finally {
      window.clearTimeout(timeoutID)
      input.signal?.removeEventListener("abort", abortFromCaller)
    }
  }

  const startFallback = async () => {
    // 官方上层只在活动回合确实消失时用同一 restoreMessage/clientUserMessageId 启动普通回合。
    assertCanContinue()
    updateOptimisticSteerTarget(undefined)
    // 从这一刻起请求已经属于普通新回合；即使 prompt ACK 失败，外层 catch 也必须清理刚写入的乐观 busy。
    lifecycle.fallbackStarted = true
    if (input.optimisticBusy) {
      setStore("session_status", input.draft.sessionID, { type: "busy", turnID: messageID })
    }
    // fallback 语义在发起普通请求前就必须对调用方可见；即使普通 ACK 丢失，也只能按同一 messageID 的普通回合确认。
    input.onSteerFallback?.()
    assertCanContinue()
    await requestWithAckTimeout((signal) =>
      input.client.session.promptAsync({ ...payload, noReply: input.noReply }, { signal }),
    )
    // 请求成功返回即代表同一 messageID 已 durable ACK；停止或换页只能阻止后续请求，不能把成功降级成失败并恢复重复草稿。
    return "fallback" as const
  }

  // 每次官方式重试都建立独立超时，避免第一次失配留下已取消的 signal 影响第二次请求。
  const steerRequest = (targetTurnID: string) =>
    requestWithAckTimeout((signal) => input.client.session.steer({ ...payload, targetTurnID }, { signal }))

  const sendSteer = async (targetTurnID: string, retryAllowed: boolean): Promise<"steer" | "fallback"> => {
    try {
      assertCanContinue()
      await steerRequest(targetTurnID)
      // ACK 后不再检查页面代次；调用层会用 owner/abort epoch 结算停止竞态，并删除已被服务端接受的恢复项。
      return "steer"
    } catch (error) {
      const actualTurnID = followupActualSteerTarget(error)
      if (actualTurnID) {
        assertCanContinue()
        // 官方 l9 只解析第一次 mismatch；第二次 mismatch 必须原样抛出，不能再错误降级成新的普通回合。
        if (!retryAllowed) throw error
        if (actualTurnID !== targetTurnID) {
          // 官方客户端只在权威目标变化时改绑 optimistic item，但拿到 mismatch actual 后始终只重试一次。
          input.sync.session.optimistic.add({
            directory: input.draft.sessionDirectory,
            sessionID: input.draft.sessionID,
            message: { ...message, steerTargetTurnID: actualTurnID },
            parts: optimisticParts,
          })
          input.onSteerRetarget?.(actualTurnID)
          assertCanContinue()
        }
        return sendSteer(actualTurnID, false)
      }
      if (followupFailureIsStaleSteerTarget(error, { localHost: input.localHost })) {
        // 官方 composer 在一次 mismatch 重试仍失败后统一回到 start-turn；actual 只决定那一次重试，不能触发第三次 steer。
        return startFallback()
      }
      throw error
    }
  }

  batch(() => {
    setBusy()
    add()
  })

  try {
    assertCanContinue()
    if (!(await wait())) {
      batch(() => {
        setIdle()
        if (!input.keepOptimisticOnFailure) remove()
      })
      return false
    }

    if (input.steer) {
      let targetTurnID: string
      try {
        targetTurnID = input.targetTurnID ?? (await input.waitForSteerTarget?.()) ?? ""
        assertCanContinue()
      } catch (error) {
        // rfe 等待期间若 inProgress 先结束，官方会抛 inactive 并由上层用同一消息走 start-turn fallback。
        if (followupFailureIsStaleSteerTarget(error, { localHost: input.localHost })) {
          await startFallback()
          return true
        }
        throw error
      }
      if (!targetTurnID) throw new MissingSteerTargetError()
      if (!input.targetTurnID) {
        // 权威 turnID 到达后原位改绑 optimistic item，并同步上层持久化顺序锁后再发网。
        assertCanContinue()
        updateOptimisticSteerTarget(targetTurnID)
        input.onSteerRetarget?.(targetTurnID)
        assertCanContinue()
      }
      // 独立 steer ACK 只有在整条用户消息落库后才返回；失配只重试一次，最终 inactive 复用原消息 ID 开新 turn。
      await sendSteer(targetTurnID, true)
    } else {
      // 普通队列同样必须有界等待 durable ACK；否则草稿已从 Dock 移除但请求永不返回，会永久占用会话提交锁。
      await requestWithAckTimeout((signal) =>
        input.client.session.promptAsync({ ...payload, noReply: input.noReply }, { signal }),
      )
      // 普通队列同样以 durable ACK 为成功边界，避免停止竞态把已落库消息再次放回 Dock。
    }
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      if (!input.keepOptimisticOnFailure) remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  shouldSteer?: Accessor<boolean>
  onSteer?: (draft: FollowupDraft) => Promise<void> | void
  onAbort?: () => void
  // 停止请求在页面把状态乐观切 idle 前快照当前回合，避免迟到请求误杀下一回合。
  activeTurnID?: (sessionID: string) => string | undefined
  // 服务端停止请求完成后再启动未 ACK 引导的恢复接力，避免和原 runner 并发。
  onAbortComplete?: (sessionID: string) => void
  // 常驻 Session 树不能直接信任父路由 useParams；由页面传入 URL 解析后的权威会话与完整路由身份。
  sessionID?: Accessor<string | undefined>
  routeIdentity?: Accessor<string>
  syncEditorBeforeSubmit?: () => void
  onBeforeSubmitExistingSession?: (sessionID: string) => Promise<boolean> | boolean
  flushPermissionMode?: () => Promise<void>
  onSubmit?: () => void
  imageGeneration?: Accessor<{ enabled: boolean; count: number; size: string }>
  isGoalModeActive?: () => boolean
  onGoalSubmit?: (objective: string, sessionID: string) => void
  onExitGoalMode?: () => void
  // 生产环境保持 300ms 指数退避；测试可缩短真实计时，但仍完整执行相同的失败重试与收尾路径。
  sessionCreateRetryDelayMs?: number
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const settings = useSettings()
  const params = useParams()
  // accessor 返回 undefined 也具有权威含义（当前是新建页），不能再回退到父路由残留的旧 session ID。
  const currentSessionID = () => (input.sessionID ? input.sessionID() : params.id)
  const currentRouteIdentity = () => input.routeIdentity?.() ?? `${sdk.directory}\n${currentSessionID() ?? ""}`
  let activePromptSubmitKey: string | undefined
  // 同一输入快照的重复点击只提交一次；不同快照必须全部交给页面层的会话 FIFO，不能在 durable ACK 期间静默丢弃。
  const directSteerSubmitKeys = new Set<string>()
  // 权限模式必须先刷入持久层；失败时所有发送、排队和输入清理都保持未发生。
  const permissionPreflight = () => input.flushPermissionMode?.() ?? Promise.resolve()

  const errorMessage = (err: unknown) => {
    // 优先用 resolveError 精确分类后端认证/权益/额度/限速错误；返回 unknown 时用 formatServerError 保留丰富格式化
    const resolved = resolveError(err)
    if (resolved.category !== "unknown") {
      return language.t(resolved.messageKey as any)
    }
    return formatServerError(err, language.t, language.t("common.requestFailed"))
  }

  const abort = async () => {
    const sessionID = currentSessionID()
    if (!sessionID) return Promise.resolve()
    // 停止从点击开始就绑定目录、client 与 child store；切页不能把旧会话的 idle 写到新目录。
    const directory = sdk.directory
    const client = sdk.client
    const [, setStore] = globalSync.child(directory, { bootstrap: false })
    // 必须在 onAbort 的乐观 idle 之前读取 turnID；否则停止请求会退化成旧版无目标 abort。
    const turnID = input.activeTurnID?.(sessionID)

    globalSync.todo.set(sessionID, [])
    setStore("todo", sessionID, [])
    // 先让页面暂停 follow-up 队列，再把会话切到 idle；同一批次提交可防止自动队列在两次写入之间抢跑。
    batch(() => {
      input.onAbort?.()
      setStore("session_status", sessionID, { type: "idle" })
    })

    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      input.onAbortComplete?.(sessionID)
      return Promise.resolve()
    }
    return client.session
      .abort({
        sessionID,
        turnID,
      })
      .catch(() => {})
      // 页面可能在请求期间切换会话；完成通知必须携带发起时的 sessionID，不能清理新页面的停止闸。
      .finally(() => input.onAbortComplete?.(sessionID))
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = globalSync.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    // contenteditable 的 DOM 可能已经有新文字,但 Solid store 还没收到 input/reconcile。
    // 提交前主动同步一次,否则失败回合后的 follow-up 会看起来点了发送,实际因为 prompt 仍为空而直接返回。
    input.syncEditorBeforeSubmit?.()

    // 异步创建、权限预检和发送 ACK 都必须绑定用户按下发送时的路由；迟到结果不得重新读取另一个会话作为目标。
    const submittedRouteIdentity = currentRouteIdentity()
    const submittedRouteSessionID = currentSessionID()
    const submittedSession = input.info()
    const submittedCommands = [...sync.data.command]
    const submittedShouldSteer = input.shouldSteer?.() ?? false
    const submittedShouldQueue = input.shouldQueue?.() ?? false
    const submittedCommentCount = input.commentCount()
    const projectDirectory = sdk.directory
    const routeStillAtSubmitOrigin = () => currentRouteIdentity() === submittedRouteIdentity

    // 输入快照必须早于任何异步权限/会话预检，并彻底脱离编辑器的可变 Solid store。
    const currentPrompt = snapshotPromptForSubmit(prompt.current())
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const snippets = [...prompt.addToChat.snippets()]
    const currentContext = prompt.context.items().map((item) => ({
      ...item,
      // 文件选择范围可能被评论/审查面板原地更新，提交后必须继续使用用户按下回车时的范围。
      ...(item.selection ? { selection: { ...item.selection } } : {}),
    }))
    const images = input.imageAttachments().map(snapshotImageAttachment)
    const mode = input.mode()

    // 停止按钮也是 submit 按钮,但只有空输入时才表示停止。
    // 有文本/附件时继续走 queue/send 判定,避免残留 running 状态吞掉用户的下一条 follow-up。
    if (
      input.working() &&
      text.trim().length === 0 &&
      images.length === 0 &&
      submittedCommentCount === 0 &&
      snippets.length === 0
    ) {
      void abort()
      return
    }
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    const imageGeneration = input.imageGeneration?.()
    // goal 模式：先让下方的会话创建逻辑确保 session 存在（支持新会话），再设目标而非发消息
    const goalMode = shouldDivertToGoal({ active: input.isGoalModeActive?.() ?? false, text, mode })
    const generatingImages =
      mode === "normal" &&
      !goalMode &&
      !!currentModel &&
      isImageGenerationModel({
        id: currentModel.id,
        name: currentModel.name,
        capabilities: currentModel.capabilities,
      })

    if (text.trim().length === 0 && images.length === 0 && submittedCommentCount === 0 && snippets.length === 0) return

    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    if (isWanlaiCodeNoEntitlementProvider(currentModel.provider) && !isFreeModel(currentModel)) {
      showToast({
        title: language.t("prompt.toast.noPlanModelBlocked.title"),
        description: language.t("prompt.toast.noPlanModelBlocked.description"),
      })
      return
    }

    if (snippets.length > 0 && mode === "shell") {
      showToast({
        title: language.t("session.addToChat.blockedShell.title"),
        description: language.t("session.addToChat.blockedShell.description"),
      })
      return
    }

    if (generatingImages && text.trim().length === 0) {
      showToast({
        title: language.t("prompt.imageGeneration.toast.promptRequired.title"),
        description: language.t("prompt.imageGeneration.toast.promptRequired.description"),
      })
      return
    }

    if (!generatingImages && snippets.length > 0 && text.trim().startsWith("/")) {
      const [cmdName] = text.trim().split(/\s/)
      if (cmdName?.startsWith("/")) {
        const commandName = cmdName.slice(1)
        if (submittedCommands.find((c) => c.name === commandName)) {
          showToast({
            title: language.t("session.addToChat.blockedSlash.title"),
            description: language.t("session.addToChat.blockedSlash.description"),
          })
          return
        }
      }
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const isNewSession = !submittedRouteSessionID
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      // worktree 创建可能跨越路由切换；旧请求不能重置新页面的选择器。
      if (routeStillAtSubmitOrigin()) input.onNewSessionWorktreeReset?.()
    }

    // Session 对象与路由 ID 必须来自同一个点击快照；不匹配时宁可拒绝，也不能把输入发到另一个会话。
    let session =
      submittedSession && (!submittedRouteSessionID || submittedSession.id === submittedRouteSessionID)
        ? submittedSession
        : undefined
    let pendingServerSync = false
    let deferredSessionNavigate = false
    let ensureServerSession = async () => true
    const navigateToSession = (id: string) => {
      // 用户在 session.create / retry 期间切走后，迟到 ACK 只完成后台提交，不能把页面抢回旧操作。
      if (!routeStillAtSubmitOrigin()) return false
      layout.handoff.setTabs(base64Encode(sessionDirectory), id)
      navigate(`/${base64Encode(sessionDirectory)}/session/${id}`)
      return true
    }

    if (!session && isNewSession) {
      const sessionID = newSessionID()
      const createPayload = {
        directory: sessionDirectory,
        id: sessionID,
        agent: currentAgent.name,
        model: {
          id: currentModel.id,
          providerID: currentModel.provider.id,
          variant,
        },
      }

      let transportCreateFailure = false
      const created = await client.session
        .create(createPayload)
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          if (isTransportError(err)) {
            transportCreateFailure = true
            return undefined
          }
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })

      if (!created && !transportCreateFailure) {
        session = undefined
      } else {
        const normalized =
          created != null
            ? { ...created, directory: sessionDirectory }
            : createOptimisticSession({
                id: sessionID,
                directory: sessionDirectory,
                projectID: sync.project?.id,
                agent: currentAgent.name,
                model: {
                  modelID: currentModel.id,
                  providerID: currentModel.provider.id,
                  variant,
                },
              })

        pendingServerSync = created == null
        let syncInFlight: Promise<boolean> | undefined
        ensureServerSession = async () => {
          if (!pendingServerSync) return true
          if (syncInFlight) return syncInFlight
          syncInFlight = (async () => {
            try {
              const synced = await retry(
                () =>
                  client.session.create(createPayload).then((x) => {
                    const data = x.data
                    if (!data) throw new Error("empty session")
                    return data
                  }),
                { attempts: 5, delay: input.sessionCreateRetryDelayMs ?? 300 },
              )
              pendingServerSync = false
              seed(sessionDirectory, { ...synced, directory: sessionDirectory })
              return true
            } catch {
              return false
            } finally {
              syncInFlight = undefined
            }
          })()
          return syncInFlight
        }

        seed(sessionDirectory, normalized)
        session = normalized
        // promote 会清理当前 draft；只有仍停留在发起新会话的页面时才有权迁移这份本地设置。
        if (routeStillAtSubmitOrigin()) local.session.promote(sessionDirectory, session.id)
        deferredSessionNavigate = pendingServerSync && (goalMode || mode === "shell")
        if (!deferredSessionNavigate) navigateToSession(session.id)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const ownsCurrentComposer = () => {
      const current = currentSessionID()
      // 正常会话提交只认捕获的 session；新会话导航完成后则把 composer 所有权移交给刚创建的 session。
      if (!isNewSession) return routeStillAtSubmitOrigin() && current === session.id
      if (current === session.id) return sdk.directory === sessionDirectory
      return isNewSession && current === undefined && routeStillAtSubmitOrigin()
    }

    const syncBeforeDeferredNavigate = async () => {
      if (deferredSessionNavigate) {
        if (!(await ensureServerSession())) return false
        navigateToSession(session.id)
        deferredSessionNavigate = false
        return true
      }
      if (pendingServerSync && !(await ensureServerSession())) return false
      return true
    }

    // goal 模式：会话已确保（含新建），把目标设到该会话上，不走发消息逻辑
    if (goalMode) {
      if (!(await syncBeforeDeferredNavigate())) {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: language.t("common.requestFailed"),
        })
        return
      }
      // 目标回合仍按提交快照处理，但 goal 回调会修改当前 composer；页面已切走时不能触发跨会话 UI 副作用。
      if (!ownsCurrentComposer()) return
      input.onGoalSubmit?.(text.trim(), session.id)
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
      input.onSubmit?.()
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const context = currentContext
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      addToChatSnippets: snippets.length > 0 ? [...snippets] : undefined,
      context,
      images,
      agent,
      model,
      variant,
      imageGeneration: generatingImages
        ? {
            ...(imageGeneration?.enabled ? { count: imageGeneration.count, size: imageGeneration.size } : {}),
            output_format: "png",
            ...imageGenerationClientConfig(language.t),
          }
        : undefined,
    }

    const snippetsSnapshot = [...snippets]
    const submittedInputKey = submitKey({
      sessionID: session.id,
      directory: sessionDirectory,
      mode,
      prompt: currentPrompt,
      snippets: snippetsSnapshot,
      context,
      images,
    })

    const clearInput = () => {
      // 发送链可以在后台完成，但不能清空用户已经切换到的另一个会话输入框。
      if (!ownsCurrentComposer()) return false
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
      return true
    }

    const clearSubmittedFollowupInput = () => {
      // 异步预检期间用户可能已经输入下一句；只有编辑器仍等于原快照时才能清空，避免旧提交覆盖新草稿。
      // 页面也可能已经切到另一会话；即使两边草稿完全相同，旧请求也没有权限清理新会话的编辑器。
      if (!ownsCurrentComposer()) return false
      if (
        submitKey({
          sessionID: session.id,
          directory: sessionDirectory,
          mode: input.mode(),
          prompt: prompt.current(),
          snippets: prompt.addToChat.snippets(),
          context: prompt.context.items(),
          images: input.imageAttachments(),
        }) !== submittedInputKey
      )
        return false
      clearContext()
      clearInput()
      return true
    }

    const restoreInput = () => {
      // 失败恢复与清空遵循同一所有权规则，避免旧请求把快照覆盖到新会话正在输入的草稿上。
      if (!ownsCurrentComposer()) return false
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      prompt.addToChat.replace(snippetsSnapshot)
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        if (!ownsCurrentComposer()) return
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (
      !isNewSession &&
      input.onBeforeSubmitExistingSession &&
      !(await input.onBeforeSubmitExistingSession(session.id))
    ) {
      // 页面预检拦截提交时恢复已进入历史的输入快照和编辑器焦点，避免用户看见内容仍在却无法继续输入。
      restoreInput()
      return
    }

    const renameTitle = directRenameTitle(text)
    if (
      renameTitle &&
      !isNewSession &&
      mode === "normal" &&
      !generatingImages &&
      snippets.length === 0 &&
      images.length === 0 &&
      submittedCommentCount === 0
    ) {
      if (ownsCurrentComposer()) input.onSubmit?.()
      void (async () => {
        if (!(await syncBeforeDeferredNavigate())) {
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        clearInput()
        try {
          const response = await client.session.update({
            sessionID: session.id,
            directory: sessionDirectory,
            title: renameTitle,
          })
          if (response.error !== undefined) throw response.error
          if (!response.data) throw new Error(language.t("common.requestFailed"))
          const updated = response.data

          const [, setStore] = globalSync.child(sessionDirectory, { bootstrap: false })
          setStore("session", (list: Session[] = []) =>
            list.map((item) => {
              if (item.id !== session.id) return item
              return { ...updated, directory: sessionDirectory }
            }),
          )
        } catch (err) {
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        }
      })()
      return
    }

    const messageID = Identifier.ascending("message")
    const bodyOnly = draftText(currentPrompt)
    const resolvedCommand = resolveFollowupSlashCommand(draft, submittedCommands)
    const wireText = followupWireUserText(draft)
    const hasSnippets = snippets.length > 0
    const optimisticText = hasSnippets && bodyOnly.trim() !== "" && wireText !== bodyOnly ? bodyOnly : undefined
    const { optimisticParts } = buildRequestParts({
      prompt: currentPrompt,
      context,
      images,
      text: wireText,
      optimisticText,
      sessionID: session.id,
      messageID,
      sessionDirectory,
    })
    const userMessage: Message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model: { ...model, variant },
    }

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    const addOptimisticUserMessage = () => {
      sync.session.optimistic.add({
        directory: sessionDirectory,
        sessionID: session.id,
        message: userMessage,
        parts: optimisticParts,
      })
    }

    try {
      await permissionPreflight()
    } catch (err) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
      return
    }
    // steer 模式下的直接回车必须复用持久化 follow-up 发送链路，确保 marker、顺序锁、失败恢复与 dock 点击完全一致。
    // 已注册 slash command 无法携带 steer marker，因此只入普通队列，等当前回合真正空闲后再执行。
    const canRouteSteer = resolvedCommand ? !!input.onQueue : !!input.onSteer
    if (!isNewSession && mode === "normal" && submittedShouldSteer && canRouteSteer) {
      if (resolvedCommand && input.onQueue) input.onQueue(draft)
      else {
        const directSteerSubmitKey = submittedInputKey
        // 权限预检可能让两次相同提交同时恢复；只去重完全相同的快照，不能阻断用户随后输入的另一条引导。
        if (directSteerSubmitKeys.has(directSteerSubmitKey)) return
        directSteerSubmitKeys.add(directSteerSubmitKey)
        try {
          // 页面层会先为每条引导生成稳定 ID 并入 FIFO；这里等待当前请求交接完成，只负责维护该快照的重复提交锁。
          const sending = input.onSteer?.(draft)
          clearSubmittedFollowupInput()
          await sending
        } finally {
          directSteerSubmitKeys.delete(directSteerSubmitKey)
        }
        return
      }
      clearSubmittedFollowupInput()
      return
    }

    if (!isNewSession && mode === "normal" && submittedShouldQueue) {
      if (generatingImages) {
        showToast({
          title: language.t("prompt.imageGeneration.toast.busy.title"),
          description: language.t("prompt.imageGeneration.toast.busy.description"),
        })
        return
      }
      input.onQueue?.(draft)
      clearSubmittedFollowupInput()
      return
    }

    if (ownsCurrentComposer()) input.onSubmit?.()

    if (mode === "shell") {
      void (async () => {
        if (!(await syncBeforeDeferredNavigate())) {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        clearInput()
        client.session
          .shell({
            sessionID: session.id,
            agent,
            model,
            command: text,
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.shellSendFailed.title"),
              description: errorMessage(err),
            })
            restoreInput()
          })
      })()
      return
    }

    if (!generatingImages && text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = submittedCommands.find((c) => c.name === commandName)
      if (customCommand) {
        // 在 goal 输入态下跑斜杠命令：命令本身不应被吞成目标，且执行后要退出 goal 输入态，
        // 否则 pendingObjective 仍 armed，用户下一条普通消息会被静默捕获为目标
        if (ownsCurrentComposer() && input.isGoalModeActive?.()) input.onExitGoalMode?.()
        void (async () => {
          if (!(await syncBeforeDeferredNavigate())) {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: language.t("common.requestFailed"),
            })
            return
          }
          clearInput()
          addOptimisticUserMessage()
          client.session
            .command({
              sessionID: session.id,
              messageID,
              command: commandName,
              arguments: args.join(" "),
              agent,
              model: `${model.providerID}/${model.modelID}`,
              variant,
              parts: images.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: attachment.mime,
                url: attachment.dataUrl,
                filename: attachment.filename,
              })),
            })
            .catch((err) => {
              showToast({
                title: language.t("prompt.toast.commandSendFailed.title"),
                description: errorMessage(err),
              })
              removeOptimisticMessage()
              restoreInput()
            })
        })()
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const promptSubmitKey = submittedInputKey
    // 普通模型也会在后端直连 image_generation；这里统一拦同一输入的重复提交，避免一次请求拆成两轮。
    if (activePromptSubmitKey === promptSubmitKey) return
    activePromptSubmitKey = promptSubmitKey
    const releasePromptSubmitKey = () => {
      if (activePromptSubmitKey === promptSubmitKey) activePromptSubmitKey = undefined
    }

    // 评论上下文属于当前 composer；切换会话后不能按旧快照 key 删除新页面的上下文。
    if (ownsCurrentComposer()) removeCommentItems(commentItems)
    clearInput()

    // 后续 worktree 等待、失败收尾与发送状态都固定写入目标目录，不能使用会随路由变化的 sync.set。
    const [, setSessionStore] = globalSync.child(sessionDirectory, { bootstrap: false })

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        setSessionStore("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          setSessionStore("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (ownsCurrentComposer()) restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    const beforeSend = async () => {
      if (pendingServerSync) {
        const ok = await ensureServerSession()
        if (!ok) {
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return false
        }
      }
      return waitForWorktree()
    }

    const sendTextPrompt = (textModel = currentModel) =>
      sendFollowupDraft({
        client,
        sync,
        globalSync,
        draft: {
          ...draft,
          model: {
            providerID: textModel.provider.id,
            modelID: textModel.id,
          },
        },
        messageID,
        optimisticBusy: sessionDirectory === projectDirectory,
        keepOptimisticOnFailure: pendingServerSync,
        preflight: permissionPreflight,
        commands: submittedCommands,
        before: beforeSend,
        language: language.intl(),
        translateContent: settings.general.translateContent(),
      })

    const handleTextPromptError = (err: unknown) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        setSessionStore("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      if (pendingServerSync) return
      removeOptimisticMessage()
      if (ownsCurrentComposer()) restoreCommentItems(commentItems)
      restoreInput()
    }

    if (generatingImages) {
      await sendTextPrompt(currentModel).catch(handleTextPromptError).finally(releasePromptSubmitKey)
      return
    }

    await sendTextPrompt(currentModel).catch(handleTextPromptError).finally(releasePromptSubmitKey)
  }

  return {
    abort,
    handleSubmit,
  }
}
