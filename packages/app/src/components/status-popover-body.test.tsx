import { afterEach, describe, expect, mock, test } from "bun:test"
import type { JSXElement } from "solid-js"
import { statusPanelClassList, statusPanelStyle } from "./status-panel"

const child = process.env.STATUS_PANEL_DOM_CHILD === "1"

if (!child) {
  describe("StatusPanel presentation", () => {
    test("keeps the fixed popover surface by default", () => {
      const classes = statusPanelClassList()

      expect(classes["w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]"]).toBe(true)
      expect(classes["w-full"]).toBe(false)
    })

    test("fills a dialog without nesting popover chrome", () => {
      const classes = statusPanelClassList("dialog")

      expect(classes["w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]"]).toBe(false)
      expect(classes["w-full"]).toBe(true)
    })

    test("flattens dialog status content into a single surface", () => {
      const styles = statusPanelStyle("dialog")

      expect(styles.tabs).toBe("tabs bg-transparent overflow-hidden")
      expect(styles.tabList).toBe("bg-transparent border-b-0 px-4 pt-2 pb-0 gap-0 h-10 [&::after]:!hidden")
      expect(styles.tab).toBe("text-12-regular flex-1 min-w-0 justify-center")
      expect(styles.tabButton).toBe("w-full justify-center")
      expect(styles.content).toBe("flex flex-col px-4 pb-2")
      expect(styles.surface).toBe("flex flex-col p-3 min-h-14")
      expect(styles.action).toBe("secondary")
    })

    test("keeps the popover status surface and management action", () => {
      const styles = statusPanelStyle("popover")

      expect(styles.tabs).toBe("tabs bg-background-strong overflow-hidden")
      expect(styles.tabList).toBe("bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10")
      expect(styles.tab).toBe("text-12-regular")
      expect(styles.tabButton).toBeUndefined()
      expect(styles.content).toBe("flex flex-col px-2 pb-2")
      expect(styles.surface).toBe("flex flex-col p-3 bg-background-base rounded-sm min-h-14")
      expect(styles.action).toBe("secondary")
    })

    test(
      "applies presentation styles through the rendered components",
      async () => {
        const proc = Bun.spawn({
          cmd: [process.execPath, "test", "./src/components/status-popover-body.test.tsx"],
          cwd: Bun.fileURLToPath(new URL("../../", import.meta.url)),
          env: {
            ...process.env,
            STATUS_PANEL_DOM_CHILD: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])

        if (exitCode === 0) return
        throw new Error(`Rendered component test failed:\n${stdout}\n${stderr}`)
      },
      15_000,
    )
  })
}

if (child) {
  const solid = (await import(import.meta.resolve("solid-js/dist/solid.js"))) as typeof import("solid-js")
  mock.module("solid-js", () => solid)
  const solidWeb = (await import(import.meta.resolve("solid-js/web/dist/web.js"))) as typeof import("solid-js/web")
  mock.module("solid-js/web", () => solidWeb)
  const transform = (await import("vite-plugin-solid")).default().transform as (
    source: string,
    id: string,
  ) => Promise<{ code: string } | null>

  Bun.plugin({
    name: "status-panel-solid-test",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const result = await transform(await Bun.file(args.path).text(), args.path)
        if (!result) return
        return {
          contents: result.code,
          loader: "tsx",
        }
      })
    },
  })

  const connection = {
    type: "http" as const,
    http: { url: "http://localhost:4096" },
  }

  mock.module("@/components/server/server-row", () => ({
    ServerHealthIndicator: () => null,
    ServerRow: (props: { children?: JSXElement }) => props.children,
  }))
  mock.module("@/context/global-sync", () => ({
    loadMcpQuery: () => ({ queryKey: ["mcp"] }),
    mcpQueryKey: () => ["mcp"],
  }))
  mock.module("@/context/language", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ getDefaultServer: () => undefined }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => ({ client: {} }),
  }))
  mock.module("@/context/server", () => ({
    normalizeServerUrl: (url: string) => url,
    ServerConnection: {
      key: (value: typeof connection) => value.http.url,
      Key: { make: (value: string) => value },
    },
    useServer: () => ({
      current: connection,
      list: [connection],
      key: connection.http.url,
      setActive: () => undefined,
    }),
  }))
  mock.module("@/context/sync", () => ({
    useSync: () => ({
      directory: "/tmp/status-panel-test",
      data: {
        config: { plugin: [] },
        lsp: [],
        mcp: {},
      },
    }),
  }))
  mock.module("@/utils/server-health", () => ({
    useCheckServerHealth: () => () => Promise.resolve({ healthy: true }),
  }))
  mock.module("@opencode-ai/ui/context/dialog", () => ({
    useDialog: () => ({ show: () => undefined }),
  }))
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
  }))
  mock.module("@tanstack/solid-query", () => ({
    useMutation: () => ({
      isPending: false,
      mutate: () => undefined,
      variables: undefined,
    }),
    useQueryClient: () => ({
      fetchQuery: () => Promise.resolve(),
      refetchQueries: () => Promise.resolve(),
    }),
  }))

  const cleanups: Array<() => void> = []

  const mount = (view: () => JSXElement) => {
    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(() => {
      host.remove()
    }, solidWeb.render(view, host))
    return host
  }

  afterEach(() => {
    cleanups.splice(0).reverse().forEach((cleanup) => cleanup())
  })

  describe("StatusPanel rendered presentation", () => {
    test("applies default popover chrome to the rendered panel", async () => {
      const { StatusPanel } = await import("./status-popover-body")
      const host = mount(() => solid.createComponent(StatusPanel, { children: "status" }))
      const panel = host.querySelector('[data-component="status-panel"]')

      expect(panel?.classList.contains("w-[360px]")).toBe(true)
      expect(panel?.classList.contains("rounded-xl")).toBe(true)
      expect(panel?.classList.contains("w-full")).toBe(false)
      expect(panel?.getAttribute("data-presentation")).toBe("popover")
    })

    test("applies dialog width without popover chrome to the rendered panel", async () => {
      const { StatusPanel } = await import("./status-popover-body")
      const host = mount(() => solid.createComponent(StatusPanel, { presentation: "dialog", children: "status" }))
      const panel = host.querySelector('[data-component="status-panel"]')

      expect(panel?.classList.contains("w-full")).toBe(true)
      expect(panel?.classList.contains("w-[360px]")).toBe(false)
      expect(panel?.classList.contains("rounded-xl")).toBe(false)
      expect(panel?.getAttribute("data-presentation")).toBe("dialog")
    })
  })

  describe("StatusPopoverBody rendered presentation", () => {
    test("renders dialog tabs and content as a single surface", async () => {
      const { StatusPopoverBody } = await import("./status-popover-body")
      const host = mount(() =>
        solid.createComponent(StatusPopoverBody, {
          shown: () => false,
          presentation: "dialog",
        }),
      )
      const tabs = host.querySelector('[data-component="tabs"]')
      const tabList = host.querySelector('[data-slot="tabs-list"]')
      const tabsTrigger = Array.from(host.querySelectorAll('[data-slot="tabs-trigger-wrapper"]'))
      const tabsButton = Array.from(host.querySelectorAll('[data-slot="tabs-trigger"]'))
      const surface = host.querySelector('[data-slot="tabs-content"] > div > div')
      const action = host.querySelector('[data-component="button"]')

      expect(tabs?.classList.contains("bg-transparent")).toBe(true)
      expect(tabs?.classList.contains("bg-background-strong")).toBe(false)
      expect(tabs?.classList.contains("rounded-xl")).toBe(false)
      expect(tabList?.classList.contains("gap-0")).toBe(true)
      expect(tabList?.classList.contains("[&::after]:!hidden")).toBe(true)
      expect(tabsTrigger).toHaveLength(4)
      expect(tabsTrigger.every((tab) => tab.classList.contains("flex-1"))).toBe(true)
      expect(tabsTrigger.every((tab) => tab.classList.contains("min-w-0"))).toBe(true)
      expect(tabsTrigger.every((tab) => tab.classList.contains("justify-center"))).toBe(true)
      expect(tabsButton).toHaveLength(4)
      expect(tabsButton.every((tab) => tab.classList.contains("w-full"))).toBe(true)
      expect(tabsButton.every((tab) => tab.classList.contains("justify-center"))).toBe(true)
      expect(surface?.className).toBe("flex flex-col p-3 min-h-14")
      expect(surface?.parentElement?.className).toBe("flex flex-col px-4 pb-2")
      expect(action?.getAttribute("data-variant")).toBe("secondary")
    })

    test("renders popover tabs, nested surface, and secondary action", async () => {
      const { StatusPopoverBody } = await import("./status-popover-body")
      const host = mount(() =>
        solid.createComponent(StatusPopoverBody, {
          shown: () => false,
        }),
      )
      const tabs = host.querySelector('[data-component="tabs"]')
      const surface = host.querySelector('[data-slot="tabs-content"] > div > div')
      const action = host.querySelector('[data-component="button"]')

      expect(tabs?.classList.contains("bg-background-strong")).toBe(true)
      expect(tabs?.classList.contains("rounded-xl")).toBe(true)
      expect(surface?.className).toBe("flex flex-col p-3 bg-background-base rounded-sm min-h-14")
      expect(surface?.parentElement?.className).toBe("flex flex-col px-2 pb-2")
      expect(action?.getAttribute("data-variant")).toBe("secondary")
    })
  })
}
