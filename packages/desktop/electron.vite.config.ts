import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"

import { BRANDS, MAIN_BRAND_ID, resolveBrandIdFromEnv } from "../brand/src/table"

const channel = (() => {
  const raw = process.env.WANLAICODE_CHANNEL ?? process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod" || raw === "canary") return raw
  return "dev"
})()

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

function resolveNodePtyTarget(): { platform: string; arch: string } {
  const target = process.env.RUST_TARGET
  if (target) {
    const arch = target.startsWith("aarch64") ? "arm64" : "x64"
    if (target.includes("apple-darwin")) return { platform: "darwin", arch }
    if (target.includes("pc-windows")) return { platform: "win32", arch }
    if (target.includes("unknown-linux")) return { platform: "linux", arch }
  }
  return { platform: process.platform, arch: process.arch }
}

const nodePtyTarget = resolveNodePtyTarget()
const nodePtyPkg = `@lydell/node-pty-${nodePtyTarget.platform}-${nodePtyTarget.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.WANLAICODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      // opencode 通过 virtual:opencode-server 同进程 bundle 进 main，wanlaicode.ts
      // 模块加载时 getBrand() 会查 import.meta.env.VITE_BRAND。renderer 那边有注，
      // 但 main 不注就会回退到 MAIN_BRAND_ID，导致打包后 codex 的 per-brand
      // backend endpoint 静默失效。和 renderer 一样走 resolveBrandIdFromEnv 兜底
      // unknown env。
      "import.meta.env.VITE_BRAND": JSON.stringify(resolveBrandIdFromEnv(process.env)),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
      // @opencode-ai/brand 强制 bundle 进 main：brand 包内部用无后缀 `from "./table"`，
      // 一旦被 externalize（默认会，因为它在 desktop dependencies 里），electron 起动时
      // 由 Node 严格 ESM loader 解析这条相对路径就 ERR_MODULE_NOT_FOUND（不会自动补 .ts）。
      // exclude 让 vite resolver 全权处理它，结果 brand 整包内联进 main bundle，不留给 Node。
      externalizeDeps: { include: [nodePtyPkg], exclude: ["@opencode-ai/brand"] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [
      appPlugin,
      sentry,
      {
        // Vite 默认只 transform `index.html`。electron-vite 这里把 loading.html /
        // login.html 也加进 rollup input，每个 HTML 都会触发 transformIndexHtml，
        // 我们用同一个占位 `%BRAND_NAME_CN%` 在构建期烤进 brand 中文名。
        name: "html-brand-replace",
        transformIndexHtml(html: string) {
          const nameCn = (BRANDS[resolveBrandIdFromEnv(process.env)] ?? BRANDS[MAIN_BRAND_ID]).nameCn
          return html.replaceAll("%BRAND_NAME_CN%", nameCn)
        },
      },
    ],
    publicDir: "../../../app/public",
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_WANLAICODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
      // 走 resolveBrandIdFromEnv 保证 unknown env 也 fallback 到 MAIN_BRAND_ID；硬编
      // "wanlai" 会让加新 brand 时 default 永远是 main，无法靠注册表自动扩展。
      "import.meta.env.VITE_BRAND": JSON.stringify(resolveBrandIdFromEnv(process.env)),
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
          login: "src/renderer/login.html",
          updateProgress: "src/renderer/update-progress.html",
          uninstallFeedback: "src/renderer/uninstall-feedback.html",
          imagePreview: "src/renderer/image-preview.html",
        },
      },
    },
  },
})
