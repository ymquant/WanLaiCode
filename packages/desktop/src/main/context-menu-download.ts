import { basename, join } from "node:path"
import { copyFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  app,
  BrowserWindow,
  dialog,
  type ContextMenuParams,
  type DownloadItem,
  type Event,
  type WebContents,
} from "electron"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function contextMenuWebContents(target: unknown) {
  if (!record(target)) return
  const getWebContents = target.getWebContents
  if (typeof getWebContents === "function") return getWebContents.call(target) as WebContents | undefined
  if ("webContents" in target && target.webContents) return target.webContents as WebContents
  return target as unknown as WebContents
}

function contextMenuBrowserWindow(target: unknown) {
  if (target instanceof BrowserWindow) return target
  const webContents = contextMenuWebContents(target)
  if (!webContents) return
  return BrowserWindow.fromWebContents(webContents)
}

function safeFilename(value: string) {
  const name = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
  return name || "image.png"
}

export function contextMenuImageFilename(srcURL: string) {
  if (srcURL.startsWith("data:")) return "image.png"
  try {
    const url = new URL(srcURL)
    const name = basename(decodeURIComponent(url.pathname))
    return safeFilename(name || "image.png")
  } catch {
    return "image.png"
  }
}

function downloadURLToPath(win: BrowserWindow, srcURL: string, filePath: string) {
  return new Promise<void>((resolve, reject) => {
    const webContents = win.webContents
    const currentSession = webContents.session
    let started = false
    const timeout = windowlessTimeout(() => {
      currentSession.removeListener("will-download", listener)
      reject(new Error("Image download did not start"))
    })

    const listener = (_event: Event, item: DownloadItem) => {
      if (started) return
      const itemURL = item.getURL()
      if (itemURL && itemURL !== srcURL) return
      started = true
      clearTimeout(timeout)
      currentSession.removeListener("will-download", listener)
      item.setSavePath(filePath)
      item.once("done", (_doneEvent, state) => {
        if (state === "completed") {
          resolve()
          return
        }
        if (state === "cancelled") {
          resolve()
          return
        }
        reject(new Error(`Image download ${state}`))
      })
    }

    currentSession.on("will-download", listener)
    try {
      // 右键图片另存为必须绑定到当前窗口的 webContents；Electron 41 的 will-download 可能不给 owner webContents。
      webContents.downloadURL(srcURL)
    } catch (err) {
      clearTimeout(timeout)
      currentSession.removeListener("will-download", listener)
      reject(err)
    }
  })
}

async function contextMenuImageSource(win: BrowserWindow, properties: Pick<ContextMenuParams, "srcURL" | "x" | "y">) {
  const srcURL = properties.srcURL.trim()
  if (srcURL) return srcURL

  // Electron 对 data: 图片有时不给 srcURL；用右键坐标回到页面里找真正的 img 地址。
  const source = await win.webContents.executeJavaScript(
    `(() => {
      const element = document.elementFromPoint(${JSON.stringify(properties.x)}, ${JSON.stringify(properties.y)})
      const image = element?.closest?.("img") ?? element?.querySelector?.("img")
      return image?.currentSrc || image?.src || ""
    })()`,
    true,
  )
  return typeof source === "string" ? source.trim() : ""
}

async function saveURLToPath(win: BrowserWindow, srcURL: string, filePath: string) {
  if (srcURL.startsWith("data:")) {
    // data: 图片已经在渲染层内存中，主进程直接解码写盘，避免 downloadURL 走空 ownerWebContents。
    await writeFile(filePath, Buffer.from(await (await fetch(srcURL)).arrayBuffer()))
    return
  }
  if (srcURL.startsWith("file:")) {
    // 本地 file: 图片不是 Electron downloadURL 支持的协议，直接复制源文件。
    await copyFile(fileURLToPath(srcURL), filePath)
    return
  }
  await downloadURLToPath(win, srcURL, filePath)
}

function windowlessTimeout(callback: () => void) {
  return setTimeout(callback, 30_000)
}

export async function saveContextMenuImageAs(target: unknown, properties: Pick<ContextMenuParams, "srcURL" | "x" | "y">) {
  const win = contextMenuBrowserWindow(target)
  if (!win || win.isDestroyed()) return
  const srcURL = await contextMenuImageSource(win, properties)
  if (!srcURL) return

  const result = await dialog.showSaveDialog(win, {
    defaultPath: join(app.getPath("downloads"), contextMenuImageFilename(srcURL)),
  })
  if (result.canceled || !result.filePath) return
  await saveURLToPath(win, srcURL, result.filePath)
}
