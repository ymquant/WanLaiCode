import { describe, expect, mock, test } from "bun:test"

mock.module("electron", () => ({
  default: {
    app: {
      getLocale: () => "en",
      getPath: () => "/tmp/wanlaicode-test",
    },
  },
  app: {
    getLocale: () => "en",
    getPath: () => "/tmp/wanlaicode-test",
  },
}))

describe("desktop context menu i18n", () => {
  test("localizes image context menu labels", async () => {
    const { contextMenuLabels, refreshContextMenuLabels } = await import("./context-menu-i18n")

    refreshContextMenuLabels("zh")

    expect(contextMenuLabels.saveImageAs).toBe("图片另存为...")
    expect(contextMenuLabels.copyImage).toBe("复制图片")
    expect(contextMenuLabels.inspect).toBe("检查元素")
  })
})
