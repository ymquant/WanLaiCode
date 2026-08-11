# Desktop App Icons

桌面端三个 channel（`beta` / `dev` / `prod`）共用同一张源图，全部派生资源由脚本一键生成。

## 重新生成图标

1. 准备一张 **1024×1024 透明 PNG** 作为源图，按 Apple Big Sur app icon 模板做（外圈 100px 透明 padding 让 macOS 系统画阴影，内容居中放在 824×824 区域，黄色 glyph 占黑色 squircle 约 75% 留出舒适边距）。Apple 官方模板：https://developer.apple.com/design/resources/
2. 覆盖到 `packages/desktop/app-icon.png`
3. 在仓库根目录执行 `python3 packages/desktop/scripts/regen-icons.py`

脚本会用 `sips` + `iconutil` + PIL 生成 18 个 PNG（包括 `dock.png`、`icon.png`、Windows Square*x* 系列、Mac 各档 PNG）+ `icon.icns`（10 档 16→1024@2x）+ `icon.ico`（7 档 16→256），分发到三个 channel 目录，三个 channel 的产物 byte-for-byte 相同。

## 已知不踩的坑

- **不要用 `bun tauri icon`** 重新生成 `icon.icns`：会丢掉源图的透明 padding，macOS Dock / Finder 上图标视觉比其他 app 大一圈（commit `2adc42203` 就是修这个）。
- **`dock.png` 不需要手动从 `icon.icns` 提取**：脚本直接从源图生成 256×256 PNG，跟 `128x128@2x.png` 等价。dev 模式 Electron 走 `app.dock.setIcon(dock.png)`，跟打包后用的 `icon.icns` 都派生自同一张源图，自动保持一致。

## 不在脚本范围内的资源

- `android/` 和 `ios/` 子目录是移动端资源，独立维护
- `packages/ui/src/assets/favicon/favicon.ico` 是 web favicon，独立维护

## 子品牌图标约定

主品牌（wanlai）和所有子品牌共享 `appId` / URL scheme / rpm 包名（互装即覆盖），但 OS 壳层 icon / productName / installer 文件名按 brand 分。每个 brand 自带一套源图和派生资源：

| brand | source image | derived dir | 备注 |
|-------|--------------|-------------|------|
| wanlai (主) | `packages/desktop/app-icon.png` | `icons/{beta,dev,prod}/` | 三 channel 共用同一源图但分目录存（历史习惯） |
| codex | `packages/desktop/app-icon-codex.png` | `icons/codex/` | 单目录，独立 S3 channel `prod-codex/` 自更新 |
| `<new>` | `packages/desktop/app-icon-<id>.png` | `icons/<id>/` | 默认行为；可在 `BRANDS[id].iconDirName` 显式 override |

子品牌发布走 `.github/workflows/publish-subbrand.yml`（拿主品牌已发的 tag 重新打包），不动 tag/release/main，只传 S3。

### 重新生成子品牌派生资源

```
python3 packages/desktop/scripts/regen-icons.py --brand codex
```

不带 `--brand` 时默认 `wanlai`，派生到 `icons/{beta,dev,prod}/` 三个目录。

加新子品牌的完整指引在 `packages/ui/src/brand/README.md`。
