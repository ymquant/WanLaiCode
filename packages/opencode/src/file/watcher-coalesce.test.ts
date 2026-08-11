import { describe, expect, test } from "bun:test"
import { WatcherBuffer, mergeWatcherKind, parcelKindToEvent, parentDir } from "./watcher-coalesce"

describe("parcelKindToEvent", () => {
  test("映射 parcel 事件类型到 bus 事件类型", () => {
    expect(parcelKindToEvent("create")).toBe("add")
    expect(parcelKindToEvent("update")).toBe("change")
    expect(parcelKindToEvent("delete")).toBe("unlink")
    expect(parcelKindToEvent("unknown")).toBeUndefined()
  })
})

describe("parentDir", () => {
  test("posix 路径取父目录", () => {
    expect(parentDir("/a/b/c.txt")).toBe("/a/b")
  })
  test("windows 反斜杠路径取父目录", () => {
    expect(parentDir("C:\\a\\b\\c.txt")).toBe("C:\\a\\b")
  })
  test("无分隔符原样返回", () => {
    expect(parentDir("c.txt")).toBe("c.txt")
  })
  test("posix 根子路径 → 根，且根是不动点", () => {
    expect(parentDir("/a")).toBe("/")
    expect(parentDir("/")).toBe("/")
  })
  test("windows 盘符根子路径 → 盘符根（保留分隔符），且盘符根是不动点", () => {
    expect(parentDir("C:\\a")).toBe("C:\\")
    expect(parentDir("C:\\")).toBe("C:\\")
  })
  test("UNC 根是不动点，其子路径折叠到 UNC 根", () => {
    expect(parentDir("\\\\server\\share\\a")).toBe("\\\\server\\share")
    expect(parentDir("\\\\server\\share")).toBe("\\\\server\\share")
  })
})

describe("mergeWatcherKind 状态转换合并", () => {
  test("首次事件原样返回", () => {
    expect(mergeWatcherKind(undefined, "add")).toBe("add")
    expect(mergeWatcherKind(undefined, "change")).toBe("change")
    expect(mergeWatcherKind(undefined, "unlink")).toBe("unlink")
  })
  test("新文件 add→change 保留 add（否则客户端不刷父目录，新文件不出现在树里）", () => {
    expect(mergeWatcherKind("add", "change")).toBe("add")
  })
  test("最新结构性事件（add/unlink）决定最终存在态", () => {
    expect(mergeWatcherKind("add", "unlink")).toBe("unlink")
    expect(mergeWatcherKind("change", "unlink")).toBe("unlink")
    expect(mergeWatcherKind("unlink", "add")).toBe("add")
    expect(mergeWatcherKind("change", "add")).toBe("add")
  })
  test("删除后又变更＝重新出现，按 add", () => {
    expect(mergeWatcherKind("unlink", "change")).toBe("add")
  })
  test("纯内容变更保持 change", () => {
    expect(mergeWatcherKind("change", "change")).toBe("change")
  })
})

describe("WatcherBuffer 状态转换去重", () => {
  test("新文件 add→change→change 保留 add（[P1] 回归）", () => {
    const buf = new WatcherBuffer()
    buf.add("/a/x.ts", "add")
    buf.add("/a/x.ts", "change")
    buf.add("/a/x.ts", "change")
    expect(buf.size).toBe(1)
    expect(buf.drain(1000)).toEqual([{ file: "/a/x.ts", event: "add" }])
  })

  test("已存在文件 change→change 保持 change", () => {
    const buf = new WatcherBuffer()
    buf.add("/a/x.ts", "change")
    buf.add("/a/x.ts", "change")
    expect(buf.drain(1000)).toEqual([{ file: "/a/x.ts", event: "change" }])
  })

  test("add 后 unlink 收敛为 unlink", () => {
    const buf = new WatcherBuffer()
    buf.add("/a/tmp.o", "add")
    buf.add("/a/tmp.o", "unlink")
    expect(buf.drain(1000)).toEqual([{ file: "/a/tmp.o", event: "unlink" }])
  })

  test("drain 后清空", () => {
    const buf = new WatcherBuffer()
    buf.add("/a/x.ts", "change")
    buf.drain(1000)
    expect(buf.size).toBe(0)
    expect(buf.drain(1000)).toEqual([])
  })

  test("不超过上限时逐文件输出", () => {
    const buf = new WatcherBuffer()
    buf.add("/a/x.ts", "add")
    buf.add("/a/y.ts", "change")
    const events = buf.drain(1000)
    expect(events).toEqual([
      { file: "/a/x.ts", event: "add" },
      { file: "/a/y.ts", event: "change" },
    ])
  })
})

describe("WatcherBuffer 超阈值折叠为目录", () => {
  test("超过上限时折叠成唯一父目录的 change 事件", () => {
    const buf = new WatcherBuffer()
    // 3 个文件分布在 2 个目录，cap=2 触发折叠
    buf.add("/proj/build/a.o", "add")
    buf.add("/proj/build/b.o", "add")
    buf.add("/proj/dist/c.js", "change")
    const events = buf.drain(2)
    // 折叠后应为 2 个目录级 change 事件，且去重
    expect(events).toHaveLength(2)
    expect(new Set(events)).toEqual(
      new Set([
        { file: "/proj/build", event: "change" },
        { file: "/proj/dist", event: "change" },
      ]),
    )
  })

  test("折叠后的目录数远小于文件数", () => {
    const buf = new WatcherBuffer()
    for (let i = 0; i < 5000; i++) buf.add(`/proj/target/deps/f${i}.rlib`, "add")
    const events = buf.drain(2000)
    // 5000 个文件同属一个目录 → 折叠成 1 个目录事件
    expect(events).toEqual([{ file: "/proj/target/deps", event: "change" }])
  })

  test("恰好等于上限不折叠", () => {
    const buf = new WatcherBuffer()
    buf.add("/a/x.ts", "add")
    buf.add("/a/y.ts", "add")
    const events = buf.drain(2)
    expect(events).toEqual([
      { file: "/a/x.ts", event: "add" },
      { file: "/a/y.ts", event: "add" },
    ])
  })

  test("分散在大量不同目录时逐级向上折叠，输出量 ≤ cap（[P2] 回归）", () => {
    const buf = new WatcherBuffer()
    // 2001 个文件分别在 2001 个不同目录，cap=2000：父目录级仍是 2001>cap，
    // 再向上折叠到共同祖先 /proj → 1 条，输出 ≤ cap。
    for (let i = 0; i < 2001; i++) buf.add(`/proj/d${i}/f.o`, "add")
    const events = buf.drain(2000)
    expect(events.length).toBeLessThanOrEqual(2000)
    expect(events).toEqual([{ file: "/proj", event: "change" }])
  })

  test("多层目录逐级折叠直到 ≤ cap", () => {
    const buf = new WatcherBuffer()
    // 6 个文件在 6 个目录，分属两个二级目录，cap=2 → 父目录级 6>2 → 祖父级 {/proj/a,/proj/b}=2 ≤ cap
    for (const sub of ["a", "b"]) for (let i = 0; i < 3; i++) buf.add(`/proj/${sub}/d${i}/f.o`, "add")
    const events = buf.drain(2)
    expect(events.length).toBeLessThanOrEqual(2)
    expect(new Set(events)).toEqual(
      new Set([
        { file: "/proj/a", event: "change" },
        { file: "/proj/b", event: "change" },
      ]),
    )
  })

  test("工作区就是 posix 根：顶层目录折叠到根、不突破 cap（关宇复审回归）", () => {
    const buf = new WatcherBuffer()
    buf.add("/a", "add")
    buf.add("/b", "add")
    const events = buf.drain(1)
    expect(events).toEqual([{ file: "/", event: "change" }])
  })

  test("工作区就是盘符根：顶层目录折叠到盘符根", () => {
    const buf = new WatcherBuffer()
    buf.add("C:\\a", "add")
    buf.add("C:\\b", "add")
    const events = buf.drain(1)
    expect(events).toEqual([{ file: "C:\\", event: "change" }])
  })
})
