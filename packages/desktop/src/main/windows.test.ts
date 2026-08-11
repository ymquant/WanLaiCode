import { describe, expect, mock, test } from "bun:test"
import { join } from "node:path"

const openWindows: { setBackgroundColor: ReturnType<typeof mock> }[] = []

mock.module("electron", () => ({
  default: {},
  app: {
    isPackaged: false,
    getAppPath: () => "/mock/app/path",
  },
  BrowserWindow: class {
    static getAllWindows = () => openWindows
    setBackgroundColor = mock()
  },
  Menu: {
    buildFromTemplate: () => ({}),
  },
  Tray: class {},
  net: {},
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    themeSource: "system",
  },
  protocol: {
    registerSchemesAsPrivileged: () => undefined,
    isProtocolHandled: () => false,
    handle: mock(),
  },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: {
        width: 1920,
        height: 1080,
      },
    }),
  },
}))

const electron = await import("electron")
const windows = await import("./windows")

describe("desktop login window", () => {
  test("loads a dedicated login entry instead of the main app entry", () => {
    expect(windows.loginWindowHtml()).toBe("login.html")
  })

  test("uses the 1024x680 reference canvas for the dedicated login window", () => {
    const options = windows.loginWindowOptions("light")

    expect(options.width).toBe(1024)
    expect(options.height).toBe(680)
    expect(options.resizable).toBe(false)
    expect(options.center).toBe(true)
    expect(options.show).toBe(false)
    expect(options.title).toBe("万来Code Dev")
    expect(options.minWidth).toBe(758)
    expect(options.minHeight).toBe(558)
  })

  test("builds a resizable 1024:680 login window config when ratio lock is requested", () => {
    const options = windows.loginWindowOptions("light", { resizable: true, lockAspectRatio: true })

    expect(options.width).toBe(1024)
    expect(options.height).toBe(680)
    expect(options.resizable).toBe(true)
    expect(options.minWidth).toBe(758)
    expect(options.minHeight).toBe(503)
  })

  test("reports the 1024:680 aspect ratio for reusable login sizing", () => {
    expect(windows.LOGIN_WINDOW_REFERENCE_SIZE.width).toBe(1024)
    expect(windows.LOGIN_WINDOW_REFERENCE_SIZE.height).toBe(680)
    expect(windows.LOGIN_WINDOW_ASPECT_RATIO).toBe(1024 / 680)
  })

  test("restores Electron native theme to system when app follows system color scheme", () => {
    windows.setTitlebar({
      setTitleBarOverlay: () => undefined,
      webContents: { getZoomFactor: () => 1 },
    } as never, { mode: "dark", source: "system" })

    expect(electron.nativeTheme.themeSource).toBe("system")
  })

  test("syncs Electron native material to manual dark color scheme", () => {
    windows.setTitlebar({
      setTitleBarOverlay: () => undefined,
      webContents: { getZoomFactor: () => 1 },
    } as never, { mode: "dark", source: "dark" })

    expect(electron.nativeTheme.themeSource).toBe("dark")
  })

  test("passes renderer theme colors to the Windows titlebar overlay", () => {
    const setTitleBarOverlay = mock()

    windows.setTitlebar({
      setTitleBarOverlay,
      webContents: { getZoomFactor: () => 1 },
    } as never, {
      mode: "dark",
      source: "dark",
      backgroundColor: "#181818",
      symbolColor: "#f3f3f4",
    })

    if (process.platform !== "win32") {
      expect(setTitleBarOverlay).not.toHaveBeenCalled()
      return
    }

    expect(setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#181818",
      symbolColor: "#f3f3f4",
      height: 36,
    })
    expect(windows.getBackgroundColor()).toBe("#181818")
  })

  test("uses Codex-style native material for the macOS main window", () => {
    const options = windows.mainWindowOptions("light")

    if (process.platform !== "darwin") return

    expect(options.backgroundColor).toBe("#00000000")
    expect(options.titleBarStyle).toBe("hiddenInset")
    expect(options.trafficLightPosition).toEqual({ x: 12, y: 14 })
    expect(options.vibrancy).toBe("menu")
  })

  test("keeps DWM rounded corners enabled for the Windows main window", () => {
    const options = windows.mainWindowOptions("light")

    if (process.platform !== "win32") return

    expect(options.frame).toBe(false)
    expect(options.roundedCorners).toBe(true)
    expect(options.titleBarStyle).toBe("hidden")
    if (windows.windowsBackdrop() === "mica") {
      expect(options.backgroundMaterial).toBe("mica")
      expect(options.backgroundColor).toBe("#00000000")
      expect(options.titleBarOverlay).toMatchObject({ color: "#00000000" })
    } else {
      expect(options.backgroundMaterial).toBeUndefined()
      expect(options.backgroundColor).not.toBe("#00000000")
    }
  })

  test("windowsBackdrop reports mica or none for renderer chrome gating", () => {
    const backdrop = windows.windowsBackdrop()
    if (process.platform !== "win32") {
      expect(backdrop).toBe("none")
      return
    }
    expect(["mica", "none"]).toContain(backdrop)
  })

  test("main getWindowConfig wiring always forwards windowsBackdrop to the renderer", async () => {
    // 守住审查闭环：主进程探测到 Mica 后必须经 getWindowConfig 下发，渲染端才能写 data-windows-backdrop。
    const source = await Bun.file(join(import.meta.dir, "index.ts")).text()
    expect(source).toContain("windowsBackdrop,")
    expect(source).toMatch(
      /getWindowConfig:\s*\(\)\s*=>\s*\(\{\s*updaterEnabled:\s*UPDATER_ENABLED,\s*windowsBackdrop:\s*windowsBackdrop\(\)\s*\}\)/,
    )
  })

  test("wanlai glass titlebar uses transparent overlay when Mica is available", () => {
    if (process.platform !== "win32") return
    if (windows.windowsBackdrop() !== "mica") return

    const setTitleBarOverlay = mock()
    const setBackgroundColor = mock()
    openWindows.length = 0
    openWindows.push({ setBackgroundColor })

    windows.setTitlebar(
      {
        setTitleBarOverlay,
        setBackgroundColor,
        webContents: { getZoomFactor: () => 1 },
      } as never,
      {
        mode: "light",
        source: "light",
        backgroundColor: "#f6f6f6",
        symbolColor: "#1a1c1f",
        glass: true,
      },
    )

    expect(setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#00000000",
      symbolColor: "#1a1c1f",
      height: 36,
    })
    expect(windows.getBackgroundColor()).toBe("#00000000")
    openWindows.length = 0
  })

  // glass=false + Mica 必须灌实色：见 titlebar-glass.test.ts（纯函数，Linux CI 可覆盖）

  test("registerRendererProtocol registers the oc renderer handler exactly once", () => {
    // 守住根因回归:oc:// 是反馈窗等所有打包页面的加载协议,handler 必须注册;
    // 且需幂等,以便正常启动与卸载反馈这两条互斥启动路径都能安全调用。
    const handle = electron.protocol.handle as ReturnType<typeof mock>
    handle.mockClear()

    windows.registerRendererProtocol()
    windows.registerRendererProtocol()

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0]?.[0]).toBe("oc")
  })

  test("renderer protocol falls back to index for MemoryRouter deep links", () => {
    // 打包端刷新会话深链时必须回到入口页，静态资源仍按原路径读取。
    expect(windows.rendererPathForRequest("/project/session/ses_test", "/mock/renderer")).toBe(
      "/mock/renderer/index.html",
    )
    expect(windows.rendererPathForRequest("/assets/main.js", "/mock/renderer")).toBe("/mock/renderer/assets/main.js")
    expect(windows.rendererPathForRequest("/%2e%2e/secret", "/mock/renderer")).toBeUndefined()
  })

  test("uses a transparent overlay with dark symbols in light mode on Windows", () => {
    const options = windows.loginWindowOptions("light")

    if (process.platform !== "win32") return

    expect(options.frame).toBe(false)
    expect(options.titleBarStyle).toBe("hidden")
    expect(options.titleBarOverlay).toEqual({
      color: "#00000000",
      symbolColor: "black",
      height: 36,
    })
  })

  test("applies background color to open Windows windows and remembers it for new windows", () => {
    const setBackgroundColor = mock()
    openWindows.length = 0
    openWindows.push({ setBackgroundColor })

    windows.setBackgroundColor("#f6f6f6")

    if (process.platform === "win32") {
      expect(setBackgroundColor).toHaveBeenCalledWith("#f6f6f6")
    } else {
      expect(setBackgroundColor).not.toHaveBeenCalled()
    }
    expect(windows.getBackgroundColor()).toBe("#f6f6f6")
    openWindows.length = 0
  })
})
