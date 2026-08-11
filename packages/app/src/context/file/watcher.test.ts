import { describe, expect, test } from "bun:test"
import { createWatcherInvalidator, invalidateFromWatcher } from "./watcher"

describe("file watcher invalidation", () => {
  test("reloads open files and refreshes loaded parent on add", () => {
    const loads: string[] = []
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/new.ts",
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(loads).toEqual(["src/new.ts"])
    expect(refresh).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    const loads: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => loads.push(path),
        node: () => ({
          path: "src/open.ts",
          type: "file",
          name: "open.ts",
          absolute: "/repo/src/open.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )

    expect(loads).toEqual(["src/open.ts"])
  })

  test("工作区根 change 事件刷新根目录（normalize→\"\" 不再被丢弃）", () => {
    // drain 折叠到工作区根时产生根事件；normalize 对工作区根返回 ""，
    // 需刷新 refreshDir("")，而不是被开头的空路径守卫丢弃。
    const refresh: string[] = []
    const loads: string[] = []
    invalidateFromWatcher(
      { type: "file.watcher.updated", properties: { file: "/proj", event: "change" } },
      {
        normalize: (input) => (input === "/proj" ? "" : input),
        hasFile: () => false,
        loadFile: (p) => loads.push(p),
        node: () => undefined,
        isDirLoaded: (path) => path === "",
        refreshDir: (path) => refresh.push(path),
      },
    )
    expect(refresh).toEqual([""])
    expect(loads).toEqual([]) // 不对根路径 "" 调 loadFile
  })

  test("refreshes only changed loaded directory nodes", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/src/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("ignores invalid or git watcher updates", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: () => {
          throw new Error("should not load")
        },
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("skips refresh when parent directory is in error state", () => {
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        isDirError: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("skips refresh when changed directory itself is in error state", () => {
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        isDirError: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("skips refresh when an ancestor directory is in error state", () => {
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/components/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: (path) => path === "src/components",
        isDirError: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("skips refresh on directory change when an ancestor is in error state", () => {
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/components",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/components",
          type: "directory",
          name: "components",
          absolute: "/repo/src/components",
          ignored: false,
        }),
        isDirLoaded: (path) => path === "src/components",
        isDirError: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("coalesces rapid events into a single refresh per directory", async () => {
    const refresh: string[] = []
    const invalidator = createWatcherInvalidator({
      debounceMs: 50,
      schedule: (fn) => {
        setTimeout(fn, 50)
      },
      normalize: (input) => input,
      hasFile: () => false,
      loadFile: () => {},
      node: () => undefined,
      isDirLoaded: () => true,
      refreshDir: (path) => refresh.push(path),
    })

    for (let i = 0; i < 20; i++) {
      invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/a.ts", event: "add" } })
    }
    await new Promise((r) => setTimeout(r, 80))

    expect(refresh).toEqual(["src"])
  })

  test("merges out-of-order add/unlink within the window into one refresh", async () => {
    const refresh: string[] = []
    const invalidator = createWatcherInvalidator({
      debounceMs: 50,
      schedule: (fn) => {
        setTimeout(fn, 50)
      },
      normalize: (input) => input,
      hasFile: () => false,
      loadFile: () => {},
      node: () => undefined,
      isDirLoaded: () => true,
      refreshDir: (path) => refresh.push(path),
    })

    // 窗口内乱序：add 与 unlink 同一路径无论先后，最终都只触发 parent 目录一次刷新，
    // 刷新读取真实磁盘状态，因此天然消解窗口内的事件乱序。
    invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/a.ts", event: "add" } })
    invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/a.ts", event: "unlink" } })
    await new Promise((r) => setTimeout(r, 80))

    expect(refresh).toEqual(["src"])
  })

  test("cancel prevents a pending flush from firing after teardown", async () => {
    const refresh: string[] = []
    const invalidator = createWatcherInvalidator({
      debounceMs: 50,
      normalize: (input) => input,
      hasFile: () => false,
      loadFile: () => {},
      node: () => undefined,
      isDirLoaded: () => true,
      refreshDir: (path) => refresh.push(path),
    })

    invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/a.ts", event: "add" } })
    invalidator.cancel()
    await new Promise((r) => setTimeout(r, 80))

    expect(refresh).toEqual([])
  })
})
