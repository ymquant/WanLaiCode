import { sentryVitePlugin } from "@sentry/vite-plugin"
import { resolveBrandIdFromEnv } from "@opencode-ai/brand/table"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

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
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  define: {
    // Brand-aware app: Vite 构建时把 VITE_BRAND 烤进 bundle；走 resolveBrandIdFromEnv
    // 让 unknown env 也 fallback 到 MAIN_BRAND_ID，加新 brand 时不用动这里。
    "import.meta.env.VITE_BRAND": JSON.stringify(resolveBrandIdFromEnv(process.env)),
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
