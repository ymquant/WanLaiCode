# Brand 注册表

Multi-brand 支持：所有 brand 字面量集中在 `table.ts`，runtime 由 env 变量 `WANLAICODE_BRAND` 选；加新 brand 不用改 router 代码，往注册表加一条 entry + 准备配套资源即可。

## 文件分工

| 文件 | 作用 | 加载侧 |
|------|------|--------|
| `table.ts` | 单 source of truth：`BRANDS: Record<string, BrandRecord>` + `MAIN_BRAND_ID` + `resolveBrandIdFromEnv()` | Node + Vite/浏览器 都可加载（**无 `import.meta` / 浏览器 API**） |
| `index.ts` | 在 `table` 之上叠 Vite-injected `import.meta.env.VITE_BRAND` 解析；frozen singleton 暴露 `getBrand()` / `brandNameCn()` / `brandNameEn()` / `brandNameForLocale()` | 浏览器 runtime（Vite 烤 env） |
| `logos.ts` | `BRAND_LOGOS: Record<string, BrandLogoSet>`，每 brand 注册 `Mark / MarkGray / Splash / Logo` 4 个 solid-js 组件；`logo.tsx` router 按 `getBrand().id` 查 + 缺时 fallback `MAIN_BRAND_ID` | 浏览器 runtime |
| `logo-<brand>.tsx` | 单 brand 的 SVG 组件实现 | 浏览器 runtime |

## 主品牌 vs 子品牌

| 角色 | 例 | workflow | 范围 |
|------|----|----------|------|
| **主品牌** | wanlai | `.github/workflows/publish.yml` | 全套：bump version → commit → tag → push → GH Release upload → mirror → S3 |
| **子品牌** | codex | `.github/workflows/publish-subbrand.yml` | 拿已有 tag 重新打 brand 包 → S3 上传；**不**动 tag/release/main |

`table.ts` 的 `MAIN_BRAND_ID` 常量同时是：
- runtime 解析的 default fallback（unknown env 走它）
- 主品牌发布工作流的隐含目标

## 加一个新 brand（4 步）

### 1. `table.ts` 加 BRANDS entry

```ts
export const BRANDS = {
  wanlai: { /* ... */ },
  codex:  { /* ... */ },
  myBrand: {
    id: "myBrand",
    nameCn: "我的品牌",
    nameEn: "MyBrand",
    urlScheme: "wanlaicode",        // 跨 brand 共享（appId 一致互装即覆盖）
    artifactPrefix: "MyBrand",      // ASCII-only installer 文件名前缀
    // 可选：
    iconDirName: "myBrand",          // 默认就是 id；显式写出更清晰
    ui: {
      footerShowUpgrade: true,       // 侧边栏右下角入口换"升级"
    },
  },
} as const satisfies Record<string, BrandRecord>
```

`BrandId` 类型自动从 `keyof typeof BRANDS` 推导，TS 编译期就能 narrow 到新 id。

### 2. 加 Logo 组件（可选）

如果你想要新 brand 用独立 logo：

- 新建 `packages/ui/src/brand/logo-myBrand.tsx`，参照 `logo-wanlai.tsx` / `logo-codex.tsx` 实现 4 个 export：`MyBrandMark` / `MyBrandMarkGray` / `MyBrandSplash` / `MyBrandLogo`，签名跟现有保持一致
- `logos.ts` 加 `BRAND_LOGOS.myBrand = { Mark: MyBrandMark, MarkGray: MyBrandMarkGray, Splash: MyBrandSplash, Logo: MyBrandLogo }`

不加就 fallback 到 `MAIN_BRAND_ID` 的 logo（router 自动兜底）。

### 3. 放 OS 壳层图标

`packages/desktop/icons/<dirName>/` 放整套 PNG / icns / ico。`dirName` 取自：
- 显式 `iconDirName` 最高优先级
- 主品牌（`id === MAIN_BRAND_ID`）走 channel（dev/beta/prod）兜底
- 其他默认用 `id`

最简单：用 `app-icon-<brand>.png` 当源图，扩 `regen-icons.py` 或手动生成派生资源。

### 4. 加到 publish-subbrand.yml 的 choice

`.github/workflows/publish-subbrand.yml` 的 `inputs.brand.options` 列表加一行：

```yaml
options:
  - codex
  - myBrand
```

跟主品牌共享 tag —— 先用 `publish.yml` 发主品牌得到 `v0.0.X` tag，再触发 `publish-subbrand.yml` 选 `brand=myBrand, tag=v0.0.X` 出子品牌包。

## 注意点

- 所有 brand **共享 `urlScheme = "wanlaicode"` + 共享 `appId = "ai.wanlaicode.desktop"`** —— 这是"互装即覆盖"的核心约定。多套 OS 蛇皮不能在同一台机器共存
- `artifactPrefix` 必须 ASCII（GitHub Release API 会丢非 ASCII；S3 路径里也强烈建议 ASCII）
- `nameCn` / `nameEn` 是用户可见显示名，给 i18n `{{appName}}` 占位用
- `BrandRecord.ui` 是 brand-specific UI 行为开关集合，每加一个分支条件就抽到这里数据化（不要新加 `id === "myBrand"` 三元）
