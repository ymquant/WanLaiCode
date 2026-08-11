import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createFileTreeStore } from "./tree-store"

function createFailingTree() {
  let calls = 0
  const errors: string[] = []
  const tree = createFileTreeStore({
    scope: () => "workspace",
    normalizeDir: (input) => input,
    list: () => {
      calls++
      return Promise.reject(new Error("boom"))
    },
    onError: (_dir, message) => {
      errors.push(message)
    },
  })

  return { tree, calls: () => calls, errors: () => errors }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("file tree store list retries", () => {
  test("returns the in-flight promise while loading", async () => {
    let dispose: (() => void) | undefined
    let calls = 0
    let settled = false
    const pending = createDeferred<[]>()
    const tree = createRoot((done) => {
      dispose = done
      return createFileTreeStore({
        scope: () => "workspace",
        normalizeDir: (input) => input,
        list: () => {
          calls++
          return pending.promise
        },
        onError: () => {},
      })
    })

    try {
      void tree.listDir("")
      const second = tree.listDir("").then(() => {
        settled = true
      })
      await Promise.resolve()

      expect(calls).toBe(1)
      expect(settled).toBe(false)

      pending.resolve([])
      await second

      expect(settled).toBe(true)
    } finally {
      dispose?.()
    }
  })

  test("does not repeat failed non-forced lists", async () => {
    let dispose: (() => void) | undefined
    const state = createRoot((done) => {
      dispose = done
      return createFailingTree()
    })

    try {
      await state.tree.listDir("")
      await state.tree.listDir("")

      expect(state.calls()).toBe(1)
      expect(state.errors()).toEqual(["boom"])
    } finally {
      dispose?.()
    }
  })

  test("allows forced lists and explicit expand retry after failure", async () => {
    let dispose: (() => void) | undefined
    const state = createRoot((done) => {
      dispose = done
      return createFailingTree()
    })

    try {
      await state.tree.listDir("src")
      await state.tree.listDir("src", { force: true })
      state.tree.collapseDir("src")
      state.tree.expandDir("src")
      await Promise.resolve()

      expect(state.calls()).toBe(3)
    } finally {
      dispose?.()
    }
  })

  test("does not repeat onError for forced retries on an already-failed directory", async () => {
    let dispose: (() => void) | undefined
    const state = createRoot((done) => {
      dispose = done
      return createFailingTree()
    })

    try {
      await state.tree.listDir("src")
      await state.tree.listDir("src", { force: true })
      await state.tree.listDir("src", { force: true })

      expect(state.calls()).toBe(3)
      expect(state.errors()).toEqual(["boom"])
    } finally {
      dispose?.()
    }
  })

  test("forced retry on loaded directory that fails still reports onError", async () => {
    let dispose: (() => void) | undefined
    let calls = 0
    const errors: string[] = []
    const tree = createRoot((done) => {
      dispose = done
      return createFileTreeStore({
        scope: () => "workspace",
        normalizeDir: (input) => input,
        list: () => {
          calls++
          if (calls === 1) {
            return Promise.resolve([
              { name: "a", path: "a", absolute: "/a", type: "file" as const, ignored: false },
            ])
          }
          return Promise.reject(new Error("boom"))
        },
        onError: (_dir, message) => {
          errors.push(message)
        },
      })
    })

    try {
      await tree.listDir("src")
      expect(tree.dirState("src")?.loaded).toBe(true)

      await tree.listDir("src", { force: true })
      expect(tree.dirState("src")?.error).toBe("boom")

      expect(calls).toBe(2)
      expect(errors).toEqual(["boom"])
    } finally {
      dispose?.()
    }
  })

  test("forced retry on failed directory that succeeds clears error", async () => {
    let dispose: (() => void) | undefined
    let calls = 0
    const errors: string[] = []
    const tree = createRoot((done) => {
      dispose = done
      return createFileTreeStore({
        scope: () => "workspace",
        normalizeDir: (input) => input,
        list: () => {
          calls++
          if (calls < 2) return Promise.reject(new Error("boom"))
          return Promise.resolve([
            { name: "a", path: "a", absolute: "/a", type: "file" as const, ignored: false },
          ])
        },
        onError: (_dir, message) => {
          errors.push(message)
        },
      })
    })

    try {
      await tree.listDir("src")
      expect(tree.dirState("src")?.error).toBe("boom")

      await tree.listDir("src", { force: true })
      expect(tree.dirState("src")?.error).toBeUndefined()
      expect(tree.dirState("src")?.loaded).toBe(true)

      expect(calls).toBe(2)
      expect(errors).toEqual(["boom"])
    } finally {
      dispose?.()
    }
  })
})
