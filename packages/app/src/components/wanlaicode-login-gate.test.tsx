import { beforeEach, describe, expect, mock, test } from "bun:test"

let os: "macos" | "windows" | "linux" | undefined = "windows"

const t = (key: string | number) =>
  ({
    "login.wanlaicode.title": "欢迎使用 万来Code",
    "login.wanlaicode.subtitle": "与智能体一起构建的最佳方式",
    "login.wanlaicode.planBadge": "✓ 所有顶级模型均包含",
    "login.wanlaicode.continue": "使用 万来Code 继续",
    "login.wanlaicode.other": "使用其他方式登录",
    "login.wanlaicode.password": "使用账号密码登录",
    "login.wanlaicode.register": "注册",
    "login.proxy.button": "代理设置",
  } as Record<string | number, string>)[key] ?? String(key)

beforeEach(() => {
  os = "windows"
  document.body.innerHTML = ""
})

mock.module("@/context/global-sync", () => ({
  useGlobalSync: () => ({ data: { provider: { connected: [] } } }),
}))
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t }),
}))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: os ? "desktop" : "web", os }),
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined }),
}))
mock.module("@/components/dialog-connect-provider", () => ({
  DialogConnectProvider: () => null,
}))
mock.module("@/components/dialog-login-password", () => ({
  DialogLoginPassword: () => null,
}))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown }) => props.children,
}))
mock.module("@opencode-ai/ui/provider-icon", () => ({
  ProviderIcon: () => null,
}))
mock.module("@/components/settings-proxy", () => ({
  SettingsProxy: () => null,
}))
mock.module("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => props.children,
}))

describe("WanlaiCode login visual model", () => {
  test("uses localized copy on Windows while keeping Windows controls", async () => {
    const mod = await import("./wanlaicode-login-gate")
    const visual = mod.wanlaiCodeLoginVisual({ os: "windows", t })

    expect(visual.platform).toBe("windows")
    expect(visual.title).toBe("欢迎使用 万来Code")
    expect(visual.subtitle).toBe("与智能体一起构建的最佳方式")
    expect(visual.primary).toBe("使用 万来Code 继续")
    expect(visual.secondary).toBe("使用其他方式登录")
    expect(visual.password).toBe("使用账号密码登录")
    expect(visual.badge).toBe("✓ 所有顶级模型均包含")
    expect(visual.register).toBe("注册")
    expect(visual.windowControls).toBe("windows")
    expect(visual.fixedReferenceSize).toBe(false)
  })

  test("exposes proxy entry label in the visual model", async () => {
    const mod = await import("./wanlaicode-login-gate")
    const visual = mod.wanlaiCodeLoginVisual({ os: "windows", t })
    expect(visual.proxy).toBe("代理设置")
  })

  test("uses no window chrome when requested for reusable embeds", async () => {
    const mod = await import("./wanlaicode-login-gate")
    const visual = mod.wanlaiCodeLoginVisual({ os: "linux", chrome: "none", t })

    expect(visual.platform).toBe("web")
    expect(visual.windowControls).toBe("none")
    expect(visual.fixedReferenceSize).toBe(false)
  })
})

describe("WanlaiCode login view", () => {
  test("uses brand-aware Mark logo and a pill badge style matching the reference", async () => {
    const mod = await import("./wanlaicode-login-gate")
    const source = await Bun.file(import.meta.resolveSync("./wanlaicode-login-gate")).text()
    const visual = mod.wanlaiCodeLoginVisual({ os: "windows", t })

    expect(visual.windowControls).toBe("windows")
    expect(source).toContain('from "@opencode-ai/ui/logo"')
    expect(source).toContain("<Mark class=\"size-[52px]\"")
    expect(source).toContain("mt-[16px] inline-flex items-center gap-[5px]")
    expect(source).toContain("rounded-full border border-[#ebe9ff]")
    expect(source).toContain("bg-[#f7f5ff]")
    expect(source).toContain("px-[8px] py-[2px]")
    expect(source).toContain("text-[13px]")
    expect(source).toContain("text-[#4452ff]")
    expect(source).toContain("shadow-none")
  })

  test("adds a branded leading icon and tighter label row inside the primary button", async () => {
    const mod = await import("./wanlaicode-login-gate")
    const source = await Bun.file(import.meta.resolveSync("./wanlaicode-login-gate")).text()
    const visual = mod.wanlaiCodeLoginVisual({ os: "windows", t })

    expect(visual.primary).toBe("使用 万来Code 继续")
    expect(source).toContain("items-center justify-center gap-[10px]")
    expect(source).toContain('data-action="primary"')
    expect(source).toContain("h-[48px]")
  })

  test("renders the primary action as a stable black pill with white text", async () => {
    const mod = await import("./wanlaicode-login-gate")
    const source = await Bun.file(import.meta.resolveSync("./wanlaicode-login-gate")).text()
    const visual = mod.wanlaiCodeLoginVisual({ os: "windows", t })

    expect(visual.windowControls).toBe("windows")
    expect(source).toContain('data-slot="windows-controls"')
    expect(source).toContain("top-[12px]")
    expect(source).toContain("h-8 w-[50px]")
    expect(source).toContain("-translate-y-[52px]")
    expect(source).toContain("pt-[86px]")
    expect(source).toContain("mt-[30px] max-w-[320px]")
    expect(source).not.toContain("{props.visual.subtitle}")
    expect(source).toContain("text-[28px]")
    expect(source).toContain("mt-[34px] flex w-full max-w-[340px]")
    expect(source).toContain("gap-3")
    expect(source).toContain("h-[48px]")
    expect(source).toContain('data-action="primary"')
    expect(source).toContain('data-action="password"')
    expect(source).toContain("bg-[#000000]")
    expect(source).toContain("text-[#ffffff]")
    expect(source).toContain('aria-label={props.visual.primary}')
    expect(source).toContain("hover:bg-[#4f5054]")
    expect(source).not.toContain('viewBox="0 0 340 49"')
    expect(source).not.toContain('preserveAspectRatio="none"')
    expect(source).not.toContain('fill="#ffffff"')
    expect(source).not.toContain("对照实验")
    expect(source).not.toContain("普通文本：白底紫字")
    expect(source).not.toContain("SVG：黑底白字")
    expect(source).not.toContain("bg-[#191c1f]")
    expect(source).not.toContain("hover:bg-[#515359]")
    expect(source).toContain("border border-[#e5e5e5] bg-white")
    expect(source).toContain("shadow-[0_4px_12px_rgba(0,0,0,0.10)]")
    expect(source).toContain("hover:bg-[#f1f1f1]")
    expect(source).toContain("mt-[18px] text-[13px]")
    expect(source).toContain("underline underline-offset-4")
    expect(source).toContain("hover:text-[#000000]")
  })

  test("exposes reusable view and gate exports", async () => {
    const mod = await import("./wanlaicode-login-gate")

    expect(typeof mod.WanlaiCodeLoginView).toBe("function")
    expect(typeof mod.WanlaiCodeLoginGate).toBe("function")
    expect(mod.WanlaiCodeLoginPage).toBe(mod.WanlaiCodeLoginGate)
  })
})

describe("login gate status resilience", () => {
  test("status fetch failure does not throw and reports unreachable", async () => {
    const mod = await import("./wanlaicode-login-gate")

    const flags: boolean[] = []
    const data = await mod.loadLoginGateStatus(
      () => Promise.reject(new TypeError("Failed to fetch")),
      (unreachable) => flags.push(unreachable),
    )

    expect(data).toBeUndefined()
    expect(flags).toEqual([true])
  })

  test("recovers once a later refetch succeeds", async () => {
    const mod = await import("./wanlaicode-login-gate")

    let calls = 0
    const fetchStatus = () => {
      calls += 1
      if (calls === 1) return Promise.reject(new TypeError("Failed to fetch"))
      return Promise.resolve({ authenticated: true })
    }

    const flags: boolean[] = []
    const first = await mod.loadLoginGateStatus(fetchStatus, (unreachable) => flags.push(unreachable))
    const second = await mod.loadLoginGateStatus(fetchStatus, (unreachable) => flags.push(unreachable))

    expect(first).toBeUndefined()
    expect(second).toEqual({ authenticated: true })
    expect(flags).toEqual([true, false])
  })

  test("gate renders an unreachable banner with auto retry instead of crashing", async () => {
    const source = await Bun.file(import.meta.resolveSync("./wanlaicode-login-gate")).text()

    expect(source).toContain("createLoginGateStatus")
    expect(source).toContain('data-slot="sidecar-error"')
    expect(source).toContain("login.sidecar.unreachable")
    expect(source).toContain("login.sidecar.hint")
    expect(source).toContain("app.server.retrying")
    expect(source).toContain("setInterval")
  })
})
