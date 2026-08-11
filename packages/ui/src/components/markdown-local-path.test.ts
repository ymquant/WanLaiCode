import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetPlatformCacheForTests,
  fileUrlFromAbsolutePath,
  isHtmlFilePath,
  isSystemBrowserModifier,
} from "./markdown-local-path"

const originalNavigator = globalThis.navigator

afterEach(() => {
  // 恢复 navigator 并清掉平台缓存，避免用例间污染。
  Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true })
  __resetPlatformCacheForTests()
})

function setNavigatorPlatform(platform: string) {
  // isPlatformMac 依据 userAgent 判定，这里按目标平台构造典型的 UA 串。
  const ua = platform === "MacIntel" ? "Mozilla/5.0 (Macintosh)" : "Mozilla/5.0 (Windows NT 10.0)"
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: ua }, configurable: true, writable: true })
  __resetPlatformCacheForTests()
}

describe("isHtmlFilePath", () => {
  test("matches html and htm regardless of case", () => {
    expect(isHtmlFilePath("C:/report.html")).toBe(true)
    expect(isHtmlFilePath("C:/report.HTML")).toBe(true)
    expect(isHtmlFilePath("C:/report.htm")).toBe(true)
    expect(isHtmlFilePath("C:/readme.ts")).toBe(false)
  })

  test("tolerates nullish input", () => {
    expect(isHtmlFilePath(undefined)).toBe(false)
    expect(isHtmlFilePath(null)).toBe(false)
    expect(isHtmlFilePath("")).toBe(false)
  })
})

describe("fileUrlFromAbsolutePath", () => {
  test("encodes URL metacharacters so the main-process extension check sees the full path", () => {
    // 回归：`#` 必须编码为 %23，否则 `report#1.html` 的 `#1.html` 会被下游当作 fragment，
    // 主进程只能看到 `report`（无扩展名）而误拒合法 HTML。
    expect(fileUrlFromAbsolutePath("/tmp/report#1.html")).toBe("file:///tmp/report%231.html")
    expect(fileUrlFromAbsolutePath("/tmp/report?x.html")).toBe("file:///tmp/report%3Fx.html")
    expect(fileUrlFromAbsolutePath("/tmp/50%.html")).toBe("file:///tmp/50%25.html")
    expect(fileUrlFromAbsolutePath("/tmp/a b.html")).toBe("file:///tmp/a%20b.html")
  })

  test("keeps the colon in windows drive-letter segments", () => {
    expect(fileUrlFromAbsolutePath("C:\\workspace\\report.html")).toBe("file:///C:/workspace/report.html")
    expect(fileUrlFromAbsolutePath("D:/report.htm")).toBe("file:///D:/report.htm")
  })

  test("produces three-slash file URLs for posix absolute paths", () => {
    expect(fileUrlFromAbsolutePath("/Users/developer/report.html")).toBe("file:///Users/developer/report.html")
  })
})

describe("isSystemBrowserModifier", () => {
  test("uses metaKey on macOS and ignores ctrlKey (which is the context-menu modifier)", () => {
    setNavigatorPlatform("MacIntel")
    expect(isSystemBrowserModifier({ metaKey: true })).toBe(true)
    expect(isSystemBrowserModifier({ ctrlKey: true })).toBe(false)
    expect(isSystemBrowserModifier({ metaKey: true, ctrlKey: true })).toBe(true)
    expect(isSystemBrowserModifier({})).toBe(false)
  })

  test("uses ctrlKey on windows/linux and ignores metaKey (which is the rarely-used Win/Super key)", () => {
    setNavigatorPlatform("Win32")
    expect(isSystemBrowserModifier({ ctrlKey: true })).toBe(true)
    expect(isSystemBrowserModifier({ metaKey: true })).toBe(false)
    expect(isSystemBrowserModifier({})).toBe(false)

    setNavigatorPlatform("Linux x86_64")
    expect(isSystemBrowserModifier({ ctrlKey: true })).toBe(true)
    expect(isSystemBrowserModifier({ metaKey: true })).toBe(false)
  })

  test("accepts an explicit platform override for deterministic testing", () => {
    expect(isSystemBrowserModifier({ metaKey: true }, { isMac: true })).toBe(true)
    expect(isSystemBrowserModifier({ ctrlKey: true }, { isMac: true })).toBe(false)
    expect(isSystemBrowserModifier({ ctrlKey: true }, { isMac: false })).toBe(true)
    expect(isSystemBrowserModifier({ metaKey: true }, { isMac: false })).toBe(false)
  })
})
