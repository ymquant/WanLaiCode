import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { messageIdFromHash, resolveMessageHashTarget } from "./message-id-from-hash"
import { scrollSessionElement } from "./session-element-scroll"

export const useSessionHashScroll = (input: {
  sessionKey: () => string
  sessionID: () => string | undefined
  messagesReady: () => boolean
  visibleUserMessages: () => UserMessage[]
  messageAnchorID?: (messageID: string) => string | undefined
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  turnStart: () => number
  currentMessageId: () => string | undefined
  pendingMessage: () => string | undefined
  setPendingMessage: (value: string | undefined) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  setTurnStart: (value: number) => void
  autoScroll: {
    pause: () => void
    forceScrollToBottom: () => void
    userScrolled: () => boolean
    reset: () => void
    consumeReset: () => boolean
  }
  scroller: () => HTMLDivElement | undefined
  anchor: (id: string) => string
  scheduleScrollState: (el: HTMLDivElement) => void
  consumePendingMessage: (key: string) => string | undefined
}) => {
  const visibleUserMessages = createMemo(() => input.visibleUserMessages())
  const messageIndex = createMemo(() => new Map(visibleUserMessages().map((m, i) => [m.id, i])))
  const resolveMessageTarget = (messageID: string) =>
    resolveMessageHashTarget({
      messageID,
      visibleUserMessages: visibleUserMessages(),
      messageAnchorID: input.messageAnchorID,
    })
  let pendingKey = ""
  let clearing = false
  // 上一次已兑现（真正滚过去）的 hash。跳转后 hash 会一直留在 URL 里，而驱动跳转的两个
  // effect 都依赖消息流，每次更新都会重跑；靠它区分「这是新的跳转意图」与「同一个 hash
  // 被重复触发」。未兑现的 hash 不记账，好让目标回填到位后仍能补跳。
  let appliedHash = ""

  const location = useLocation()
  const navigate = useNavigate()

  const frames = new Set<number>()
  const queue = (fn: () => void) => {
    const id = requestAnimationFrame(() => {
      frames.delete(id)
      fn()
    })
    frames.add(id)
  }
  const cancel = () => {
    for (const id of frames) cancelAnimationFrame(id)
    frames.clear()
  }

  const clearMessageHash = () => {
    cancel()
    appliedHash = ""
    input.consumePendingMessage(input.sessionKey())
    if (input.pendingMessage()) input.setPendingMessage(undefined)
    if (!location.hash) return
    clearing = true
    navigate(location.pathname + location.search, { replace: true })
  }

  const updateHash = (id: string) => {
    const hash = `#${input.anchor(id)}`
    if (location.hash === hash) return
    clearing = false
    navigate(location.pathname + location.search + hash, {
      replace: true,
    })
  }

  const scrollToElement = (el: HTMLElement, behavior: ScrollBehavior) => {
    const root = input.scroller()
    if (!root) return false
    scrollSessionElement({ root, target: el, behavior })
    return true
  }

  // onSettled 报告最终是否真的滚过去了：DOM anchor 可能要等几帧才渲染出来，
  // 同步返回值只代表「这一帧还没找到」，不等于失败。调用方要据此决定是否记账。
  const seek = (
    id: string,
    behavior: ScrollBehavior,
    left = 4,
    onSettled?: (scrolled: boolean) => void,
  ): boolean => {
    const el = document.getElementById(input.anchor(id))
    if (el) {
      const scrolled = scrollToElement(el, behavior)
      onSettled?.(scrolled)
      return scrolled
    }
    if (left <= 0) {
      onSettled?.(false)
      return false
    }
    queue(() => {
      seek(id, behavior, left - 1, onSettled)
    })
    return false
  }

  const scrollToMessage = (
    message: UserMessage,
    behavior: ScrollBehavior = "smooth",
    targetMessageID = message.id,
    onSettled?: (scrolled: boolean) => void,
  ) => {
    cancel()
    if (input.currentMessageId() !== message.id) input.setActiveMessage(message)

    const index = messageIndex().get(message.id) ?? -1
    if (index !== -1 && index < input.turnStart()) {
      input.setTurnStart(index)

      queue(() => {
        // 根消息负责展开物理 turn，真正的 DOM 锚点仍可能是 turn 内的 steer 消息。
        seek(targetMessageID, behavior, 4, onSettled)
      })

      updateHash(targetMessageID)
      return
    }

    seek(targetMessageID, behavior, 4, onSettled)
    updateHash(targetMessageID)
  }

  // 没有 hash 目标时回到底部，但用户已向上滚动阅读时不能拽他 —— 流式期间
  // hash 被清掉（如 resumeScroll 里的 clearMessageHash）会让本 effect 重跑。
  const scrollToBottomUnlessReading = () => {
    if (input.autoScroll.userScrolled()) return
    input.autoScroll.forceScrollToBottom()
    const el = input.scroller()
    if (el) input.scheduleScrollState(el)
  }

  const applyHash = (behavior: ScrollBehavior) => {
    const hash = location.hash.slice(1)
    if (!hash) {
      // hash 已经没了，之前的记账随之作废：同一个目标之后若再出现，应当能重新兑现。
      appliedHash = ""
      scrollToBottomUnlessReading()
      return
    }

    const messageId = messageIdFromHash(hash)
    if (messageId) {
      // 同一个 hash 只兑现一次。本函数由依赖 location.hash 与 messagesReady() 的 effect
      // 驱动，hash 没变也会被重新触发；那不是新的跳转意图，再跳一次就是把正在阅读的用户拽走。
      if (hash === appliedHash) return
      const target = resolveMessageTarget(messageId)
      // 目标还没加载出来（深链到需要回填历史的消息）。此时不能 pause，也不能记账：
      // pause 会把 userScrolled 置真，appliedHash 会让这次跳转被当成已兑现，
      // 两者都会让回填完成后的补跳失效。留给下面的 effect 在消息到位后接手。
      if (!target) return
      input.autoScroll.pause()
      // 消息在数据里 ≠ DOM anchor 已渲染。seek 只重试 4 帧，渲染更慢时会放弃；
      // 若此时已记账，两个 effect 都会跳过后续重试，深链就永久失效了。
      scrollToMessage(target.message, behavior, target.targetMessageID, (scrolled) => {
        if (scrolled) appliedHash = hash
      })
      return
    }

    const target = document.getElementById(hash)
    if (target) {
      input.autoScroll.pause()
      scrollToElement(target, behavior)
      return
    }

    scrollToBottomUnlessReading()
  }

  // createAutoScroll 实例跨会话存活（session 页不是 keyed 组件），上一个会话遗留的
  // userScrolled 会跟进新会话：新会话不落到底部、自动跟随失效、历史回填也被挡住，
  // 而用户在新会话里没有任何「滚回底部」的动作可做，无法自救。
  // 这里只清状态不滚动，滚到哪里交给下面的 hash 逻辑决定，避免和 hash 目标抢位置。
  createEffect(
    on(
      () => input.sessionID(),
      () => {
        appliedHash = ""
        input.autoScroll.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const hash = location.hash
    if (!hash) clearing = false
    if (!input.sessionID() || !input.messagesReady()) return
    cancel()
    queue(() => applyHash("auto"))
  })

  createEffect(() => {
    if (!input.sessionID() || !input.messagesReady()) return

    visibleUserMessages()
    input.turnStart()

    let targetId = input.pendingMessage()
    if (!targetId) {
      const key = input.sessionKey()
      if (pendingKey !== key) {
        pendingKey = key
        const next = input.consumePendingMessage(key)
        if (next) {
          input.setPendingMessage(next)
          targetId = next
        }
      }
    }

    // 同一个 hash 只兑现一次。跳转后 hash 会一直留在 URL 里，而本 effect 依赖
    // visibleUserMessages / turnStart，消息流每次更新都会重跑；若每次都照 hash 跳，
    // 正在向上滚动阅读的用户会被反复拽回消息头部。
    // 这里只接手 applyHash 没能兑现的那种：目标当时还没加载，回填到位后由本 effect 补跳。
    if (!targetId && !clearing && location.hash.slice(1) !== appliedHash) {
      targetId = messageIdFromHash(location.hash)
    }
    if (!targetId) return

    const pending = input.pendingMessage() === targetId
    const target = resolveMessageTarget(targetId)
    if (!target) return

    if (pending) input.setPendingMessage(undefined)
    // 根 turn 已激活时仍需允许定位到其中的 steer；只有目标就是根消息时才可省略重复跳转。
    if (
      input.currentMessageId() === target.message.id &&
      target.targetMessageID === target.message.id &&
      !pending
    )
      return

    input.autoScroll.pause()
    cancel()
    // 同上：滚成功才记账，避免 anchor 未渲染时把这次跳转错记成已兑现。
    // 记账后消息流下次更新不会再按同一个 hash 重跳。
    const anchorHash = input.anchor(target.targetMessageID)
    queue(() =>
      scrollToMessage(target.message, "auto", target.targetMessageID, (scrolled) => {
        if (scrolled) appliedHash = anchorHash
      }),
    )
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.messagesReady()) return

    visibleUserMessages()

    let targetId = input.pendingMessage()
    if (!targetId && !clearing) targetId = messageIdFromHash(location.hash)
    if (!targetId) return
    if (resolveMessageTarget(targetId)) return
    if (!input.historyMore() || input.historyLoading()) return

    void input.loadMore(sessionID)
  })

  onMount(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual"
    }
  })

  onCleanup(cancel)

  return {
    clearMessageHash,
    scrollToMessage,
    applyHash,
  }
}
