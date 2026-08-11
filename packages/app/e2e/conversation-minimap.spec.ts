import { expect, test } from "@playwright/test"

test("Minimap follows the session container breakpoints and details-card state", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => {
    const container = document.createElement("div")
    container.id = "minimap-container-query-test"
    container.style.containerType = "inline-size"
    const chat = document.createElement("div")
    chat.dataset.ui = "codex-chat"
    const cardState = document.createElement("div")
    cardState.dataset.cardOpen = "false"
    const minimap = document.createElement("nav")
    minimap.dataset.component = "conversation-minimap"
    cardState.append(minimap)
    chat.append(cardState)
    container.append(chat)
    document.body.append(container)
  })

  const displayAt = async (width: number, cardOpen: boolean) =>
    page.evaluate(
      async ({ width, cardOpen }) => {
        const container = document.querySelector<HTMLElement>("#minimap-container-query-test")
        const cardState = container?.querySelector<HTMLElement>("[data-card-open]")
        const minimap = container?.querySelector<HTMLElement>('[data-component="conversation-minimap"]')
        if (!container || !cardState || !minimap) throw new Error("Minimap test DOM is incomplete")
        container.style.width = `${width}px`
        cardState.dataset.cardOpen = String(cardOpen)
        // 连续两帧让 Chromium 完成容器查询重算，断言读取生产 CSS 的最终计算样式。
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        return getComputedStyle(minimap).display
      },
      { width, cardOpen },
    )

  // 覆盖 reviewer 指定的全部临界像素；关闭详情卡时 928px 起始终展示。
  expect(await displayAt(927, false)).toBe("none")
  expect(await displayAt(928, false)).toBe("block")
  expect(await displayAt(1099, false)).toBe("block")
  expect(await displayAt(1100, false)).toBe("block")
  expect(await displayAt(1223, false)).toBe("block")
  expect(await displayAt(1224, false)).toBe("block")

  // 打开详情卡只隐藏 1100-1223px 的冲突区间，不能影响两侧边界。
  expect(await displayAt(927, true)).toBe("none")
  expect(await displayAt(928, true)).toBe("block")
  expect(await displayAt(1099, true)).toBe("block")
  expect(await displayAt(1100, true)).toBe("none")
  expect(await displayAt(1223, true)).toBe("none")
  expect(await displayAt(1224, true)).toBe("block")
})
