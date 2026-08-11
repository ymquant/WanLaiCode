import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { JSXElement } from "solid-js"

const child = process.env.PROJECT_ROW_TITLE_DOM_CHILD === "1"
const layoutDir = Bun.fileURLToPath(new URL("./", import.meta.url))

if (!child) {
  describe("ProjectRow single title wiring", () => {
    test("projects and pinned sections both render through ProjectRow", () => {
      const projects = readFileSync(join(layoutDir, "projects.tsx"), "utf8")
      const pinned = readFileSync(join(layoutDir, "pinned.tsx"), "utf8")
      expect(projects).toContain('import { ProjectRow } from "./project-row"')
      expect(pinned).toContain('import { ProjectRow } from "./project-row"')
      expect(projects).toContain("<ProjectRow")
      expect(pinned).toContain("<ProjectRow")
    })

    test("ProjectRow list title uses ProjectRowTitle instead of dual-segment custom+basename", () => {
      const source = readFileSync(join(layoutDir, "project-row.tsx"), "utf8")
      expect(source).toContain('import { ProjectRowTitle } from "./project-row-title"')
      expect(source).toContain("<ProjectRowTitle project={props.project} />")
      // 旧双段实现会在列表标题区同时渲染 customName() 与 baseName()；单名接线不得恢复该模式。
      expect(source).not.toMatch(/Show when=\{customName\(\)\}[\s\S]*\{baseName\(\)\}/)
    })

    test(
      "ProjectRowTitle DOM shows exactly one title for custom and fallback names",
      async () => {
        const proc = Bun.spawn({
          cmd: [process.execPath, "test", "./src/pages/layout/codex-sidebar/project-row.test.ts"],
          cwd: Bun.fileURLToPath(new URL("../../../../", import.meta.url)),
          env: {
            ...process.env,
            PROJECT_ROW_TITLE_DOM_CHILD: "1",
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
        throw new Error(`ProjectRowTitle DOM child test failed:\n${stdout}\n${stderr}`)
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
    name: "project-row-title-solid-test",
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

  const cleanups: Array<() => void> = []
  afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

  const mountTitle = async (project: { name?: string; worktree: string }) => {
    const { ProjectRowTitle } = await import("./project-row-title")
    const host = document.createElement("div")
    document.body.append(host)
    cleanups.push(
      () => host.remove(),
      solidWeb.render(
        () =>
          solid.createComponent(ProjectRowTitle, {
            project,
          }) as JSXElement,
        host,
      ),
    )
    return host
  }

  describe("ProjectRowTitle rendered title", () => {
    test("with a custom name, only the custom name appears", async () => {
      const host = await mountTitle({ worktree: "/tmp/wanlai-demo", name: "My App" })
      const root = host.querySelector("[data-project-row-title]")
      const labels = root?.querySelectorAll(":scope > span") ?? []

      expect(root?.textContent).toBe("My App")
      expect(labels.length).toBe(1)
      expect(root?.textContent).not.toContain("wanlai-demo")
    })

    test("without a custom name, only the directory basename appears", async () => {
      const host = await mountTitle({ worktree: "/tmp/wanlai-demo" })
      const root = host.querySelector("[data-project-row-title]")
      const labels = root?.querySelectorAll(":scope > span") ?? []

      expect(root?.textContent).toBe("wanlai-demo")
      expect(labels.length).toBe(1)
    })
  })
}
