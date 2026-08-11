export type SidecarHealthOutcome = { healthy: boolean; notifiedSlow: boolean }

export type AwaitSidecarHealthInput = {
  wait: Promise<void>
  slowMs: number
  timeoutMs: number
  onSlow: () => void
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

// 等待 sidecar 健康检查，并在迟迟不通过时先给启动窗一个可见诊断：
// 否则健康检查最长会静默等满 timeoutMs，用户只看到转圈动画，拿不到任何线索。
// 无论超时还是 wait 本身失败都不抛错——启动流程必须继续，降级提示由后续窗口负责。
export async function awaitSidecarHealth(input: AwaitSidecarHealthInput): Promise<SidecarHealthOutcome> {
  const setTimer = input.setTimer ?? setTimeout
  const clearTimer = input.clearTimer ?? clearTimeout

  // 健康检查刚好在阈值附近就绪时，慢速定时器的回调可能已经入队、赶在 clearTimer
  // 之前执行，从而在一切正常的启动上闪一下告警。settled 用来挡掉这种迟到回调。
  let settled = false
  let notifiedSlow = false
  const slowTimer = setTimer(() => {
    if (settled) return
    notifiedSlow = true
    input.onSlow()
  }, input.slowMs)

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timeoutTimer = setTimer(() => resolve(false), input.timeoutMs)
  })

  try {
    const healthy = await Promise.race([input.wait.then(() => true).catch(() => false), timedOut])
    settled = true
    return { healthy, notifiedSlow }
  } finally {
    clearTimer(slowTimer)
    clearTimer(timeoutTimer)
  }
}
