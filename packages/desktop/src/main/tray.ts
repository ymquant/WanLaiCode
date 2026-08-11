import { app, BrowserWindow, nativeImage, Tray } from "electron"

import { CHANNEL } from "./constants"
import { iconPath } from "./icons"
import { buildTrayContextMenu } from "./tray-menu"
import { trayTooltip } from "./tray-i18n"

// Stable Windows tray GUIDs — do not change after release. Windows uses these to keep a
// single notification-area slot across process restarts instead of briefly showing duplicates.
const TRAY_GUID = {
  dev: "c9e7b4a2-1f3d-4e5b-8c6d-9a0b1c2d3e4f",
  beta: "d8f6c5b3-2e4a-5f6c-9d8e-0b1c2d3e4f5a",
  prod: "e7a5d4c3-3b5f-6a7d-8e9f-1c2d3e4f5a6b",
  canary: "e7a5d4c3-3b5f-6a7d-8e9f-1c2d3e4f5a6b",
} as const

const TRAY_STATE_KEY = "__wanlaicodeTrayState__"

type TrayDeps = {
  showMainWindow: () => void
  triggerCommand: (id: string) => void
  openSession: (target: { directory: string; sessionID: string }) => void
  listRecentSessions: () => Promise<import("./tray-sessions").TrayRecentSession[]>
  canUseAppCommands: () => boolean
}

type TrayState = {
  instance: Tray | null
  deps: TrayDeps | null
  quitHooked: boolean
}

let quitting = false
const trayHidden = new WeakMap<BrowserWindow, boolean>()

function trayState(): TrayState {
  const globalState = globalThis as unknown as Record<string, TrayState | undefined>
  if (!globalState[TRAY_STATE_KEY]) {
    globalState[TRAY_STATE_KEY] = { instance: null, deps: null, quitHooked: false }
  }
  return globalState[TRAY_STATE_KEY]!
}

function destroyTrayInstance() {
  const state = trayState()
  if (state.instance && !state.instance.isDestroyed()) {
    state.instance.destroy()
  }
  state.instance = null
}

export function destroyTray() {
  destroyTrayInstance()
}

export function refreshTrayLocale() {
  const state = trayState()
  if (state.instance && !state.instance.isDestroyed()) state.instance.setToolTip(trayTooltip())
}

function wireQuitHook() {
  const state = trayState()
  if (state.quitHooked) return
  state.quitHooked = true
  app.on("before-quit", () => destroyTrayInstance())
  process.on("exit", () => destroyTrayInstance())
}

// 菜单栏托盘图标的逻辑尺寸（pt）
const TRAY_ICON_SIZE = 18

// macOS：App 图标是「深色圆角方块 + 金色 W 字标」，整块不透明，直接当托盘会渲染成大彩块、
// 设 template 又会变成纯色方块。这里在运行时从位图抠出金色字标做成黑色剪影（透明背景）的
// template image——只保留字标形状，菜单栏单色渲染、自动适配明暗。
// 在代码里生成而非用资产文件：predev 的 copy-icons.ts 每次 rm -rf resources/icons 重建，
// 放进去的额外文件会被清掉；而 icon.png 一定在，且此法自动适配任意 brand/channel 的图标。
function buildMacTrayImage(src: import("electron").NativeImage): import("electron").NativeImage | null {
  const { width, height } = src.getSize()
  if (width === 0 || height === 0) return null
  const bmp = src.toBitmap() // BGRA
  const out = Buffer.alloc(bmp.length) // 全 0 = 透明
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const b = bmp[o]
    const g = bmp[o + 1]
    const r = bmp[o + 2]
    const a = bmp[o + 3]
    // 金色字标：暖色且足够亮（深色背景 r,g,b 都低 → 排除）
    if (a > 20 && r > 90 && r - b > 40 && r + g > 140) {
      out[o + 3] = a // 黑色(BGR=0) + 原 alpha，作为 template 的形状遮罩
      const x = i % width
      const y = (i / width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return null // 没抠到任何字标像素
  const silhouette = nativeImage.createFromBitmap(out, { width, height })
  // 裁到字标边界框（去掉四周留白），加约 8% padding，再缩到菜单栏尺寸
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const cropped = silhouette.crop({ x: minX, y: minY, width: cw, height: ch })
  return cropped.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: "best" })
}

function createTrayInstance() {
  const source = nativeImage.createFromPath(iconPath())
  let trayImage = source.isEmpty() ? nativeImage.createEmpty() : source
  if (process.platform === "darwin" && !trayImage.isEmpty()) {
    const mac = buildMacTrayImage(source)
    if (mac && !mac.isEmpty()) {
      trayImage = mac
      trayImage.setTemplateImage(true) // 单色：浅色栏显黑、深色栏显白
    } else {
      // 兜底：抠图失败也不要在菜单栏留空，缩一下原图先顶上
      trayImage = trayImage.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: "best" })
    }
  } else if (process.platform === "linux" && !trayImage.isEmpty()) {
    trayImage = trayImage.resize({ width: 22, height: 22, quality: "best" })
  }
  // guid 仅 Windows 适用；非 win32 必须省略第二参——传 undefined 会让 Electron 按 GUID 校验并抛
  // "Invalid GUID format"，且该未捕获 rejection 抛在 app 启动链里会一并中断 sidecar 启动
  const guid = process.platform === "win32" ? TRAY_GUID[CHANNEL] : undefined
  return guid ? new Tray(trayImage, guid) : new Tray(trayImage)
}

function wireTrayEvents(tray: Tray) {
  tray.setToolTip(trayTooltip())

  const popUpContextMenu = () => {
    const deps = trayState().deps
    if (!deps) return
    tray.setToolTip(trayTooltip())
    void buildTrayContextMenu({
      showMainWindow: deps.showMainWindow,
      triggerCommand: deps.triggerCommand,
      openSession: deps.openSession,
      listRecentSessions: deps.listRecentSessions,
      canUseAppCommands: deps.canUseAppCommands,
      quit: () => {
        markAppQuitting()
        app.quit()
      },
    }).then((menu) => {
      if (!tray.isDestroyed()) tray.popUpContextMenu(menu)
    })
  }

  if (process.platform === "darwin") tray.on("click", popUpContextMenu)
  tray.on("right-click", popUpContextMenu)
  tray.on("double-click", () => trayState().deps?.showMainWindow())
}

export function markAppQuitting() {
  quitting = true
}

export function isAppQuitting() {
  return quitting
}

// 安装更新同步失败、app 实际并不会退出时用它回退，恢复 close-to-tray 语义
export function clearAppQuitting() {
  quitting = false
}

export function isWindowTrayHidden(win: BrowserWindow) {
  return trayHidden.get(win) ?? false
}

export function revealWindowFromTray(win: BrowserWindow) {
  trayHidden.set(win, false)
  if (process.platform === "win32" || process.platform === "linux") win.setSkipTaskbar(false)
  win.show()
  win.focus()
}

export function wireCloseToTray(win: BrowserWindow) {
  trayHidden.set(win, false)

  win.on("close", (event) => {
    if (quitting) return
    event.preventDefault()
    trayHidden.set(win, true)
    win.hide()
    if (process.platform === "win32" || process.platform === "linux") win.setSkipTaskbar(true)
  })

  win.on("show", () => {
    if (isWindowTrayHidden(win)) return
    if (process.platform === "win32" || process.platform === "linux") win.setSkipTaskbar(false)
  })
}

export function setupTray(deps: TrayDeps) {
  const state = trayState()
  state.deps = deps
  wireQuitHook()

  if (state.instance && !state.instance.isDestroyed()) return

  destroyTrayInstance()

  const tray = createTrayInstance()
  state.instance = tray
  wireTrayEvents(tray)
}
