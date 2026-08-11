import { describe, expect, test } from "bun:test"
import { flushTerminalWriterWhenVisible, type TerminalWriterFlushResult, terminalWriter } from "./terminal-writer"

const createVisibilityDoc = (initial: DocumentVisibilityState) => {
  let state = initial
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const doc = {
    get visibilityState() {
      return state
    },
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener)
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener)
    },
  } as Pick<Document, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState }

  return {
    doc,
    setState(next: DocumentVisibilityState) {
      state = next
    },
    dispatchVisibilityChange() {
      for (const listener of listeners) {
        if (typeof listener === "function") listener(new Event("visibilitychange"))
        else listener.handleEvent(new Event("visibilitychange"))
      }
    },
    listenerCount() {
      return listeners.size
    },
  }
}

const createTimerToken = () => {
  const timer = setTimeout(() => {}, 0)
  clearTimeout(timer)
  return timer
}

describe("terminalWriter", () => {
  test("buffers and flushes once per schedule", () => {
    const calls: string[] = []
    const scheduled: VoidFunction[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => scheduled.push(flush),
    )

    writer.push("a")
    writer.push("b")
    writer.push("c")

    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()
    expect(calls).toEqual(["abc"])
  })

  test("flush is a no-op when empty", () => {
    const calls: string[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => flush(),
    )
    writer.flush()
    expect(calls).toEqual([])
  })

  test("flush waits for pending write completion", () => {
    const calls: string[] = []
    let done: VoidFunction | undefined
    const writer = terminalWriter(
      (data, finish) => {
        calls.push(data)
        done = finish
      },
      (flush) => flush(),
    )

    writer.push("a")

    let settled = false
    writer.flush(() => {
      settled = true
    })

    expect(calls).toEqual(["a"])
    expect(settled).toBe(false)

    done?.()
    expect(settled).toBe(true)
  })

  test("tracks queued characters waiting to be written", () => {
    const scheduled: VoidFunction[] = []
    let done: VoidFunction | undefined
    const writer = terminalWriter(
      (_data, finish) => {
        done = finish
      },
      (flush) => scheduled.push(flush),
    )

    writer.push("ab")
    writer.push("c")

    expect(writer.pending()).toBe(3)
    expect(writer.unsettled()).toBe(3)

    scheduled[0]?.()
    expect(writer.pending()).toBe(0)
    expect(writer.unsettled()).toBe(3)

    writer.push("de")
    expect(writer.pending()).toBe(2)
    expect(writer.unsettled()).toBe(5)

    done?.()
    expect(writer.pending()).toBe(2)
    expect(writer.unsettled()).toBe(2)

    scheduled[1]?.()
    expect(writer.pending()).toBe(0)
    expect(writer.unsettled()).toBe(2)

    done?.()
    expect(writer.unsettled()).toBe(0)
  })

  test("chunks large writes across schedules", () => {
    const calls: string[] = []
    const scheduled: VoidFunction[] = []
    let done: VoidFunction | undefined
    const writer = terminalWriter(
      (data, finish) => {
        calls.push(data)
        done = finish
      },
      (flush) => scheduled.push(flush),
      { maxChunkSize: 3 },
    )

    writer.push("abcdef")

    let settled = false
    writer.flush(() => {
      settled = true
    })

    expect(calls).toEqual(["abc"])
    expect(writer.pending()).toBe(3)
    expect(settled).toBe(false)

    done?.()
    expect(scheduled).toHaveLength(2)
    scheduled[1]?.()

    expect(calls).toEqual(["abc", "def"])
    done?.()
    expect(writer.pending()).toBe(0)
    expect(settled).toBe(true)
  })

  test("flushes when hidden terminal becomes visible and cancels timeout", () => {
    const calls: string[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      () => {},
    )
    const visibility = createVisibilityDoc("hidden")
    let timer: VoidFunction | undefined
    let cleared = 0
    let result: TerminalWriterFlushResult | undefined

    writer.push("visible output")
    flushTerminalWriterWhenVisible(writer, (next) => (result = next), {
      doc: visibility.doc,
      setTimeout: (callback) => {
        timer = callback
        return createTimerToken()
      },
      clearTimeout: () => cleared++,
    })

    visibility.setState("visible")
    visibility.dispatchVisibilityChange()
    timer?.()

    expect(calls).toEqual(["visible output"])
    expect(result).toEqual({ status: "flushed", droppedChars: 0 })
    expect(cleared).toBe(1)
    expect(visibility.listenerCount()).toBe(0)
  })

  test("hidden cleanup timeout drops queued output without waiting for scheduled write", () => {
    const calls: string[] = []
    const scheduled: VoidFunction[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => scheduled.push(flush),
    )
    const visibility = createVisibilityDoc("hidden")
    let timer: VoidFunction | undefined
    let result: TerminalWriterFlushResult | undefined

    writer.push("hidden output")
    flushTerminalWriterWhenVisible(writer, (next) => (result = next), {
      doc: visibility.doc,
      setTimeout: (callback) => {
        timer = callback
        return createTimerToken()
      },
      clearTimeout: () => {},
    })

    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)
    expect(writer.unsettled()).toBe("hidden output".length)

    timer?.()
    scheduled[0]?.()

    expect(calls).toEqual([])
    expect(writer.pending()).toBe(0)
    expect(result).toEqual({ status: "timeout", droppedChars: "hidden output".length })
    expect(visibility.listenerCount()).toBe(0)
  })

  test("hidden cleanup timeout reports in-flight write when callback never returns", () => {
    const calls: string[] = []
    const writer = terminalWriter(
      (data) => {
        calls.push(data)
      },
      (flush) => flush(),
    )
    const visibility = createVisibilityDoc("hidden")
    let timer: VoidFunction | undefined
    let result: TerminalWriterFlushResult | undefined
    let savedCursor: number | undefined

    writer.push("stuck")
    flushTerminalWriterWhenVisible(
      writer,
      (next) => {
        result = next
        savedCursor = 10 - next.droppedChars
      },
      {
        doc: visibility.doc,
        setTimeout: (callback) => {
          timer = callback
          return createTimerToken()
        },
        clearTimeout: () => {},
      },
    )

    expect(calls).toEqual(["stuck"])
    expect(writer.pending()).toBe(0)
    expect(writer.unsettled()).toBe(5)

    timer?.()

    expect(result).toEqual({ status: "timeout", droppedChars: 5 })
    expect(savedCursor).toBe(5)
    expect(visibility.listenerCount()).toBe(0)
  })

  test("does not complete twice after hidden cleanup timeout fires", () => {
    const writer = terminalWriter(
      () => {},
      () => {},
    )
    const visibility = createVisibilityDoc("hidden")
    let timer: VoidFunction | undefined
    let settled = 0

    writer.push("timeout output")
    flushTerminalWriterWhenVisible(writer, () => settled++, {
      doc: visibility.doc,
      setTimeout: (callback) => {
        timer = callback
        return createTimerToken()
      },
      clearTimeout: () => {},
    })

    timer?.()
    visibility.setState("visible")
    visibility.dispatchVisibilityChange()

    expect(settled).toBe(1)
    expect(visibility.listenerCount()).toBe(0)
  })
})
