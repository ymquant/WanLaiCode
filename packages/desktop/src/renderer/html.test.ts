import { describe, expect, test } from "bun:test"
import { join, dirname, resolve } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(dir, "../..")

const html = async (name: string) => Bun.file(join(dir, name)).text()

/**
 * Packaged Electron windows load renderer HTML via the privileged `oc://`
 * protocol. Root-relative asset paths like `src="/foo.js"` would resolve from
 * the protocol origin root instead of relative to the current HTML entrypoint.
 *
 * All local resource references must use relative paths (`./`).
 */
describe("electron renderer html", () => {
  for (const name of ["index.html", "loading.html", "login.html", "uninstall-feedback.html", "image-preview.html"]) {
    describe(name, () => {
      test("script src attributes use relative paths", async () => {
        const content = await html(name)
        const srcs = [...content.matchAll(/\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
        for (const src of srcs) {
          expect(src).not.toMatch(/^\/[^/]/)
        }
      })

      test("link href attributes use relative paths", async () => {
        const content = await html(name)
        const hrefs = [...content.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1])
        for (const href of hrefs) {
          expect(href).not.toMatch(/^\/[^/]/)
        }
      })

      test("no web manifest link (not applicable in Electron)", async () => {
        const content = await html(name)
        expect(content).not.toContain('rel="manifest"')
      })
    })
  }

  test("loading window keeps native material except Windows solid statusbar background", async () => {
    const content = await html("loading.html")
    const view = await Bun.file(join(dir, "loading.tsx")).text()
    const styles = await Bun.file(join(dir, "styles.css")).text()

    expect(content).toContain('style="background-color: transparent"')
    expect(content).toContain('data-window="loading"')
    expect(view).toContain('data-component="desktop-loading-root"')
    expect(view).toContain('data-slot="desktop-loading-logo"')
    expect(view).toContain("function LoadingLogo")
    expect(view).toContain("desktop-loading-logo-glyph")
    expect(view).toContain('data-slot="desktop-loading-logo-sketch"')
    expect(view).toContain('data-slot="desktop-loading-logo-sweep"')
    expect(view).not.toContain("desktop-loading-logo-fill")
    expect(view).not.toContain("<animate")
    expect(view).not.toContain("<animateTransform")
    expect(styles).toContain('html[data-window="loading"]')
    expect(styles).toContain('[data-component="desktop-loading-root"]')
    expect(styles).toContain('background: transparent;')
    expect(styles).toContain('backdrop-filter: blur(48px) saturate(1.45);')
    expect(styles).toContain(':root[data-desktop-os="windows"][data-window="loading"]')
    expect(styles).toContain("var(--windows-statusbar-bg, light-dark(#ffffff, #181818))")
    expect(styles).toContain(":root[data-desktop-os=\"windows\"] [data-component=\"desktop-loading-root\"]::before")
    expect(styles).toContain("backdrop-filter: none !important;")
    expect(styles).toContain('[data-slot="desktop-loading-logo-svg"]')
    expect(styles).toContain('[data-slot="desktop-loading-logo-sketch"]')
    expect(styles).toContain('[data-slot="desktop-loading-logo-sweep"]')
    expect(styles).toContain("stroke-linejoin: round;")
    expect(styles).toContain("@keyframes desktop-loading-logo-presence")
    expect(styles).toContain("@keyframes desktop-loading-logo-sweep")
    expect(styles).toContain("animation: desktop-loading-logo-presence 4.8s ease-in-out infinite;")
    expect(styles).toContain("animation: desktop-loading-logo-sweep 3.2s cubic-bezier(0.18, 0, 0.2, 1) infinite;")
    expect(styles).toContain("fill: #f6c51d;")
    expect(styles).toContain("--desktop-loading-logo-mask: url(\"data:image/svg+xml")
    expect(styles).toContain("mask-image: var(--desktop-loading-logo-mask);")
    expect(styles).toContain("transform: translateX(520%) rotate(18deg);")
    expect(styles).not.toContain("@keyframes desktop-loading-logo-sweep-glow")
    expect(styles).not.toContain("@keyframes desktop-loading-logo-sweep-edge")
    expect(styles).not.toContain("mix-blend-mode: screen;")
    expect(styles).not.toContain("transform: translateX(980%) rotate(18deg);")
    expect(styles).not.toContain("mix-blend-mode: soft-light;")
    expect(styles).not.toContain("clip-path: polygon(")
    expect(styles).not.toContain("background-position:")
    expect(styles).not.toContain("@keyframes desktop-loading-logo-shine-beam")
    expect(styles).not.toContain("@keyframes desktop-loading-logo-pulse")
    expect(styles).not.toContain("scale(1.018)")
    expect(styles).not.toContain("linear-gradient(180deg")
    expect(styles).not.toContain("w-screen h-screen bg-background-base flex items-center justify-center")
  })

  test("desktop entries skip the second startup splash after the loading window", async () => {
    const html = await Bun.file(join(dir, "index.html")).text()
    const index = await Bun.file(join(dir, "index.tsx")).text()
    const login = await Bun.file(join(dir, "login.tsx")).text()

    expect(html).toContain('id="desktop-startup-cover"')
    expect(html).toContain('data-component="desktop-loading-root"')
    expect(html).toContain('desktop-startup-cover-logo-glyph')
    expect(index).toContain("const clearStartupCover = () => {")
    expect(index).toContain('document.getElementById("desktop-startup-cover")')
    expect(index).toContain('cover.dataset.state = "leaving"')
    expect(index).toContain('document.visibilityState !== "visible"')
    expect(index).toContain("fallback = setTimeout(leave, 250)")
    expect(index).toContain("skipStartupHealthGate")
    expect(login).toContain("skipStartupHealthGate")
    expect(index).not.toContain("disableHealthCheck")
    expect(login).not.toContain("disableHealthCheck")
  })

  test("account popover uses native desktop glass material", async () => {
    const styles = await Bun.file(join(dir, "styles.css")).text()

    expect(styles).toContain(".account-popover")
    expect(styles).toContain("rgba(255, 255, 255, 0.54)")
    expect(styles).toContain("blur(116px) saturate(1.75) brightness(1.07)")
    expect(styles).toContain(".account-popover::before")
    expect(styles).toContain("rgba(255, 255, 255, 0.64)")
    expect(styles).toContain('.account-popover [data-slot="popover-body"]')
    expect(styles).toContain(".account-popover-item:hover")
    expect(styles).toContain(".account-popover-subitem:focus-visible")
    expect(styles).toContain("blur(18px) saturate(1.45)")
  })

  test("wanlai-theme Windows Mica uses Codex elevated tokens without changing macOS glass", async () => {
    const styles = await Bun.file(join(dir, "styles.css")).text()
    const appCss = await Bun.file(join(root, "../app/src/index.css")).text()

    expect(styles).toContain(
      ':root[data-theme="wanlai-theme"][data-desktop-os="windows"][data-windows-backdrop="mica"]',
    )
    expect(styles).toContain(':root[data-theme="wanlai-theme"][data-desktop-os="windows"] .account-popover')
    expect(styles).toContain("var(--desktop-glass-tint)")
    expect(styles).toContain("var(--desktop-glass-elevated, var(--codex-elevated-primary))")
    expect(styles).toContain("var(--codex-elevated-secondary)")
    expect(styles).toContain("var(--codex-surface, var(--background-base))")
    expect(styles).toContain("blur(28px) saturate(1.75)")
    // macOS 侧栏保持原 blur，不被 wanlai token 规则改写
    expect(styles).not.toContain(':root[data-theme="wanlai-theme"][data-desktop-os="macos"]')
    expect(styles).toContain(':root[data-desktop-os="macos"] [data-component="app-shell-left-panel"]')
    expect(styles).toContain("blur(34px) saturate(1.85) brightness(1.06)")

    // 侧栏 chrome 层 transparent：透出系统 Mica（亮色偏亮蓝 / 深色冷色），勿叠中性灰 tint
    expect(appCss).toContain("--codex-surface-under: #141414")
    expect(appCss).toContain("--codex-editor-opaque: #282828")
    expect(appCss).toContain("--codex-elevated-primary: rgba(54, 54, 54, 0.96)")
    expect(appCss).toContain("--desktop-glass-tint: transparent")
    expect(appCss).not.toContain("color-mix(in srgb, var(--codex-editor-opaque) 70%, transparent)")
    expect(appCss).not.toContain("color-mix(in srgb, var(--codex-editor-opaque) 8%, transparent)")
  })

  test("renderer applies getWindowConfig.windowsBackdrop to data-windows-backdrop", async () => {
    // 与主进程 getWindowConfig 下发闭环：渲染端必须读该字段再挂 dataset，Mica CSS 才生效。
    const source = await Bun.file(join(dir, "index.tsx")).text()
    expect(source).toContain("getWindowConfig()")
    expect(source).toContain("config.windowsBackdrop")
    expect(source).toContain("dataset.windowsBackdrop")
  })

  test("windows main panel background fill matches statusbar color behind rounded corners", async () => {
    const styles = await Bun.file(join(dir, "styles.css")).text()

    expect(styles).toContain(':root[data-desktop-os="windows"]')
    expect(styles).toContain("--windows-window-corner-radius: 8px")
    expect(styles).toContain(':root[data-desktop-os="windows"] #root')
    expect(styles).toContain("border-radius: var(--windows-window-corner-radius)")
    expect(styles).toContain(':root[data-desktop-os="windows"][data-window-maximized="true"] #root')
    expect(styles).toContain(':root[data-desktop-os="windows"] [data-slot="main-bg-fill"]')
    expect(styles).toContain("var(--windows-statusbar-bg, var(--background-base))")
    expect(styles).toContain(':root[data-desktop-os="macos"] [data-slot="main-bg-fill"]')
  })

})

/**
 * Vite resolves `publicDir` relative to `root`, not the config file.
 * This test reads the actual values from electron.vite.config.ts to catch
 * regressions where the publicDir path no longer resolves correctly
 * after the renderer root is accounted for.
 */
describe("electron vite publicDir", () => {
  test("configured publicDir resolves to a directory with oc-theme-preload.js", async () => {
    const config = await Bun.file(join(root, "electron.vite.config.ts")).text()
    const pub = config.match(/publicDir:\s*["']([^"']+)["']/)
    const rendererRoot = config.match(/root:\s*["']([^"']+)["']/)
    expect(pub).not.toBeNull()
    expect(rendererRoot).not.toBeNull()
    const resolved = resolve(root, rendererRoot![1], pub![1])
    expect(existsSync(resolved)).toBe(true)
    expect(existsSync(join(resolved, "oc-theme-preload.js"))).toBe(true)
  })
})
