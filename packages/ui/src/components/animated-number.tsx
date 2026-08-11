import { For, Index, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"

const TRACK = Array.from({ length: 30 }, (_, index) => index % 10)
const DURATION = 600
// 安全区间：30 格轨道的中间一段 [10,20)。offset 一旦越出（无论递增 ≥20 还是递减 <10），
// 就无动画地归位到该段（同一数字、视觉无变化）——轨道每 10 格重复同一数字。这样能避免连续快速
// 滚动时 offset 单调累加/递减、把滚动条推出轨道导致数字变空白。递增/递减两个方向都要保护。
const OFFSET_SAFE_MIN = 10
const OFFSET_SAFE_MAX = 20

function normalize(value: number) {
  return ((value % 10) + 10) % 10
}

function spin(from: number, to: number, direction: 1 | -1) {
  if (from === to) return 0
  if (direction > 0) return (to - from + 10) % 10
  return -((from - to + 10) % 10)
}

function Digit(props: { value: number; direction: 1 | -1 }) {
  // 用两个 signal 而非 createStore：Digit 会随消息里的工具/diff 计数成百上千地挂载，
  // createStore 初始化的深度 unwrap 在会话切换时累积成可观的主线程成本
  const [step, setStep] = createSignal(props.value + 10)
  const [animating, setAnimating] = createSignal(false)
  let last = props.value

  createEffect(
    on(
      () => props.value,
      (next) => {
        const delta = spin(last, next, props.direction)
        last = next
        if (!delta) {
          setAnimating(false)
          setStep(next + 10)
          return
        }

        setAnimating(true)
        setStep((value) => value + delta)
      },
      { defer: true },
    ),
  )

  // 溢出保护：连续快速滚动时 onTransitionEnd 不会触发（过渡始终被下一次更新打断），
  // step 会单调累加（递增）或递减（递减）直至滚出 30 格轨道 → 数字变空白。这里在 step 越出
  // 安全区间 [10,20) 时于下一帧无动画地归位（同一数字、视觉无变化），把 step 收敛在轨道内。
  // 递增与递减两个方向都要保护（AnimatedNumber 也用于会减少的计数）。
  const outOfBand = (value: number) => value < OFFSET_SAFE_MIN || value >= OFFSET_SAFE_MAX
  let rebaseFrame: number | undefined
  createEffect(() => {
    if (!outOfBand(step()) || rebaseFrame !== undefined) return
    rebaseFrame = requestAnimationFrame(() => {
      rebaseFrame = undefined
      if (!outOfBand(step())) return
      setAnimating(false)
      setStep((value) => normalize(value) + 10)
    })
  })
  onCleanup(() => {
    if (rebaseFrame !== undefined) cancelAnimationFrame(rebaseFrame)
  })

  return (
    <span data-slot="animated-number-digit">
      <span
        data-slot="animated-number-strip"
        data-animating={animating() ? "true" : "false"}
        onTransitionEnd={() => {
          setAnimating(false)
          setStep((value) => normalize(value) + 10)
        }}
        style={{
          "--animated-number-offset": `${step()}`,
          "--animated-number-duration": `var(--tool-motion-odometer-ms, ${DURATION}ms)`,
        }}
      >
        <For each={TRACK}>{(value) => <span data-slot="animated-number-cell">{value}</span>}</For>
      </span>
    </span>
  )
}

export function AnimatedNumber(props: { value: number; class?: string }) {
  const target = createMemo(() => {
    if (!Number.isFinite(props.value)) return 0
    return Math.max(0, Math.round(props.value))
  })

  const [value, setValue] = createSignal(target())
  const [direction, setDirection] = createSignal<1 | -1>(1)

  createEffect(
    on(
      target,
      (next) => {
        const current = value()
        if (next === current) return

        setDirection(next > current ? 1 : -1)
        setValue(next)
      },
      { defer: true },
    ),
  )

  const label = createMemo(() => value().toString())
  const digits = createMemo(() =>
    Array.from(label(), (char) => {
      const code = char.charCodeAt(0) - 48
      if (code < 0 || code > 9) return 0
      return code
    }).reverse(),
  )
  const width = createMemo(() => `${digits().length}ch`)

  return (
    <span data-component="animated-number" class={props.class} aria-label={label()}>
      <span data-slot="animated-number-value" style={{ "--animated-number-width": width() }}>
        <Index each={digits()}>{(digit) => <Digit value={digit()} direction={direction()} />}</Index>
      </span>
    </span>
  )
}
