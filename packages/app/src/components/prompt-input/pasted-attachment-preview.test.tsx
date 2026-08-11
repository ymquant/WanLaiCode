import { afterEach, describe, expect, mock, test } from "bun:test"
import type { JSXElement } from "solid-js"

const child = process.env.PASTED_ATTACHMENT_PREVIEW_DOM_CHILD === "1"

if (!child) {
  describe("PastedAttachmentPreview interactions", () => {
    test(
      "locks dirty-close semantics through the rendered preview",
      async () => {
        const proc = Bun.spawn({
          cmd: [process.execPath, "test", "./src/components/prompt-input/pasted-attachment-preview.test.tsx"],
          cwd: Bun.fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            ...process.env,
            PASTED_ATTACHMENT_PREVIEW_DOM_CHILD: "1",
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
    name: "pasted-attachment-preview-solid-test",
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

  mock.module("@/context/language", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
  }))
  mock.module("@opencode-ai/ui/button", () => ({
    Button: (props: { children?: JSXElement; onClick?: () => void; disabled?: boolean }) =>
      solid.createComponent(solidWeb.Dynamic, {
        component: "button",
        type: "button",
        get disabled() {
          return props.disabled
        },
        get onClick() {
          return props.onClick
        },
        get children() {
          return props.children
        },
      }),
  }))
  mock.module("@opencode-ai/ui/icon-button", () => ({
    IconButton: (props: { "aria-label"?: string; onClick?: () => void; icon?: string }) =>
      solid.createComponent(solidWeb.Dynamic, {
        component: "button",
        type: "button",
        get "aria-label"() {
          return props["aria-label"]
        },
        get "data-component"() {
          return "icon-button"
        },
        get "data-icon"() {
          return props.icon
        },
        get onClick() {
          return props.onClick
        },
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

  const mountPreview = (input: {
    dirty: boolean
    onSave: () => Promise<boolean>
    onClose: () => void
  }) => {
    return import("./pasted-attachment-preview").then(({ PastedAttachmentPreview }) =>
      mount(() =>
        solid.createComponent(PastedAttachmentPreview, {
          path: "/repo/.wanlaicode/pasted-text/Alice.json",
          kind: "json",
          filename: "Alice.json",
          value: "{ok:true}",
          dirty: input.dirty,
          onInput: () => undefined,
          onSave: input.onSave,
          onClose: input.onClose,
          onOpenExternal: () => undefined,
        }),
      ),
    )
  }

  describe("PastedAttachmentPreview rendered interactions", () => {
    test("close button still closes after a failed dirty save", async () => {
      const calls: string[] = []
      const host = await mountPreview({
        dirty: true,
        onSave: async () => {
          calls.push("save")
          return false
        },
        onClose: () => {
          calls.push("close")
        },
      })

      const close = host.querySelector<HTMLButtonElement>(
        '[data-component="icon-button"][data-icon="close"], [aria-label="prompt.attachment.preview.close"]',
      )
      expect(close).toBeTruthy()
      close?.click()
      await Promise.resolve()
      await Promise.resolve()

      expect(calls).toEqual(["save", "close"])
    })

    test("Escape still closes after a failed dirty save", async () => {
      const calls: string[] = []
      await mountPreview({
        dirty: true,
        onSave: async () => {
          calls.push("save")
          return false
        },
        onClose: () => {
          calls.push("close")
        },
      })

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()

      expect(calls).toEqual(["save", "close"])
    })

    test("close button skips save when the draft is clean", async () => {
      const calls: string[] = []
      const host = await mountPreview({
        dirty: false,
        onSave: async () => {
          calls.push("save")
          return true
        },
        onClose: () => {
          calls.push("close")
        },
      })

      const close = host.querySelector<HTMLButtonElement>(
        '[data-component="icon-button"][data-icon="close"], [aria-label="prompt.attachment.preview.close"]',
      )
      expect(close).toBeTruthy()
      close?.click()
      await Promise.resolve()
      await Promise.resolve()

      expect(calls).toEqual(["close"])
    })
  })
}
