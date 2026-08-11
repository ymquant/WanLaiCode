type TerminalWriterOptions = {
  maxChunkSize?: number
}

type FlushableTerminalOutput = {
  flush: (done?: VoidFunction) => void
  discard?: () => void
  unsettled?: () => number
}

export type TerminalWriterFlushResult =
  | { status: "flushed"; droppedChars: 0 }
  | { status: "timeout"; droppedChars: number }

type VisibilityDocument = Pick<Document, "addEventListener" | "removeEventListener"> & {
  visibilityState: DocumentVisibilityState
}

type VisibilityFlushOptions = {
  doc?: VisibilityDocument
  timeoutMs?: number
  setTimeout?: (callback: VoidFunction, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

export function terminalWriter(
  write: (data: string, done?: VoidFunction) => void,
  schedule: (flush: VoidFunction) => void = queueMicrotask,
  options: TerminalWriterOptions = {},
) {
  let chunks: string[] | undefined
  let waits: VoidFunction[] | undefined
  let pendingChars = 0
  let writingChars = 0
  let scheduled = false
  let writing = false
  const maxChunkSize = options.maxChunkSize ?? 32_768

  const settle = () => {
    if (scheduled || writing || chunks?.length) return
    const list = waits
    if (!list?.length) return
    waits = undefined
    for (const fn of list) {
      fn()
    }
  }

  const run = () => {
    if (writing) return
    scheduled = false
    const items = chunks
    if (!items?.length) {
      settle()
      return
    }
    const data = items.join("")
    const writeData = maxChunkSize > 0 && data.length > maxChunkSize ? data.slice(0, maxChunkSize) : data
    const remaining = writeData.length < data.length ? data.slice(writeData.length) : undefined
    chunks = remaining ? [remaining] : undefined
    pendingChars -= writeData.length
    writingChars += writeData.length
    writing = true
    write(writeData, () => {
      writing = false
      writingChars -= writeData.length
      if (chunks?.length) {
        if (scheduled) return
        scheduled = true
        schedule(run)
        return
      }
      settle()
    })
  }

  const push = (data: string) => {
    if (!data) return
    if (chunks) chunks.push(data)
    else chunks = [data]
    pendingChars += data.length

    if (scheduled || writing) return
    scheduled = true
    schedule(run)
  }

  const flush = (done?: VoidFunction) => {
    if (!scheduled && !writing && !chunks?.length) {
      done?.()
      return
    }
    if (done) {
      if (waits) waits.push(done)
      else waits = [done]
    }
    run()
  }

  const pending = () => pendingChars

  const unsettled = () => pendingChars + writingChars

  const discard = () => {
    chunks = undefined
    pendingChars = 0
    waits = undefined
  }

  return { push, flush, pending, unsettled, discard }
}

export function flushTerminalWriterWhenVisible(
  output: FlushableTerminalOutput | undefined,
  done: (result: TerminalWriterFlushResult) => void,
  options: VisibilityFlushOptions = {},
) {
  if (!output) {
    done({ status: "flushed", droppedChars: 0 })
    return
  }

  const doc = options.doc ?? document
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const cleanup = () => {
    doc.removeEventListener("visibilitychange", onVisible)
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  const complete = (result: TerminalWriterFlushResult) => {
    if (finished) return
    finished = true
    cleanup()
    done(result)
  }

  const flush = () => {
    cleanup()
    output.flush(() => complete({ status: "flushed", droppedChars: 0 }))
  }

  const onVisible = () => {
    if (doc.visibilityState !== "visible") return
    flush()
  }

  if (doc.visibilityState === "visible") {
    flush()
    return
  }

  doc.addEventListener("visibilitychange", onVisible)
  timer = setTimer(() => {
    timer = undefined
    const droppedChars = output.unsettled?.() ?? 0
    output.discard?.()
    complete({ status: "timeout", droppedChars })
  }, options.timeoutMs ?? 250)
}
