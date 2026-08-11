# 自动化页「像素级对照 Codex」工作流

由于复刻方(Claude)在沙盒里**看不到渲染**(截图/CDP/网络受限),像素级对齐靠「你在本地跑出 diff → 发回 → 据 diff 精修」的循环完成。本目录提供这个闭环工具。

## 一次性准备

1. 确认桌面端在跑:`bun dev:desktop`(electron-vite dev 会暴露 CDP 端口 `:9222`,启动日志里有 `DevTools listening on ws://…:9222`)。
2. 安装 Playwright 浏览器(只需一次):
   ```bash
   cd packages/app && bunx playwright install chromium
   ```
3. 放置 **Codex 基线截图**:把你截的 Codex 自动化页图,命名为 `codex-automations-darwin.png`,放到:
   ```
   packages/app/e2e/automation-visual.spec.ts-snapshots/codex-automations-darwin.png
   ```
   (Playwright 基线按 `<快照名>-<平台>.png` 命名;macOS 平台后缀是 `darwin`。)

## 跑对比

```bash
cd packages/app
bunx playwright test e2e/automation-visual.spec.ts
```

- **通过** = 差异在阈值内。
- **失败** = 生成 diff:在 `packages/app/e2e/playwright-report/` 或 `test-results/` 下,有三张图——基线、实际、**diff(红色标差异)**。

## 把结果发回我

把 `test-results/.../*-diff.png`(红色差异图)发我,我据它 + 已抠出的 Codex token,精准改我们的圆角/间距/配色/字体,再让你重跑,直到 diff 收敛。

## 已抠出的 Codex 真实 design token(对齐参照)

来自 `Codex.app` 的 `app-main` CSS:

| 类别 | token |
|---|---|
| 圆角 | md `8px` · lg `10px` · xl `12px` · 2xl `16px` · full `9999px` |
| 主按钮底色 | `#0d0d0d`(active `1a`/hover `0f`/inactive `08` 透明度) |
| 弹层/卡片底 | elevated `#212121f5`(深)/`#ffffffb3`(浅) |
| 边框 | 默认 `#ffffff14` · light `#ffffff0a` · heavy `#ffffff29` · focus `#339cffb3` |
| 图标 | primary `#ffffffe6` · secondary `#ffffffb3` · tertiary `#ffffff80` |
| 字体 | `-apple-system, BlinkMacSystemFont, "Segoe UI"` · 字重 medium `500`/semibold `600` |
| 间距基准 | `--spacing: 4px`(Tailwind v4,与本项目一致) |

> 注:多数颜色是「深/浅双主题」双值;对齐时按当前主题取对应值。
