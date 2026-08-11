import { EventEmitter } from "node:events"
import { readFile, unlink } from "node:fs/promises"
import { describe, expect, mock, test } from "bun:test"

const savePath = "/tmp/wanlaicode-image.png"
const setSavePath = mock((_path: string) => undefined)
const showSaveDialog = mock(async () => ({ canceled: false, filePath: savePath }))

class MockDownloadItem extends EventEmitter {
  constructor(private readonly url: string) {
    super()
  }

  getURL() {
    return this.url
  }

  setSavePath(path: string) {
    setSavePath(path)
  }
}

class MockWebContents {
  session = new EventEmitter()
  domImageSource = ""

  downloadURL(url: string) {
    queueMicrotask(() => {
      const item = new MockDownloadItem(url)
      // Electron 41 在图片另存为路径里可能不给 owner webContents；这里固定传 null 做回归。
      this.session.emit("will-download", {}, item, null)
      queueMicrotask(() => item.emit("done", {}, "completed"))
    })
  }

  executeJavaScript() {
    return Promise.resolve(this.domImageSource)
  }
}

mock.module("electron", () => ({
  default: {},
  app: {
    getPath: () => "/tmp",
  },
  BrowserWindow: class {
    static fromWebContents = mock(() => null)
    webContents = new MockWebContents()
    isDestroyed() {
      return false
    }
  },
  dialog: {
    showSaveDialog,
  },
}))

const electron = await import("electron")
const { contextMenuImageFilename, saveContextMenuImageAs } = await import("./context-menu-download")

describe("context menu image download", () => {
  test("sanitizes image filename from URL", () => {
    expect(contextMenuImageFilename("https://example.com/images/fish%20one.png?x=1")).toBe("fish one.png")
    expect(contextMenuImageFilename("not a url")).toBe("image.png")
  })

  test("saves image when will-download has no owner webContents", async () => {
    const win = new electron.BrowserWindow()

    await saveContextMenuImageAs(win, { srcURL: "https://example.com/fish.png", x: 0, y: 0 })

    expect(showSaveDialog).toHaveBeenCalledWith(win, { defaultPath: "/tmp/fish.png" })
    expect(setSavePath).toHaveBeenCalledWith(savePath)
  })

  test("saves data image found from context menu coordinates", async () => {
    const win = new electron.BrowserWindow() as InstanceType<typeof electron.BrowserWindow> & {
      webContents: MockWebContents
    }
    win.webContents.domImageSource = "data:image/png;base64,aGVsbG8="

    await saveContextMenuImageAs(win, { srcURL: "", x: 10, y: 20 })

    expect(showSaveDialog).toHaveBeenCalledWith(win, { defaultPath: "/tmp/image.png" })
    expect(await readFile(savePath, "utf8")).toBe("hello")
    await unlink(savePath).catch(() => undefined)
  })
})
