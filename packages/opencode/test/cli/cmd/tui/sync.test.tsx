/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider, useKV } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider, type EventSource } from "../../../../src/cli/cmd/tui/context/sdk"
import type { Message } from "@opencode-ai/sdk/v2"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { tmpdir } from "../../../fixture/fixture"

const worktree = "/tmp/opencode"
const directory = `${worktree}/packages/opencode`
type SourceEvent = Parameters<Parameters<EventSource["subscribe"]>[0]>[0]

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

function eventSource(): EventSource & { emit(event: SourceEvent): void } {
  let handler: Parameters<EventSource["subscribe"]>[0] | undefined
  return {
    subscribe: async (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
    // 测试通过同一事件入口驱动 store，覆盖真实 SSE 的追加、原位更新和删除顺序。
    emit(event: SourceEvent) {
      if (!handler) throw new Error("event source is not subscribed")
      handler(event)
    },
  }
}

function createFetch() {
  const session = [] as URL[]
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/session") session.push(url)

    switch (url.pathname) {
      case "/agent":
      case "/command":
      case "/experimental/workspace":
      case "/experimental/workspace/status":
      case "/formatter":
      case "/lsp":
        return json([])
      case "/config":
      case "/experimental/resource":
      case "/mcp":
      case "/provider/auth":
      case "/session/status":
        return json({})
      case "/config/providers":
        return json({ providers: {}, default: {} })
      case "/experimental/console":
        return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      case "/path":
        return json({ home: "", state: "", config: "", worktree, directory })
      case "/project/current":
        return json({ id: "proj_test" })
      case "/provider":
        return json({ all: [], default: {}, connected: [] })
      case "/session":
        return json([])
      case "/vcs":
        return json({ branch: "main" })
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  return { fetch, session }
}

async function mount() {
  const calls = createFetch()
  const events = eventSource()
  let sync!: ReturnType<typeof useSync>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events}>
            <ProjectProvider>
              <SyncProvider>
                <Probe
                  onReady={(ctx) => {
                    sync = ctx.sync
                    kv = ctx.kv
                    done()
                  }}
                />
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, events, kv, sync, session: calls.session }
}

function Probe(props: { onReady: (ctx: { kv: ReturnType<typeof useKV>; sync: ReturnType<typeof useSync> }) => void }) {
  const kv = useKV()
  const sync = useSync()

  onMount(() => {
    props.onReady({ kv, sync })
  })

  return <box />
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("message events preserve first-seen order", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, events, sync } = await mount()
    const sessionID = "session-order"
    const message = (id: string, created: number): Message => ({
      id,
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    })

    try {
      const emit = (payload: SourceEvent["payload"]) => events.emit({ directory, payload })

      emit({
        id: "event-z",
        type: "message.updated",
        properties: { sessionID, info: message("message-z", 1) },
      })
      emit({
        id: "event-a",
        type: "message.updated",
        properties: { sessionID, info: message("message-a", 2) },
      })
      emit({
        id: "event-m",
        type: "message.updated",
        properties: { sessionID, info: message("message-m", 3) },
      })
      await wait(() => sync.data.message[sessionID]?.length === 3)
      expect(sync.data.message[sessionID].map((item) => item.id)).toEqual(["message-z", "message-a", "message-m"])

      emit({
        id: "event-a-update",
        type: "message.updated",
        properties: { sessionID, info: message("message-a", 20) },
      })
      await wait(() => sync.data.message[sessionID][1]?.time.created === 20)
      expect(sync.data.message[sessionID].map((item) => item.id)).toEqual(["message-z", "message-a", "message-m"])

      emit({
        id: "event-a-remove",
        type: "message.removed",
        properties: { sessionID, messageID: "message-a" },
      })
      await wait(() => sync.data.message[sessionID]?.length === 2)
      expect(sync.data.message[sessionID].map((item) => item.id)).toEqual(["message-z", "message-m"])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
