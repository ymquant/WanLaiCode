import { afterEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { PermissionID } from "../../src/permission/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { WithInstance } from "../../src/project/with-instance"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@/storage/db"
import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { SessionMessage } from "../../src/v2/session-message"
import { Modelv2 } from "../../src/v2/model"
import * as DateTime from "effect/DateTime"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

void Log.init({ print: false })

const original = Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI
const originalWorkspaces = Flag.WANLAICODE_EXPERIMENTAL_WORKSPACES

function app(experimental = true) {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(directory: string, input?: Session.CreateInput) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () => runSession(Session.Service.use((svc) => svc.create(input))),
      }),
  )
}

function createTextMessage(directory: string, sessionID: SessionIDType, text: string) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () =>
          runSession(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const info = yield* svc.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID,
                agent: "build",
                model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
                time: { created: Date.now() },
              })
              const part = yield* svc.updatePart({
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text,
              })
              return { info, part }
            }),
          ),
      }),
  )
}

function addMessageSummary(
  directory: string,
  info: Extract<MessageV2.Info, { role: "user" }>,
  count: number,
  patchPrefix: string,
) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () =>
          runSession(
            Session.Service.use((svc) =>
              svc.updateMessage({
                ...info,
                summary: {
                  diffs: Array.from({ length: count }, (_, index) => ({
                    file: `src/file-${index}.ts`,
                    patch: `${patchPrefix}-${index}`,
                    additions: 1,
                    deletions: 0,
                  })),
                },
              }),
            ),
          ),
      }),
  )
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.gen(function* () {
    registerAdapter(input.projectID, input.type, localAdapter(input.directory))
    return yield* Workspace.Service.use((svc) =>
      svc.create({
        type: input.type,
        branch: null,
        extra: null,
        projectID: input.projectID,
      }),
    ).pipe(Effect.provide(Workspace.defaultLayer))
  })

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => app().request(path, init))
}

function requestWithBackend(experimental: boolean, path: string, init?: RequestInit) {
  return Effect.promise(async () => app(experimental).request(path, init))
}

function json<T>(response: Response) {
  return Effect.promise(async () => {
    if (response.status !== 200) throw new Error(await response.text())
    return (await response.json()) as T
  })
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

function withTmp<A, E, R>(
  options: Parameters<typeof tmpdir>[0],
  fn: (tmp: Awaited<ReturnType<typeof tmpdir>>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(fn))
}

afterEach(async () => {
  Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI = original
  Flag.WANLAICODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.live(
    "returns declared not found errors for read routes",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const session = yield* createSession(tmp.path, { title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    ),
  )

  it.live(
    "serves read routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const parent = yield* createSession(tmp.path, { title: "parent" })
        const child = yield* createSession(tmp.path, { title: "child", parentID: parent.id })
        const message = yield* createTextMessage(tmp.path, parent.id, "hello")
        yield* createTextMessage(tmp.path, parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<MessageV2.WithParts[]>(messages)
        const nextCursor = messages.headers.get("x-next-cursor")
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<MessageV2.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* Effect.promise(() =>
          WithInstance.provide({
            directory: tmp.path,
            fn: async () => {
              const message = new SessionMessage.Assistant({
                id: SessionMessage.ID.create(),
                type: "assistant",
                agent: "build",
                model: {
                  id: Modelv2.ID.make("model"),
                  providerID: Modelv2.ProviderID.make("provider"),
                  variant: Modelv2.VariantID.make("default"),
                },
                time: { created: DateTime.makeUnsafe(1) },
                content: [],
              })
              Database.use((db) =>
                db
                  .insert(SessionMessageTable)
                  .values([
                    {
                      id: message.id,
                      session_id: parent.id,
                      type: message.type,
                      time_created: 1,
                      data: {
                        time: { created: 1 },
                        agent: message.agent,
                        model: message.model,
                        content: message.content,
                      } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
                    },
                  ])
                  .run(),
              )
            },
          }),
        )

        expect(
          (yield* requestJson<{ items: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, { headers }))
            .items,
        ).toMatchObject([{ type: "assistant" }])
      }),
    ),
  )

  it.live(
    "serves lifecycle mutation routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false, share: "disabled" } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    ),
  )

  it.live(
    "returns 400 for malformed abort turn ids on both HTTP backends",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const session = yield* createSession(tmp.path, { title: "invalid abort turn" })
        const path = `${pathFor(SessionPaths.abort, { sessionID: session.id })}?turnID=invalid`

        // Effect HttpApi 与 legacy Hono 必须共享同一查询错误契约，非法回合 ID 不能泄漏成 500。
        for (const experimental of [true, false]) {
          const response = yield* requestWithBackend(experimental, path, {
            method: "POST",
            headers: { "x-opencode-directory": tmp.path },
          })
          expect(response.status).toBe(400)
        }
      }),
    ),
  )

  it.live(
    "persists selected workspace id when creating a session",
    withTmp({ git: true, config: { formatter: false, lsp: false, share: "disabled" } }, (tmp) =>
      Effect.gen(function* () {
        Flag.WANLAICODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(tmp.path).pipe(Effect.provide(Project.defaultLayer))
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(tmp.path, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(
          yield* Effect.sync(() =>
            Database.use((db) =>
              db
                .select({ workspaceID: SessionTable.workspace_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, created.id))
                .get(),
            ),
          ),
        ).toEqual({ workspaceID: workspace.id })
      }),
    ),
  )

  it.live(
    "clears archived timestamp when archived is null",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const session = yield* createSession(tmp.path, { title: "archived" })
        yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: Date.now() } }),
        })

        const archived = yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers,
        })
        expect(archived.time.archived).toBeTypeOf("number")

        const restored = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: null } }),
        })
        expect(restored.time.archived).toBeUndefined()
      }),
    ),
  )

  it.live(
    "matches legacy archived timestamp validation",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const legacy = yield* createSession(tmp.path, { title: "legacy" })
        const effect = yield* createSession(tmp.path, { title: "effect" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const legacyResponse = yield* requestWithBackend(
          false,
          pathFor(SessionPaths.update, { sessionID: legacy.id }),
          {
            method: "PATCH",
            headers,
            body,
          },
        )
        expect(legacyResponse.status).toBe(200)
        expect((yield* json<Session.Info>(legacyResponse)).time.archived).toBe(-1)

        const effectResponse = yield* requestWithBackend(true, pathFor(SessionPaths.update, { sessionID: effect.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(effectResponse.status).toBe(legacyResponse.status)
        expect((yield* json<Session.Info>(effectResponse)).time.archived).toBe(-1)
      }),
    ),
  )

  it.live(
    "matches legacy inactive steer responses",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const session = yield* createSession(tmp.path, { title: "inactive steer" })
        const targetTurnID = MessageID.ascending()
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const body = JSON.stringify({
          messageID: MessageID.ascending(),
          targetTurnID,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "late guidance" }],
        })
        // 空闲会话没有可绑定回合；两套路由都必须在落库前返回同一份可恢复 409 契约。
        const legacy = yield* requestWithBackend(false, pathFor(SessionPaths.steer, { sessionID: session.id }), {
          method: "POST",
          headers,
          body,
        })
        const httpapi = yield* requestWithBackend(true, pathFor(SessionPaths.steer, { sessionID: session.id }), {
          method: "POST",
          headers,
          body,
        })

        expect(httpapi.status).toBe(409)
        expect(legacy.status).toBe(httpapi.status)
        const legacyBody = yield* responseJson(legacy)
        const httpapiBody = yield* responseJson(httpapi)
        expect(legacyBody).toEqual(httpapiBody)
        expect(httpapiBody).toEqual({
          name: "SteerTurnInactiveError",
          data: {
            message: `Expected active turn ${targetTurnID}, but the session is idle`,
            sessionID: session.id,
            expectedTurnID: targetTurnID,
          },
        })
      }),
    ),
  )

  it.live(
    "matches legacy project-scoped path and directory precedence",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const currentDir = path.join(tmp.path, "packages", "wanlaicode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const pathSession = yield* createSession(currentDir)
        const pathlessSession = yield* createSession(currentDir)
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, pathlessSession.id)).run(),
          ),
        )

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/wanlaicode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": tmp.path }
        const legacy = (yield* json<Session.Info[]>(
          yield* requestWithBackend(false, `${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)
        const effect = (yield* json<Session.Info[]>(
          yield* requestWithBackend(true, `${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(legacy).toContain(pathSession.id)
        expect(legacy).not.toContain(pathlessSession.id)
        expect(effect).toEqual(legacy)
      }),
    ),
  )

  it.live(
    "matches legacy paginated message link headers",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const session = yield* createSession(tmp.path, { title: "messages" })
        yield* createTextMessage(tmp.path, session.id, "first")
        yield* createTextMessage(tmp.path, session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const legacy = yield* requestWithBackend(false, route, { headers })
        const effect = yield* requestWithBackend(true, route, { headers })

        expect(effect.headers.get("x-next-cursor")).toBe(legacy.headers.get("x-next-cursor"))
        expect(effect.headers.get("link")).toBe(legacy.headers.get("link"))
        expect(effect.headers.get("access-control-expose-headers")).toBe(
          legacy.headers.get("access-control-expose-headers"),
        )
      }),
    ),
  )

  it.live(
    "serves message mutation routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const session = yield* createSession(tmp.path, { title: "messages" })
        const first = yield* createTextMessage(tmp.path, session.id, "first")
        const second = yield* createTextMessage(tmp.path, session.id, "second")

        const updated = yield* requestJson<MessageV2.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live(
    "serves remaining non-LLM session mutation routes through Hono bridge",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
        const session = yield* createSession(tmp.path, { title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.permissions, {
              sessionID: session.id,
              permissionID: String(PermissionID.ascending()),
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ response: "once" }),
            },
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live(
    "session goal set / get / clear round-trips",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const client = createOpencodeClient({
          baseUrl: "http://localhost",
          fetch: ((req: Request) => app().request(req.url, req)) as unknown as typeof fetch,
          directory: tmp.path,
        })
        const session = yield* createSession(tmp.path)
        const sessionID = session.id

        const set = yield* Effect.promise(() =>
          client.session.setGoal({ sessionID, objective: "ship goal mode" }, { throwOnError: true }),
        )
        expect(set.data.objective).toBe("ship goal mode")
        expect(set.data.status).toBe("active")

        const got = yield* Effect.promise(() => client.session.getGoal({ sessionID }, { throwOnError: true }))
        expect(got.data!.objective).toBe("ship goal mode")

        // 用户面端点只允许暂停/恢复
        const statusUpdate = yield* Effect.promise(() =>
          client.session.setGoal({ sessionID, status: "paused" }, { throwOnError: true }),
        )
        expect(statusUpdate.data.status).toBe("paused")

        // 模型专属（complete/blocked）与系统专属（usageLimited/budgetLimited）不允许从 HTTP 写入
        const forbidden = yield* Effect.promise(() =>
          client.session.setGoal({ sessionID, status: "complete" as never }, { throwOnError: true }).then(
            () => "accepted",
            () => "rejected",
          ),
        )
        expect(forbidden).toBe("rejected")

        const cleared = yield* Effect.promise(() => client.session.clearGoal({ sessionID }, { throwOnError: true }))
        expect(cleared.data).toBe(true)

        const empty = yield* Effect.promise(() => client.session.getGoal({ sessionID }))
        expect(empty.data).toBeNull()
      }),
    ),
  )

  it.live(
    "legacy hono backend bridges session goal routes",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const client = createOpencodeClient({
          baseUrl: "http://localhost",
          fetch: ((req: Request) => app(false).request(req.url, req)) as unknown as typeof fetch,
          directory: tmp.path,
        })
        const session = yield* createSession(tmp.path)

        const set = yield* Effect.promise(() =>
          client.session.setGoal({ sessionID: session.id, objective: "hono goal route" }, { throwOnError: true }),
        )
        expect(set.data.objective).toBe("hono goal route")

        const got = yield* Effect.promise(() =>
          client.session.getGoal({ sessionID: session.id }, { throwOnError: true }),
        )
        expect(got.data?.objective).toBe("hono goal route")

        const cleared = yield* Effect.promise(() =>
          client.session.clearGoal({ sessionID: session.id }, { throwOnError: true }),
        )
        expect(cleared.data).toBe(true)
      }),
    ),
  )

  it.live(
    "compacts only oversized message summaries",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const session = yield* createSession(tmp.path)
        const large = yield* createTextMessage(tmp.path, session.id, "large")
        yield* addMessageSummary(tmp.path, large.info, 121, "large")
        const boundary = yield* createTextMessage(tmp.path, session.id, "boundary")
        yield* addMessageSummary(tmp.path, boundary.info, 120, "boundary")

        const full = yield* request(`${pathFor(SessionPaths.messages, { sessionID: session.id })}`, { headers })
        const fullBody = yield* json<MessageV2.WithParts[]>(full)
        const fullLarge = fullBody.find((item) => item.info.id === large.info.id)
        expect(fullLarge?.info.role === "user" && fullLarge.info.summary?.diffs[0]?.patch).toBe("large-0")

        const compact = yield* request(`${pathFor(SessionPaths.messages, { sessionID: session.id })}?summaryDiffs=compact`, {
          headers,
        })
        const compactBody = yield* json<MessageV2.WithParts[]>(compact)
        const compactLarge = compactBody.find((item) => item.info.id === large.info.id)
        const compactBoundary = compactBody.find((item) => item.info.id === boundary.info.id)
        // HTTP API 只压缩超过阈值的正文，默认响应和 120 文件边界继续保持完整 patch。
        expect(compactLarge?.info.role === "user" && compactLarge.info.summary?.diffs[0]?.patch).toBe("")
        expect(compactBoundary?.info.role === "user" && compactBoundary.info.summary?.diffs[0]?.patch).toBe(
          "boundary-0",
        )
      }),
    ),
  )
})
