import { Context, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Command } from "@/command"
import { NetProxy } from "@/net/proxy"
import * as Observability from "@opencode-ai/core/effect/observability"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Ripgrep } from "@/file/ripgrep"
import { Format } from "@/format"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import * as McpManagement from "@/mcp/management"
import { Permission } from "@/permission"
import { Installation } from "@/installation"
import { InstanceLayer } from "@/project/instance-layer"
import { Plugin } from "@/plugin"
import { Project } from "@/project/project"
import { ProviderAuth } from "@/provider/auth"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { WanlaiCodeImageGeneration } from "@/provider/wanlaicode-image-generation"
import { Pty } from "@/pty"
import { PtyTicket } from "@/pty/ticket"
import { Question } from "@/question"
import { MemoryProcessor, MemoryStore } from "@/memory"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { LLM } from "@/session/llm"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "@/sync"
import { ToolRegistry } from "@/tool/registry"
import { lazy } from "@/util/lazy"
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { Workspace } from "@/control-plane/workspace"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { Addon } from "@/addon"
import { defaultLayer as registryDefaultLayer } from "@/addon/registry"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { authorizationLayer, authorizationRouterMiddleware } from "./middleware/authorization"
import { EventApi, eventHandlers } from "./event"
import { addonHandlers } from "./handlers/addon"
import { registryHandlers } from "./handlers/registry"
import { automationHandlers } from "./handlers/automation"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { remoteControlHandlers } from "./handlers/remote-control"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { memoryHandlers } from "./handlers/memory"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectRoute, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { v2Handlers } from "./handlers/v2"
import { wanlaiCodeUserCenterHandlers } from "./handlers/wanlaicode-user-center"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer, instanceRouterMiddleware } from "./middleware/instance-context"
import { workspaceRouterMiddleware, workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import * as ServerBackend from "@/server/backend"
import { errorLayer } from "./middleware/error"

export const context = Context.makeUnsafe<unknown>(new Map())

const runtime = HttpRouter.middleware()(
  Effect.succeed((effect) =>
    Effect.gen(function* () {
      const selected = ServerBackend.select()
      yield* Effect.annotateCurrentSpan(ServerBackend.attributes(ServerBackend.force(selected, "effect-httpapi")))
      return yield* effect
    }),
  ),
).layer

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// remote-control root 管理端点受本地 ServerAuth 保护，renderer 无法绕过 sidecar 凭证直接访问。
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers, remoteControlHandlers]),
  // 仅声明了 Authorization 的 root group 会执行该层；健康检查等既有公开端点保持原行为。
  Layer.provide(authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))),
)
const instanceRouterLayer = authorizationRouterMiddleware
  .combine(instanceRouterMiddleware)
  .combine(workspaceRouterMiddleware)
  .layer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal), Layer.provide(ServerAuth.Config.defaultLayer))
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide(instanceRouterLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    addonHandlers,
    registryHandlers,
    automationHandlers,
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    memoryHandlers,
    projectHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    v2Handlers,
    tuiHandlers,
    wanlaiCodeUserCenterHandlers,
    workspaceHandlers,
  ]),
  Layer.provide(McpManagement.layer),
)

const rawInstanceRoutes = Layer.mergeAll(ptyConnectRoute).pipe(Layer.provide(instanceRouterLayer))
const instanceRoutes = Layer.mergeAll(rawInstanceRoutes, instanceApiRoutes).pipe(
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
  ]),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const client = yield* HttpClient.HttpClient
    yield* router.add("*", "/*", (request) => serveUIEffect(request, { fs, client }))
  }),
).pipe(Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))))

export function createRoutes(corsOptions?: CorsOptions) {
  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, uiRoute).pipe(
    Layer.provide([
      errorLayer,
      cors(corsOptions),
      runtime,
      Account.defaultLayer,
      Addon.defaultLayer,
      registryDefaultLayer,
      Agent.defaultLayer,
      Auth.defaultLayer,
      Command.defaultLayer,
      Config.defaultLayer,
      File.defaultLayer,
      FileWatcher.defaultLayer,
      Format.defaultLayer,
      Git.defaultLayer,
      LSP.defaultLayer,
      Installation.defaultLayer,
      MCP.defaultLayer,
      ModelsDev.defaultLayer,
      Permission.defaultLayer,
      Plugin.defaultLayer,
      Project.defaultLayer,
      ProviderAuth.defaultLayer,
      Provider.defaultLayer,
      WanlaiCodeImageGeneration.sessionLayer,
      Pty.defaultLayer,
      PtyTicket.defaultLayer,
      Question.defaultLayer,
      Ripgrep.defaultLayer,
      Session.defaultLayer,
      SessionCompaction.defaultLayer,
      SessionPrompt.defaultLayer,
      SessionRevert.defaultLayer,
      SessionShare.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      SessionSummary.defaultLayer,
      LLM.defaultLayer,
      MemoryStore.defaultLayer,
      MemoryProcessor.defaultLayer,
      ShareNext.defaultLayer,
      Snapshot.defaultLayer,
      SyncEvent.defaultLayer,
      Skill.appLayer,
      Todo.defaultLayer,
      ToolRegistry.defaultLayer,
      Vcs.defaultLayer,
      Workspace.defaultLayer,
      Worktree.appLayer,
      Bus.layer,
      AppFileSystem.defaultLayer,
      NetProxy.layer,
      HttpServer.layerServices,
    ]),
    Layer.provideMerge(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provideMerge(InstanceLayer.layer),
    Layer.provideMerge(Observability.layer),
  )
}

export const routes = createRoutes()

const defaultWebHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export function webHandler(corsOptions?: CorsOptions) {
  if (!corsOptions?.cors?.length) return defaultWebHandler()
  return HttpRouter.toWebHandler(createRoutes(corsOptions), {
    // Server-level CORS options are dynamic; don't reuse the default route layer memoized without them.
    memoMap: Layer.makeMemoMapUnsafe(),
    middleware: disposeMiddleware,
  })
}

export * as ExperimentalHttpApiServer from "./server"
