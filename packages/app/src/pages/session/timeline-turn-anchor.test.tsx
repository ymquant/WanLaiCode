import { afterEach, describe, expect, mock, test } from "bun:test"
import { timelineTurnAnchorMessageID, type TimelineTurn } from "./user-turns"

const child = process.env.TIMELINE_TURN_ANCHOR_DOM_CHILD === "1"

if (!child) {
  describe("TimelineTurnAnchor DOM", () => {
    test(
      "使用 Solid 客户端构建验证分页 steer 的真实 DOM 锚点",
      async () => {
        // Bun 默认把 Solid 解析到服务端构建；子进程沿用项目现有测试模式，显式加载客户端运行时与 JSX 转换器。
        const proc = Bun.spawn({
          cmd: [process.execPath, "test", "./src/pages/session/timeline-turn-anchor.test.tsx"],
          cwd: Bun.fileURLToPath(new URL("../../../", import.meta.url)),
          env: { ...process.env, TIMELINE_TURN_ANCHOR_DOM_CHILD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        if (exitCode === 0) return
        throw new Error(`时间线 DOM 子测试失败:\n${stdout}\n${stderr}`)
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
    name: "timeline-turn-anchor-solid-test",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const result = await transform(await Bun.file(args.path).text(), args.path)
        if (!result) return
        return { contents: result.code, loader: "tsx" }
      })
    },
  })

  const cleanups: Array<() => void> = []
  afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

  describe("TimelineTurnAnchor", () => {
    test("分页缺少根消息时把 steer 渲染成实际 DOM 锚点", async () => {
      const turn: TimelineTurn = {
        id: "msg_missing_root",
        rootMessageID: "msg_missing_root",
        orphan: false,
        members: [{ type: "user", messageID: "msg_steer", steering: true }],
        userMessageIDs: ["msg_missing_root", "msg_steer"],
        assistantMessageIDs: [],
      }
      const messageID = timelineTurnAnchorMessageID(turn, new Set(["msg_steer"]))
      if (!messageID) throw new Error("缺少分页回退锚点")
      const { TimelineTurnAnchor } = await import("./timeline-turn-anchor")
      const host = document.createElement("div")
      document.body.append(host)
      cleanups.push(
        () => host.remove(),
        solidWeb.render(
          () =>
            solid.createComponent(TimelineTurnAnchor, {
              messageID,
              turnID: turn.id,
              anchor: (id) => `m-${id}`,
              active: false,
              latest: true,
              children: "steer",
            }),
          host,
        ),
      )
      const row = host.firstElementChild

      // 断言直接落在生产组件生成的 DOM 上，missing root 不得出现在 id 或 data-message-id 中。
      expect(row?.id).toBe("m-msg_steer")
      expect(row?.getAttribute("data-message-id")).toBe("msg_steer")
      expect(row?.getAttribute("data-turn-id")).toBe("msg_missing_root")
      expect(host.querySelector("#m-msg_missing_root")).toBeNull()
    })
  })
}
