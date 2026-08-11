import { test, expect, chromium } from "@playwright/test"

// 自动化页「像素级对照 Codex」视觉回归。
// 连接本地 Electron(electron-vite dev 暴露的 CDP :9222)截取我们的 /automations 渲染,
// 与放在 __snapshots__ 里的 Codex 基线截图做逐像素 pixelmatch 对比,输出红色 diff。
//
// 用法见同目录 VISUAL-DIFF.md。
// 仅本地手动运行:需先 `bun dev:desktop` 启动桌面 app(暴露 CDP :9222),再设 VISUAL_DIFF=1。
// CI 无运行中的桌面 app,默认跳过,避免 connectOverCDP ECONNREFUSED。
test("自动化页 vs Codex 基线", async () => {
  test.skip(!process.env.VISUAL_DIFF, "本地视觉对比工具:需手动启动桌面 app 并设 VISUAL_DIFF=1")
  const cdp = process.env.CDP ?? "http://127.0.0.1:9222"
  const browser = await chromium.connectOverCDP(cdp)

  const pages = browser.contexts().flatMap((c) => c.pages())
  const page = pages.find((p) => p.url().includes("localhost:5173")) ?? pages.find((p) => p.url().startsWith("http")) ?? pages[0]
  if (!page) throw new Error("找不到 renderer 页;确认 `bun dev:desktop` 正在运行(vite :5173)")

  // 进入自动化页:点左侧边栏「自动化」入口
  const entry = page.locator('[data-action="globals-automations"]')
  if (await entry.count()) {
    await entry.first().click()
    await page.waitForTimeout(800)
  }

  // 与 Codex 基线对比(基线放置见 VISUAL-DIFF.md)。
  // maxDiffPixelRatio 先放宽到 0.1,迭代收敛时调小。
  await expect(page).toHaveScreenshot("codex-automations.png", {
    maxDiffPixelRatio: 0.1,
    animations: "disabled",
  })
})
