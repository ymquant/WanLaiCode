import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  // 滚动锚定策略，默认 "auto"：始终保留浏览器锚定，避免视口上方内容高度变化
  // （content-visibility 虚拟化、工具卡片重组为「已编辑 N 个文件」等）导致可视内容瞬移。
  // 用户向上滚动阅读时 userScrolled=true，本 hook 完全不动 scrollTop，
  // 此时浏览器锚定是唯一的补偿机制 —— 消息流内任何一处 overflow-anchor: none
  // 都会让整棵子树失去锚点候选资格，务必不要再加。传 "none" 等于关掉整个滚动器的
  // 原生锚定，只有本身不承载阅读内容的滚动区才适用。
  //
  // 曾在此处加过一层 JS 锚定兜底（记录锚点元素偏移、内容变化后补回 scrollTop）。
  // 它的锚点基准会与实际滚动位置脱钩：程序化跳转不产生手势因而不会重新锚定、
  // 命中 sticky 元素的后代时偏移恒为 0 而静默失效、锚点被 content-visibility
  // 跳过时读到零矩形。结果是兜底自己制造跳变。真正有效的是消除高度突变本身
  // （contain-intrinsic-size、避免组件在 working 翻转时销毁重建），不要再加回来。
  overflowAnchor?: "none" | "auto"
  bottomThreshold?: number
}

export type AutoScrollDirection = "away" | "toward"

export function shouldHoldUserControl(input: { distance: number; threshold: number; direction?: AutoScrollDirection }) {
  // 官方 Codex 在向下手势抵达底部后会立即重新进入跟随态；只有离开底部或明确向上时才继续占用滚动权。
  return input.direction === "away" || input.distance >= input.threshold
}

export function autoScrollAction(input: {
  distance: number
  threshold: number
  userGesture: boolean
  userControl?: boolean
  direction?: AutoScrollDirection
  userScrolled: boolean
  auto: boolean
}) {
  // 只有明确向下的手势抵达底部才恢复跟随；向上轻滚仍在阈值内时必须保留阅读态，不能抖回底部。
  if (input.userControl && input.userGesture && input.direction === "toward" && input.distance < input.threshold)
    return "resume" as const
  // 触控板惯性或滚动条拖拽仍在进行时，先让浏览器完整消费本次手势；即使已经进入底部阈值，
  // 只要尚未真正抵达底部，就不能恢复程序跟随，否则会和剩余的用户输入争抢 scrollTop。
  if (input.userControl) {
    if (input.userGesture && (input.direction === "away" || input.distance >= input.threshold)) return "pause" as const
    return "hold" as const
  }
  // 回到底部附近永远恢复跟随；离开底部后，已确认的用户手势必须优先于尚未过期的程序滚动标记。
  if (input.distance < input.threshold) return "resume" as const
  if (input.userGesture) return "pause" as const
  if (!input.userScrolled && input.auto) return "follow" as const
  return "pause" as const
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let followFrame: number | undefined
  let userControlTimer: ReturnType<typeof setTimeout> | undefined
  let userControlUntil = 0
  let userControlDirection: AutoScrollDirection | undefined
  let auto: { top: number; time: number } | undefined

  const threshold = () => options.bottomThreshold ?? 10
  // 官方 Codex 会把同方向滚动视为持续 1 秒的用户控制窗口，用来覆盖触控板惯性和滚动事件延迟。
  const userControlWindowMs = 1000
  let resetConsumed = false

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const userControlActive = () => Date.now() < userControlUntil

  const cancelFollow = () => {
    if (followFrame === undefined) return
    cancelAnimationFrame(followFrame)
    followFrame = undefined
  }

  const clearUserControl = () => {
    userControlUntil = 0
    userControlDirection = undefined
    if (!userControlTimer) return
    clearTimeout(userControlTimer)
    userControlTimer = undefined
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = store.scrollRef
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return

    if (force && store.userScrolled) setStore("userScrolled", false)

    const el = store.scrollRef
    if (!el) return

    if (!force && store.userScrolled) return
    if (userControlActive()) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // 同一渲染帧内的 Markdown、代码高亮和工具卡片可能连续触发多次 ResizeObserver。
    // 合并为一次写入，并在真正执行前重新检查用户控制权，避免已排队的旧回调抢走滚动条。
    if (followFrame !== undefined) return
    followFrame = requestAnimationFrame(() => {
      followFrame = undefined
      if (userControlActive()) return
      // force 只绕过工作态门控；若排队后用户已经进入阅读态，旧帧仍必须作废。
      if (store.userScrolled) return
      if (!force && !active()) return
      scrollToBottomNow("auto")
    })
  }

  // 「当前不可滚动」不足以证明用户想恢复跟随底部：DOM 重建、工具卡片重组、
  // content-visibility 切换都可能让 scrollHeight 有一帧塌到 clientHeight。
  // 若在这一帧清掉 userScrolled，下一次 ResizeObserver 就会把正在阅读的用户拽到底部。
  // 恢复跟随只认一个信号：用户自己滚回底部附近（见 handleScroll 的 threshold 判定）。
  const stop = () => {
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) return
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const finishUserControl = () => {
    const direction = userControlDirection
    clearUserControl()

    const el = store.scrollRef
    if (!el || !canScroll(el)) return
    // 控制窗口结束时仍要尊重最后方向：向上轻滚即使只离底部几像素，也代表用户开始阅读历史。
    if (shouldHoldUserControl({ distance: distanceFromBottom(el), threshold: threshold(), direction })) {
      stop()
      return
    }

    // 用户手势结束且确实回到底部后才恢复跟随；控制窗口内到达底部只记录位置，不抢输入惯性。
    if (store.userScrolled) setStore("userScrolled", false)
    scrollToBottom(false)
  }

  const beginUserControl = (direction?: AutoScrollDirection) => {
    const el = store.scrollRef
    if (!el || !canScroll(el)) return

    const distance = distanceFromBottom(el)
    if (!shouldHoldUserControl({ distance, threshold: threshold(), direction })) {
      // 已经位于底部的向下手势不会产生 scroll 事件；必须在手势入口直接保持黏附，避免 1 秒空窗。
      clearUserControl()
      cancelFollow()
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(false)
      return
    }

    if (direction) userControlDirection = direction
    userControlUntil = Date.now() + userControlWindowMs
    cancelFollow()
    if (direction === "away" || distance >= threshold()) stop()

    if (userControlTimer) clearTimeout(userControlTimer)
    userControlTimer = setTimeout(finishUserControl, userControlWindowMs)
  }

  const handleWheel = (e: WheelEvent) => {
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    if (!e.deltaY) return

    // 从底部向上滚的第一次 wheel 在浏览器改 scrollTop 前触发，方向必须随手势一起交给状态机。
    beginUserControl(e.deltaY < 0 ? "away" : "toward")
  }

  const handleScrollEvent = (userGesture: boolean) => {
    const el = store.scrollRef
    if (!el) return

    if (!canScroll(el)) return

    const action = autoScrollAction({
      distance: distanceFromBottom(el),
      threshold: threshold(),
      userGesture,
      userControl: userControlActive(),
      direction: userControlDirection,
      userScrolled: store.userScrolled,
      auto: isAuto(el),
    })

    if (action === "hold") return

    if (action === "resume") {
      // 真实手势已经抵达底部，立即结束控制窗口并贴紧最新内容，与官方 Codex 的 user_follow 一致。
      clearUserControl()
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(false)
      return
    }

    // 只有没有真实手势的 scroll 事件才能沿用程序滚动标记；否则流式 ResizeObserver 会持续抢回滚动位置。
    if (action === "follow") {
      scrollToBottom(false)
      return
    }

    stop()
  }

  const handleScroll = () => handleScrollEvent(false)
  const handleUserScroll = () => handleScrollEvent(true)

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    el.style.overflowAnchor = options.overflowAnchor ?? "auto"
  }

  createResizeObserver(
    () => store.contentRef,
    () => {
      const el = store.scrollRef
      if (el && !canScroll(el)) return
      // 用户向上滚动阅读时完全不动 scrollTop，视口上方的高度变化交给浏览器原生
      // 滚动锚定补偿（overflowAnchor: "auto"）。
      if (store.userScrolled) return
      if (!active()) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false)
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled && !userControlActive()) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // 锚定策略是静态的，只需在 scrollRef 挂载后设置一次。
    const el = store.scrollRef
    if (!el) return
    updateOverflowAnchor(el)
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
    if (userControlTimer) clearTimeout(userControlTimer)
    cancelFollow()
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    // wheel 由 hook 自己监听；触摸、键盘和自定义滚动条在默认滚动发生前走此入口，
    // 让所有输入方式共享同一个惯性控制窗口。
    beginUserControl,
    // ScrollView 已经通过 wheel、触摸、键盘或滚动条拖拽确认是用户行为时，必须走这条高优先级路径。
    handleUserScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      clearUserControl()
      cancelFollow()
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    // 清掉阅读状态但不滚动。实例跨会话存活时，上一个会话的 userScrolled 会跟进新会话，
    // 让新会话既不落到底部、历史回填也被挡住，而用户在新会话里没有任何动作能自救。
    // 切换会话时由调用方重置，滚到哪里则交给 hash 定位逻辑决定，避免和 hash 目标抢位置。
    reset: () => {
      clearUserControl()
      cancelFollow()
      if (!store.userScrolled) return
      // 观察 userScrolled 翻回 false 的一方会把它当成「用户滚回底部了」。这里是切会话的
      // 程序化重置，不是用户动作，标记出来供其区分。
      resetConsumed = true
      setStore("userScrolled", false)
    },
    // 上一次 userScrolled 从 true 变 false 是否由 reset() 造成。读取即消费，
    // 因此不会误吞下一次真正由用户滚回底部触发的转换。
    consumeReset: () => {
      const value = resetConsumed
      resetConsumed = false
      return value
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => {
      clearUserControl()
      cancelFollow()
      scrollToBottom(true)
    },
    userScrolled: () => store.userScrolled,
  }
}
