import { describe, expect, test } from "bun:test"
import {
  resolveMarkdownExternalLinkClickTarget,
  resolveMarkdownFileLinkClickTarget,
  resolveMarkdownHtmlFileBrowserClick,
  stableMarkdownBlockPrefix,
  shouldOpenHtmlFileInSystemBrowser,
} from "./markdown"
import { createMarkdownLocalPathHandler } from "./markdown-local-path"
import { resolveEditActivityFileClick } from "./message-part-file-click"

describe("stableMarkdownBlockPrefix", () => {
  test("keeps unchanged streaming blocks and replaces only the growing tail", () => {
    const previous = [{ id: "full:a" }, { id: "live:b" }]
    const next = [{ id: "full:a" }, { id: "live:c" }]

    // 第一块已经稳定，尾块变化时 DOM 更新必须从索引 1 开始，不能重新挂载整篇前缀。
    expect(stableMarkdownBlockPrefix(previous, next)).toBe(1)
  })

  test("handles appended, removed and fully unchanged block lists", () => {
    expect(stableMarkdownBlockPrefix([{ id: "a" }], [{ id: "a" }, { id: "b" }])).toBe(1)
    expect(stableMarkdownBlockPrefix([{ id: "a" }, { id: "b" }], [{ id: "a" }])).toBe(1)
    expect(stableMarkdownBlockPrefix([{ id: "a" }], [{ id: "a" }])).toBe(1)
  })
})

describe("resolveMarkdownFileLinkClickTarget", () => {
  test("prefers local path opening for file links when available", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/Users/developer/Desktop/output.zip",
        absolutePath: "C:/Users/developer/Desktop/output.zip",
        canOpenInReview: true,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "local", value: "C:/Users/developer/Desktop/output.zip", kind: undefined })
  })

  test("falls back to review panel opening when local opening is unavailable", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/Users/developer/Desktop/output.zip",
        absolutePath: "C:/Users/developer/Desktop/output.zip",
        canOpenInReview: true,
        canOpenLocal: false,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "review" })
  })

  test("falls back to local path opening for file links when review opening is unavailable", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/Users/developer/Desktop/output.zip",
        absolutePath: "C:/Users/developer/Desktop/output.zip",
        canOpenInReview: false,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "local", value: "C:/Users/developer/Desktop/output.zip", kind: undefined })
  })

  test("falls back to external file URL when local opening is unavailable", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/Users/developer/Desktop/output.zip",
        absolutePath: "C:/Users/developer/Desktop/output.zip",
        canOpenInReview: false,
        canOpenLocal: false,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "external", value: "file:///C:/Users/developer/Desktop/output.zip" })
  })

  test("opens local directory paths without requiring a href", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        absolutePath: "C:/Users/developer/Desktop/release-test-backup",
        canOpenInReview: false,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "local", value: "C:/Users/developer/Desktop/release-test-backup", kind: undefined })
  })

  test("preserves the resolved kind when routing a local path", () => {
    const opened: Array<[string, "file" | "directory" | undefined]> = []
    const target = resolveMarkdownFileLinkClickTarget({
      absolutePath: "C:/workspace/docs",
      kind: "directory",
      canOpenInReview: true,
      canOpenLocal: true,
      canOpenExternal: true,
    })

    if (target?.type === "local") opened.push([target.value, target.kind])
    expect(opened).toEqual([["C:/workspace/docs", "directory"]])
  })

  test("keeps html file on local path for ordinary click", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/workspace/report.html",
        absolutePath: "C:/workspace/report.html",
        kind: "file",
        preferReview: false,
        canOpenInReview: true,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "local", value: "C:/workspace/report.html", kind: "file" })
  })

  test("limits system browser shortcut to html files with command modifier", () => {
    expect(shouldOpenHtmlFileInSystemBrowser("C:/workspace/report.html", true, false, { isMac: false })).toBe(true)
    expect(shouldOpenHtmlFileInSystemBrowser("C:/workspace/report.htm", false, true, { isMac: true })).toBe(true)
    expect(shouldOpenHtmlFileInSystemBrowser("C:/workspace/report.html", false, false)).toBe(false)
    expect(shouldOpenHtmlFileInSystemBrowser("C:/workspace/readme.ts", true, false, { isMac: false })).toBe(false)
    // macOS 上 Ctrl+点击是右键菜单等价操作，不应触发系统浏览器
    expect(shouldOpenHtmlFileInSystemBrowser("C:/workspace/report.html", true, false, { isMac: true })).toBe(false)
    // Win/Linux 上 Meta（Win 键）不触发
    expect(shouldOpenHtmlFileInSystemBrowser("C:/workspace/report.html", false, true, { isMac: false })).toBe(false)
  })

  test("keeps non-html files and directories on the ordinary local path when command-clicked", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/workspace/readme.ts",
        absolutePath: "C:/workspace/readme.ts",
        kind: "file",
        preferReview: false,
        canOpenInReview: true,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "local", value: "C:/workspace/readme.ts", kind: "file" })

    expect(
      resolveMarkdownFileLinkClickTarget({
        absolutePath: "C:/workspace/docs",
        kind: "directory",
        preferReview: false,
        canOpenInReview: true,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "local", value: "C:/workspace/docs", kind: "directory" })
  })

  test("keeps ordinary external links available", () => {
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "https://example.com/output",
        canOpenInReview: false,
        canOpenLocal: true,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "external", value: "https://example.com/output" })
  })
})

describe("createMarkdownLocalPathHandler", () => {
  test("keeps review fallback when browser and local openers are unavailable", () => {
    const handler = createMarkdownLocalPathHandler({})

    expect(handler).toBeUndefined()
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/workspace/report.html",
        absolutePath: "C:/workspace/report.html",
        canOpenInReview: true,
        canOpenLocal: !!handler,
        canOpenExternal: true,
      }),
    ).toEqual({ type: "review" })
  })

  test("browser-only opener handles html files and keeps fallback for ordinary files and directories", () => {
    const opened: string[] = []
    const handler = createMarkdownLocalPathHandler({ fileContextMenuActions: { openInBrowser: (path) => opened.push(path) } })

    expect(handler?.canOpen?.("C:/workspace/report.html", "file")).toBe(true)
    handler?.("C:/workspace/report.html", "file")
    expect(opened).toEqual(["C:/workspace/report.html"])
    expect(handler?.canOpen?.("C:/workspace/readme.ts", "file")).toBe(false)
    expect(handler?.canOpen?.("C:/workspace/docs", "directory")).toBe(false)
    expect(
      resolveMarkdownFileLinkClickTarget({
        href: "file:///C:/workspace/readme.ts",
        absolutePath: "C:/workspace/readme.ts",
        canOpenInReview: true,
        canOpenLocal: !!handler && !!handler.canOpen?.("C:/workspace/readme.ts", "file"),
        canOpenExternal: true,
      }),
    ).toEqual({ type: "review" })
  })

  test("local-only opener handles all local paths", () => {
    const opened: Array<[string, "file" | "directory" | undefined]> = []
    const handler = createMarkdownLocalPathHandler({
      openLocalPath: (path, kind) => {
        opened.push([path, kind])
      },
    })

    expect(handler?.canOpen?.("C:/workspace/report.html", "file")).toBe(true)
    expect(handler?.canOpen?.("C:/workspace/readme.ts", "file")).toBe(true)
    expect(handler?.canOpen?.("C:/workspace/docs", "directory")).toBe(true)
    handler?.("C:/workspace/readme.ts", "file")
    expect(opened).toEqual([["C:/workspace/readme.ts", "file"]])
  })

  test("combined browser and local openers route html to browser and other local paths to local opener", () => {
    const browserOpened: string[] = []
    const localOpened: Array<[string, "file" | "directory" | undefined]> = []
    const handler = createMarkdownLocalPathHandler({
      openLocalPath: (path, kind) => {
        localOpened.push([path, kind])
      },
      fileContextMenuActions: {
        openInBrowser: (path) => {
          browserOpened.push(path)
        },
      },
    })

    expect(handler?.canOpen?.("C:/workspace/report.html", "file")).toBe(true)
    expect(handler?.canOpen?.("C:/workspace/readme.ts", "file")).toBe(true)
    expect(handler?.canOpen?.("C:/workspace/docs", "directory")).toBe(true)
    handler?.("C:/workspace/report.html", "file")
    handler?.("C:/workspace/readme.ts", "file")
    handler?.("C:/workspace/docs", "directory")
    expect(browserOpened).toEqual(["C:/workspace/report.html"])
    expect(localOpened).toEqual([
      ["C:/workspace/readme.ts", "file"],
      ["C:/workspace/docs", "directory"],
    ])
  })
})

describe("resolveMarkdownHtmlFileBrowserClick", () => {
  test("routes ordinary html file clicks to the builtin browser opener", () => {
    expect(
      resolveMarkdownHtmlFileBrowserClick({
        href: "file:///C:/workspace/report.html",
        absolutePath: "C:/workspace/report.html",
        kind: "file",
        canOpenExternal: true,
        canOpenSystem: true,
      }),
    ).toEqual({ type: "builtin", value: "file:///C:/workspace/report.html" })
  })

  test("routes command-clicked html file clicks to the system browser opener", () => {
    expect(
      resolveMarkdownHtmlFileBrowserClick({
        href: "file:///C:/workspace/report.html",
        absolutePath: "C:/workspace/report.html",
        kind: "file",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toEqual({ type: "system", value: "file:///C:/workspace/report.html" })

    expect(
      resolveMarkdownHtmlFileBrowserClick({
        href: "file:///C:/workspace/report.htm",
        absolutePath: "C:/workspace/report.htm",
        kind: "file",
        metaKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: true },
      }),
    ).toEqual({ type: "system", value: "file:///C:/workspace/report.htm" })
  })

  test("builds a file url from absolute html paths when href is unavailable", () => {
    expect(
      resolveMarkdownHtmlFileBrowserClick({
        absolutePath: "C:\\workspace\\report.html",
        kind: "file",
        canOpenExternal: true,
        canOpenSystem: true,
      }),
    ).toEqual({ type: "builtin", value: "file:///C:/workspace/report.html" })
  })

  test("keeps non-html files and directories out of the html browser shortcut", () => {
    expect(
      resolveMarkdownHtmlFileBrowserClick({
        href: "file:///C:/workspace/readme.ts",
        absolutePath: "C:/workspace/readme.ts",
        kind: "file",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toBeUndefined()

    expect(
      resolveMarkdownHtmlFileBrowserClick({
        href: "file:///C:/workspace/docs.html",
        absolutePath: "C:/workspace/docs.html",
        kind: "directory",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toBeUndefined()
  })
})

describe("resolveMarkdownExternalLinkClickTarget", () => {
  test("routes ordinary external links to the builtin opener", () => {
    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "https://example.com/docs",
        canOpenExternal: true,
        canOpenSystem: true,
      }),
    ).toEqual({ type: "builtin", value: "https://example.com/docs" })
  })

  test("routes command-clicked external links to the system browser opener", () => {
    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "https://example.com/docs",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toEqual({ type: "system", value: "https://example.com/docs" })

    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "https://example.com/docs",
        metaKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: true },
      }),
    ).toEqual({ type: "system", value: "https://example.com/docs" })
  })

  test("routes inline html file links by modifier while preserving ordinary file links", () => {
    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "file:///C:/workspace/report.html",
        canOpenExternal: true,
        canOpenSystem: true,
      }),
    ).toEqual({ type: "builtin", value: "file:///C:/workspace/report.html" })

    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "file:///C:/workspace/report.html",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toEqual({ type: "system", value: "file:///C:/workspace/report.html" })

    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "file:///C:/workspace/readme.ts",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toEqual({ type: "builtin", value: "file:///C:/workspace/readme.ts" })
  })

  test("keeps command-clicked non-html file urls out of the system browser target", () => {
    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "file:///C:/workspace/archive.zip",
        ctrlKey: true,
        canOpenExternal: false,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toBeUndefined()

    expect(
      resolveMarkdownExternalLinkClickTarget({
        href: "file:///C:/workspace/archive.zip",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toEqual({ type: "builtin", value: "file:///C:/workspace/archive.zip" })
  })
})

describe("resolveEditActivityFileClick", () => {
  test("routes ordinary html file clicks to the builtin browser opener", () => {
    expect(
      resolveEditActivityFileClick({
        absolutePath: "C:\\workspace\\report.html",
        canOpenExternal: true,
        canOpenSystem: true,
      }),
    ).toEqual({ type: "builtin", value: "file:///C:/workspace/report.html" })
  })

  test("routes modifier-clicked html files to the system browser opener", () => {
    expect(
      resolveEditActivityFileClick({
        absolutePath: "C:\\workspace\\report.html",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toEqual({ type: "system", value: "file:///C:/workspace/report.html" })

    expect(
      resolveEditActivityFileClick({
        absolutePath: "/workspace/report.htm",
        metaKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: true },
      }),
    ).toEqual({ type: "system", value: "file:///workspace/report.htm" })
  })

  test("keeps non-html files on the default opener path", () => {
    expect(
      resolveEditActivityFileClick({
        absolutePath: "C:\\workspace\\readme.ts",
        ctrlKey: true,
        canOpenExternal: true,
        canOpenSystem: true,
        platform: { isMac: false },
      }),
    ).toBeUndefined()

    expect(
      resolveEditActivityFileClick({
        absolutePath: "C:\\workspace\\archive.zip",
        canOpenExternal: true,
        canOpenSystem: true,
      }),
    ).toBeUndefined()
  })
})
