import { describe, expect, mock, test } from "bun:test"
import type { ModelKey, PendingSessionModel } from "./local"

// local.tsx 只使用 useParams；测试替换 Router 客户端入口，避免默认 Bun 条件误加载 Solid SSR 保护分支。
// mock.module 是 process 级污染,漏掉的导出会让后续文件(prompt-input/submit.test.ts)拿不到 useNavigate,
// 所以这里必须把用得到的 router 导出补齐,哪怕 local.tsx 本身不需要。
mock.module("@solidjs/router", () => ({ useParams: () => ({}), useNavigate: () => () => undefined }))

const { enqueueSessionModelTask, resolvePendingModelSync, retainDeferredServerModel } = await import("./local")

const model = (modelID: string) => ({ providerID: "openai", modelID }) satisfies ModelKey

describe("resolvePendingModelSync", () => {
  const pending = {
    sessionID: "session-a",
    directory: "/tmp/project",
    model: model("gpt-5"),
    version: 1,
  } satisfies PendingSessionModel

  test("another session's server model is never blocked", () => {
    // A 的 PATCH 尚未结束时，B 的 session.updated 必须立即进入 B 的本地选择。
    expect(resolvePendingModelSync(pending, "session-b", model("gpt-4.1"))).toBe("apply")
  })

  test("a stale server event for the pending session is deferred", () => {
    // 同会话的旧模型事件暂缓应用，避免菜单在 PATCH 确认前回弹。
    expect(resolvePendingModelSync(pending, "session-a", model("gpt-4.1"))).toBe("defer")
  })

  test("the requested server model confirms the pending update", () => {
    // provider、model 和 variant 全部匹配后确认并释放 pending。
    expect(resolvePendingModelSync(pending, "session-a", model("gpt-5"))).toBe("confirm")
  })

  test("a newer server model becomes the rollback baseline while a patch is pending", () => {
    const baselines = new Map<string, ModelKey | undefined>([["project/session-a", model("gpt-4.1")]])
    const serverModel = model("gpt-5.2")
    const action = resolvePendingModelSync(pending, "session-a", serverModel)

    // 手机在桌面 PATCH 期间写入的新模型必须覆盖旧基线，桌面失败后才能恢复服务端权威值。
    retainDeferredServerModel(baselines, "project/session-a", action, serverModel)

    expect(action).toBe("defer")
    expect(baselines.get("project/session-a")).toEqual(serverModel)
  })

  test("a matching confirmation does not replace the persisted rollback baseline", () => {
    const baseline = model("gpt-4.1")
    const baselines = new Map<string, ModelKey | undefined>([["project/session-a", baseline]])
    const action = resolvePendingModelSync(pending, "session-a", pending.model)

    // 匹配确认由 PATCH 成功回包推进基线；事件投影不能提前覆盖最近一次已持久化值。
    retainDeferredServerModel(baselines, "project/session-a", action, pending.model)

    expect(action).toBe("confirm")
    expect(baselines.get("project/session-a")).toEqual(baseline)
  })
})

describe("enqueueSessionModelTask", () => {
  test("serializes updates for one session while another session remains independent", async () => {
    const queues = new Map<string, Promise<void>>()
    const calls: string[] = []
    let releaseFirst: () => void = () => undefined
    const firstDelay = new Promise<void>((resolve) => (releaseFirst = resolve))
    const first = enqueueSessionModelTask(queues, "project/session-a", async () => {
      calls.push("a:first")
      await firstDelay
      return "first"
    })
    const second = enqueueSessionModelTask(queues, "project/session-a", async () => {
      calls.push("a:second")
      return "second"
    })
    const other = enqueueSessionModelTask(queues, "project/session-b", async () => {
      calls.push("b:first")
      return "other"
    })

    await Promise.resolve()
    // A 的第二次 PATCH 尚未启动，但 B 不应被 A 的慢请求阻塞。
    expect(calls).toEqual(["a:first", "b:first"])
    releaseFirst()
    expect(await Promise.all([first, second, other])).toEqual(["first", "second", "other"])
    expect(calls).toEqual(["a:first", "b:first", "a:second"])
  })

  test("a failed earlier update does not poison the next update", async () => {
    const queues = new Map<string, Promise<void>>()
    const calls: string[] = []
    const first = enqueueSessionModelTask(queues, "project/session-a", async () => {
      calls.push("first")
      throw new Error("first failed")
    })
    const second = enqueueSessionModelTask(queues, "project/session-a", async () => {
      calls.push("second")
      return "saved"
    })

    await expect(first).rejects.toThrow("first failed")
    expect(await second).toBe("saved")
    expect(calls).toEqual(["first", "second"])
  })
})
