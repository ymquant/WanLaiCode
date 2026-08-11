import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  setArchived(input: z.output<typeof SessionNs.SetArchivedInput.zod>) {
    return run(SessionNs.Service.use((svc) => svc.setArchived(input)))
  },
  get(sessionID: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.get(sessionID)))
  },
}

describe("session.listGlobal", () => {
  test("lists sessions across projects with project metadata", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const firstSession = await WithInstance.provide({
      directory: first.path,
      fn: async () => svc.create({ title: "first-session" }),
    })
    const secondSession = await WithInstance.provide({
      directory: second.path,
      fn: async () => svc.create({ title: "second-session" }),
    })

    const sessions = [...svc.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).toContain(firstSession.id)
    expect(ids).toContain(secondSession.id)

    const firstProject = Project.get(firstSession.projectID)
    const secondProject = Project.get(secondSession.projectID)

    const firstItem = sessions.find((session) => session.id === firstSession.id)
    const secondItem = sessions.find((session) => session.id === secondSession.id)

    expect(firstItem?.project?.id).toBe(firstProject?.id)
    expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
    expect(secondItem?.project?.id).toBe(secondProject?.id)
    expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
  })

  test("excludes archived sessions by default", async () => {
    await using tmp = await tmpdir({ git: true })

    const archived = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "archived-session" }),
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.setArchived({ sessionID: archived.id, time: Date.now() }),
    })

    const sessions = [...svc.listGlobal({ limit: 200 })]
    const ids = sessions.map((session) => session.id)

    expect(ids).not.toContain(archived.id)

    const allSessions = [...svc.listGlobal({ limit: 200, archived: true })]
    const allIds = allSessions.map((session) => session.id)

    expect(allIds).toContain(archived.id)
  })

  test("archived:true returns only archived sessions", async () => {
    await using tmp = await tmpdir({ git: true })

    const active = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "active-session" }),
    })
    const archived = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "archived-session" }),
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.setArchived({ sessionID: archived.id, time: Date.now() }),
    })

    const sessions = [...svc.listGlobal({ limit: 200, archived: true })]
    const ids = sessions.map((session) => session.id)

    expect(ids).toContain(archived.id)
    expect(ids).not.toContain(active.id)
  })

  test("supports cursor pagination", async () => {
    await using tmp = await tmpdir({ git: true })

    const first = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "page-one" }),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "page-two" }),
    })

    const page = [...svc.listGlobal({ directory: tmp.path, limit: 1 })]
    expect(page.length).toBe(1)
    expect(page[0].id).toBe(second.id)

    const next = [...svc.listGlobal({ directory: tmp.path, limit: 10, cursor: page[0].time.updated })]
    const ids = next.map((session) => session.id)

    expect(ids).toContain(first.id)
    expect(ids).not.toContain(second.id)
  })

  test("search treats % and _ as literals", async () => {
    await using tmp = await tmpdir({ git: true })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const literal = await svc.create({ title: "100% done" })
        await svc.create({ title: "other session" })

        const matches = [...svc.listGlobal({ directory: tmp.path, search: "100%", limit: 20 })]
        const ids = matches.map((session) => session.id)

        expect(ids).toContain(literal.id)
        expect(ids.length).toBe(1)
      },
    })
  })

  test("archived list cursor includes id for same archived timestamp", async () => {
    await using tmp = await tmpdir({ git: true })

    const sharedTime = Date.now()
    const first = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "archived-a" }),
    })
    const second = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => svc.create({ title: "archived-b" }),
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.setArchived({ sessionID: first.id, time: sharedTime })
        await svc.setArchived({ sessionID: second.id, time: sharedTime })
      },
    })

    const page = [...svc.listGlobal({ directory: tmp.path, limit: 1, archived: true })]
    expect(page.length).toBe(1)

    const cursor = SessionNs.formatGlobalListCursor({
      archived: true,
      time: page[0].time.archived ?? page[0].time.updated,
      id: page[0].id,
    })
    const next = [...svc.listGlobal({ directory: tmp.path, limit: 10, archived: true, cursor })]
    const ids = next.map((session) => session.id)

    expect(ids.length).toBe(1)
    expect(ids).not.toContain(page[0].id)
    expect(ids[0] === first.id || ids[0] === second.id).toBe(true)
  })

  test("search matches project name in global archived list", async () => {
    await using tmp = await tmpdir({ git: true })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const project = Project.get((await svc.create({ title: "unrelated title" })).projectID)
        const session = await svc.create({ title: "始终使用简体中文" })
        await svc.setArchived({ sessionID: session.id, time: Date.now() })

        const projectName = project?.name?.trim() || tmp.path.split(/[/\\]/).pop() || "project"
        const matches = [...svc.listGlobal({ search: projectName, limit: 20, archived: true })]
        const ids = matches.map((item) => item.id)

        expect(ids).toContain(session.id)
      },
    })
  })

  test("archive keeps updated time and unarchive bumps updated", async () => {
    await using tmp = await tmpdir({ git: true })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "time-session" })
        const before = await svc.get(session.id)

        await svc.setArchived({ sessionID: session.id, time: Date.now() })
        const archived = await svc.get(session.id)
        expect(archived.time.updated).toBe(before.time.updated)
        expect(archived.time.archived).toBeDefined()

        const beforeUnarchive = Date.now()
        await svc.setArchived({ sessionID: session.id })
        const restored = await svc.get(session.id)
        expect(restored.time.archived).toBeUndefined()
        expect(restored.time.updated).toBeGreaterThanOrEqual(beforeUnarchive)
      },
    })
  })
})
