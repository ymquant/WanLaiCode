import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import fs from "node:fs"
import path from "node:path"
import { Context, Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import z from "zod"
import { Format } from "@/format"
import { TuiRoutes } from "./tui"
import { Instance } from "@/project/instance"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Vcs } from "@/project/vcs"
import { VcsGenerate } from "@/project/vcs-generate"
import { which } from "@/util/which"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Command } from "@/command"
import { QuestionRoutes } from "./question"
import { PermissionRoutes } from "./permission"
import { ProjectRoutes } from "./project"
import { SessionRoutes } from "./session"
import { PtyRoutes } from "./pty"
import { McpRoutes } from "./mcp"
import { FileRoutes } from "./file"
import { ConfigRoutes } from "./config"
import { AutomationRoutes } from "./automation"
import { ExperimentalRoutes } from "./experimental"
import { ProviderRoutes } from "./provider"
import { EventRoutes } from "./event"
import { SyncRoutes } from "./sync"
import { InstanceMiddleware } from "./middleware"
import { jsonRequest } from "./trace"
import { ExperimentalHttpApiServer } from "./httpapi/server"
import * as VcsError from "./httpapi/handlers/vcs-errors"
import { AddonPaths } from "./httpapi/groups/addon"
import { EventPaths } from "./httpapi/event"
import { ExperimentalPaths } from "./httpapi/groups/experimental"
import { FilePaths } from "./httpapi/groups/file"
import { InstancePaths } from "./httpapi/groups/instance"
import { McpPaths } from "./httpapi/groups/mcp"
import { ProviderPaths } from "./httpapi/groups/provider"
import { PtyPaths } from "./httpapi/groups/pty"
import { SessionPaths } from "./httpapi/groups/session"
import { SyncPaths } from "./httpapi/groups/sync"
import { TuiPaths } from "./httpapi/groups/tui"
import { WanlaiCodeUserCenterPaths } from "./httpapi/groups/wanlaicode-user-center"
import { WorkspacePaths } from "./httpapi/groups/workspace"
import type { CorsOptions } from "@/server/cors"

export const InstanceRoutes = (upgrade: UpgradeWebSocket, opts?: CorsOptions): Hono => {
  const app = new Hono()
  const handler = ExperimentalHttpApiServer.webHandler(opts).handler
  const context = Context.empty() as Context.Context<unknown>

  app.all("/api/*", (c) => handler(c.req.raw, context))

  // Addon endpoints have no Hono-side implementation — they only exist on the
  // Effect HttpApi handler. Bridge them unconditionally so the routes resolve
  // on every channel (the desktop ships built bundles where the experimental
  // flag is off by default).
  app.get(AddonPaths.list, (c) => handler(c.req.raw, context))
  app.get(AddonPaths.get, (c) => handler(c.req.raw, context))
  app.post(AddonPaths.install, (c) => handler(c.req.raw, context))
  app.post(AddonPaths.uninstall, (c) => handler(c.req.raw, context))
  app.post(AddonPaths.toggle, (c) => handler(c.req.raw, context))
  app.post(AddonPaths.skillToggle, (c) => handler(c.req.raw, context))
  app.post(AddonPaths.skillInstall, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.status, (c) => handler(c.req.raw, context))
  app.post(WanlaiCodeUserCenterPaths.login, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.entitlements, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.apiKey, (c) => handler(c.req.raw, context))
  app.post(WanlaiCodeUserCenterPaths.apiKey, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.purchasePlans, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.purchasePage, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.usage, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.usageStats, (c) => handler(c.req.raw, context))
  app.post(WanlaiCodeUserCenterPaths.imageGenerate, (c) => handler(c.req.raw, context))
  app.get(WanlaiCodeUserCenterPaths.codexIntegrationStatus, (c) => handler(c.req.raw, context))
  app.post(WanlaiCodeUserCenterPaths.codexIntegrationImport, (c) => handler(c.req.raw, context))
  app.post(WanlaiCodeUserCenterPaths.codexIntegrationRestore, (c) => handler(c.req.raw, context))
  app.get(InstancePaths.vcs, (c) => handler(c.req.raw, context))
  app.post(InstancePaths.vcsGenerateCommitMessage, (c) => handler(c.req.raw, context))
  app.post(InstancePaths.vcsGeneratePullRequest, (c) => handler(c.req.raw, context))
  app.post(SessionPaths.goal, (c) => handler(c.req.raw, context))
  app.get(SessionPaths.goal, (c) => handler(c.req.raw, context))
  app.delete(SessionPaths.goal, (c) => handler(c.req.raw, context))
  app.post(ProviderPaths.wanlaicodeOAuthRefresh, (c) => handler(c.req.raw, context))

  if (Flag.WANLAICODE_EXPERIMENTAL_HTTPAPI) {
    app.get(EventPaths.event, (c) => handler(c.req.raw, context))
    app.get("/question", (c) => handler(c.req.raw, context))
    app.post("/question/:requestID/reply", (c) => handler(c.req.raw, context))
    app.post("/question/:requestID/reject", (c) => handler(c.req.raw, context))
    app.get("/permission", (c) => handler(c.req.raw, context))
    app.post("/permission/:requestID/reply", (c) => handler(c.req.raw, context))
    app.get("/config", (c) => handler(c.req.raw, context))
    app.patch("/config", (c) => handler(c.req.raw, context))
    app.get("/config/providers", (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.console, (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.consoleOrgs, (c) => handler(c.req.raw, context))
    app.post(ExperimentalPaths.consoleSwitch, (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.tool, (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.toolIDs, (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.worktree, (c) => handler(c.req.raw, context))
    app.post(ExperimentalPaths.worktree, (c) => handler(c.req.raw, context))
    app.delete(ExperimentalPaths.worktree, (c) => handler(c.req.raw, context))
    app.post(ExperimentalPaths.worktreeReset, (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.session, (c) => handler(c.req.raw, context))
    app.get(ExperimentalPaths.resource, (c) => handler(c.req.raw, context))
    app.get("/provider", (c) => handler(c.req.raw, context))
    app.get("/provider/auth", (c) => handler(c.req.raw, context))
    app.post("/provider/wanlaicode/api-key/validate", (c) => handler(c.req.raw, context))
    app.post("/provider/:providerID/oauth/authorize", (c) => handler(c.req.raw, context))
    app.post("/provider/:providerID/oauth/callback", (c) => handler(c.req.raw, context))
    app.get("/project", (c) => handler(c.req.raw, context))
    app.get("/project/current", (c) => handler(c.req.raw, context))
    app.post("/project/git/init", (c) => handler(c.req.raw, context))
    app.patch("/project/:projectID", (c) => handler(c.req.raw, context))
    app.get(FilePaths.findText, (c) => handler(c.req.raw, context))
    app.get(FilePaths.findFile, (c) => handler(c.req.raw, context))
    app.get(FilePaths.findSymbol, (c) => handler(c.req.raw, context))
    app.get(FilePaths.list, (c) => handler(c.req.raw, context))
    app.get(FilePaths.content, (c) => handler(c.req.raw, context))
    app.get(FilePaths.exists, (c) => handler(c.req.raw, context))
    app.get(FilePaths.status, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.path, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.dispose, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.vcs, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.vcsDiff, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsCreateBranch, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsSwitchBranch, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.vcsListBranches, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsCommit, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsPush, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsCreatePullRequest, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.vcsPullRequestReadiness, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.vcsPullRequestStatus, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsGenerateCommitMessage, (c) => handler(c.req.raw, context))
    app.post(InstancePaths.vcsGeneratePullRequest, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.command, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.agent, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.skill, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.lsp, (c) => handler(c.req.raw, context))
    app.get(InstancePaths.formatter, (c) => handler(c.req.raw, context))
    app.get(McpPaths.status, (c) => handler(c.req.raw, context))
    app.post(McpPaths.status, (c) => handler(c.req.raw, context))
    app.get(McpPaths.manage, (c) => handler(c.req.raw, context))
    app.get(McpPaths.manageGet, (c) => handler(c.req.raw, context))
    app.post(McpPaths.manageSave, (c) => handler(c.req.raw, context))
    app.delete(McpPaths.manageGet, (c) => handler(c.req.raw, context))
    app.post(McpPaths.manageToggle, (c) => handler(c.req.raw, context))
    app.post(McpPaths.auth, (c) => handler(c.req.raw, context))
    app.post(McpPaths.authCallback, (c) => handler(c.req.raw, context))
    app.post(McpPaths.authAuthenticate, (c) => handler(c.req.raw, context))
    app.delete(McpPaths.auth, (c) => handler(c.req.raw, context))
    app.post(McpPaths.connect, (c) => handler(c.req.raw, context))
    app.post(McpPaths.disconnect, (c) => handler(c.req.raw, context))
    app.post(SyncPaths.start, (c) => handler(c.req.raw, context))
    app.post(SyncPaths.replay, (c) => handler(c.req.raw, context))
    app.post(SyncPaths.history, (c) => handler(c.req.raw, context))
    app.get(PtyPaths.list, (c) => handler(c.req.raw, context))
    app.post(PtyPaths.create, (c) => handler(c.req.raw, context))
    app.get(PtyPaths.get, (c) => handler(c.req.raw, context))
    app.put(PtyPaths.update, (c) => handler(c.req.raw, context))
    app.delete(PtyPaths.remove, (c) => handler(c.req.raw, context))
    app.post(PtyPaths.connectToken, (c) => handler(c.req.raw, context))
    app.get(PtyPaths.connect, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.list, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.status, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.get, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.children, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.todo, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.diff, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.messages, (c) => handler(c.req.raw, context))
    app.get(SessionPaths.message, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.create, (c) => handler(c.req.raw, context))
    app.delete(SessionPaths.remove, (c) => handler(c.req.raw, context))
    app.patch(SessionPaths.update, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.init, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.fork, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.abort, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.share, (c) => handler(c.req.raw, context))
    app.delete(SessionPaths.share, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.summarize, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.prompt, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.promptAsync, (c) => handler(c.req.raw, context))
    // steer 使用独立 durable ACK 路由，不再借普通异步消息模拟当前回合改向。
    app.post(SessionPaths.steer, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.command, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.shell, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.revert, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.unrevert, (c) => handler(c.req.raw, context))
    app.post(SessionPaths.permissions, (c) => handler(c.req.raw, context))
    app.delete(SessionPaths.deleteMessage, (c) => handler(c.req.raw, context))
    app.delete(SessionPaths.deletePart, (c) => handler(c.req.raw, context))
    app.patch(SessionPaths.updatePart, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.appendPrompt, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.openHelp, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.openSessions, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.openThemes, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.openModels, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.submitPrompt, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.clearPrompt, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.executeCommand, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.showToast, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.publish, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.selectSession, (c) => handler(c.req.raw, context))
    app.get(TuiPaths.controlNext, (c) => handler(c.req.raw, context))
    app.post(TuiPaths.controlResponse, (c) => handler(c.req.raw, context))
    app.get(WorkspacePaths.adapters, (c) => handler(c.req.raw, context))
    app.post(WorkspacePaths.list, (c) => handler(c.req.raw, context))
    app.get(WorkspacePaths.list, (c) => handler(c.req.raw, context))
    app.get(WorkspacePaths.status, (c) => handler(c.req.raw, context))
    app.delete(WorkspacePaths.remove, (c) => handler(c.req.raw, context))
    app.post(WorkspacePaths.warp, (c) => handler(c.req.raw, context))
  }

  return app
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade, opts))
    .route("/config", ConfigRoutes())
    .route("/automation", AutomationRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/question", QuestionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/sync", SyncRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/mcp", McpRoutes())
    .route("/tui", TuiRoutes())
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        // 后台拆除：dispose 会先排空活跃回合，若在此 await 会阻塞响应数分钟。
        // 立即返回，实例在活跃回合跑完后于后台真正拆除，不砍断正在生成的回答。
        const current = Instance.current
        void InstanceRuntime.disposeInstance(current).catch(() => {})
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the OpenCode instance.",
        operationId: "path.get",
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.get", c, function* () {
          const directory = Instance.directory
          const git_installed = !!which("git")
          const local_git = yield* Effect.sync(() => {
            try {
              return fs.existsSync(path.join(directory, ".git"))
            } catch {
              return false
            }
          })
          const usable = git_installed && local_git
          const vcs = yield* Vcs.Service
          const [branch, default_branch] = usable
            ? yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
            : [undefined, undefined]
          return { branch, default_branch, gh_cli: !!which("gh"), git_installed, local_git }
        }),
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current git diff for the working tree or against the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileDiff.zod.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode.zod,
          // 与 effect-httpapi (Schema.Boolean in query) 的 OpenAPI 输出对齐：string enum
          ignoreWhitespace: z.enum(["true", "false"]).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.diff", c, function* () {
          const vcs = yield* Vcs.Service
          const q = c.req.valid("query")
          return yield* vcs.diff(q.mode, { ignoreWhitespace: q.ignoreWhitespace === "true" })
        }),
    )
    .post(
      "/vcs/branch",
      describeRoute({
        summary: "Create and check out a new branch",
        description:
          "Run `git switch -c <name>` (fallback to `git checkout -b`) in the current project directory and update vcs state.",
        operationId: "vcs.createBranch",
        responses: {
          200: {
            description: "Branch created and checked out",
            content: {
              "application/json": {
                schema: resolver(Vcs.CreateBranchOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", Vcs.CreateBranchInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.createBranch", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.createBranch(c.req.valid("json"))
        }),
    )
    .post(
      "/vcs/branch/switch",
      describeRoute({
        summary: "Switch to an existing branch",
        description: "Run `git switch <name>` (fallback to `git checkout <name>`) and update vcs state.",
        operationId: "vcs.switchBranch",
        responses: {
          200: {
            description: "Branch switched",
            content: {
              "application/json": {
                schema: resolver(Vcs.CreateBranchOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", Vcs.SwitchBranchInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.switchBranch", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.switchBranch(c.req.valid("json"))
        }),
    )
    .post(
      "/vcs/commit",
      describeRoute({
        summary: "Stage and commit",
        description: "Run `git add -A` (optional) then `git commit -m <message>` in the project directory.",
        operationId: "vcs.commit",
        responses: {
          200: {
            description: "Commit created",
            content: {
              "application/json": {
                schema: resolver(Vcs.CommitOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", Vcs.CommitInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.commit", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* VcsError.mapCommitErrors(vcs.commit(c.req.valid("json")))
        }),
    )
    .post(
      "/vcs/push",
      describeRoute({
        summary: "Push current branch",
        description:
          "Run `git push --porcelain -u origin <current-branch>` (add `--force-with-lease` when `force=true`).",
        operationId: "vcs.push",
        responses: {
          200: {
            description: "Branch pushed",
            content: {
              "application/json": {
                schema: resolver(Vcs.PushOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", Vcs.PushInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.push", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* VcsError.mapPushErrors(vcs.push(c.req.valid("json")))
        }),
    )
    .post(
      "/vcs/pull-request",
      describeRoute({
        summary: "Create pull request",
        description: "Run `gh pr create --title <title> [--body <body>]` in the project directory.",
        operationId: "vcs.createPullRequest",
        responses: {
          200: {
            description: "Pull request created",
            content: {
              "application/json": {
                schema: resolver(Vcs.CreatePullRequestOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", Vcs.CreatePullRequestInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.createPullRequest", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* VcsError.mapCreatePullRequestErrors(vcs.createPullRequest(c.req.valid("json")))
        }),
    )
    .get(
      "/vcs/pull-request/readiness",
      describeRoute({
        summary: "Pull request readiness",
        description:
          "Inspect git/gh preconditions for creating a pull request (remote, auth, unpushed commits, worktree changes).",
        operationId: "vcs.pullRequestReadiness",
        responses: {
          200: {
            description: "Pull request readiness",
            content: {
              "application/json": {
                schema: resolver(Vcs.PullRequestReadiness.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.pullRequestReadiness", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.pullRequestReadiness()
        }),
    )
    .get(
      "/vcs/pull-request/status",
      describeRoute({
        summary: "Pull request status",
        description: "Lightweight gh auth and open pull request lookup for the current branch.",
        operationId: "vcs.pullRequestStatus",
        responses: {
          200: {
            description: "Pull request status",
            content: {
              "application/json": {
                schema: resolver(Vcs.PullRequestStatus.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.pullRequestStatus", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.pullRequestStatus()
        }),
    )
    .post(
      "/vcs/generate/commit-message",
      describeRoute({
        summary: "Generate commit message",
        description: "Use AI to generate a commit message from the current diff.",
        operationId: "vcs.generateCommitMessage",
        responses: {
          200: {
            description: "Generated commit message",
            content: {
              "application/json": {
                schema: resolver(VcsGenerate.GenerateCommitMessageOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", VcsGenerate.GenerateCommitMessageInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.generateCommitMessage", c, function* () {
          return yield* VcsError.mapGenerateErrors(VcsGenerate.generateCommitMessage(c.req.valid("json")))
        }),
    )
    .post(
      "/vcs/generate/pull-request",
      describeRoute({
        summary: "Generate pull request",
        description: "Use AI to generate a pull request title and description from branch changes.",
        operationId: "vcs.generatePullRequest",
        responses: {
          200: {
            description: "Generated pull request",
            content: {
              "application/json": {
                schema: resolver(VcsGenerate.GeneratePullRequestOutput.zod),
              },
            },
          },
        },
      }),
      validator("json", VcsGenerate.GeneratePullRequestInput.zod),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.generatePullRequest", c, function* () {
          return yield* VcsError.mapGenerateErrors(VcsGenerate.generatePullRequest(c.req.valid("json")))
        }),
    )
    .get(
      "/vcs/branches",
      describeRoute({
        summary: "List local branches",
        description: "List the project's local git branches plus the currently checked-out one.",
        operationId: "vcs.listBranches",
        responses: {
          200: {
            description: "Local branches",
            content: {
              "application/json": {
                schema: resolver(Vcs.ListBranchesOutput.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.listBranches", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.listBranches()
        }),
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the OpenCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.command.list", c, function* () {
          const svc = yield* Command.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the OpenCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.agent.list", c, function* () {
          const svc = yield* Agent.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the OpenCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.skill.list", c, function* () {
          const skill = yield* Skill.Service
          return yield* skill.all()
        }),
    )
    .get(
      "/lsp",
      describeRoute({
        summary: "Get LSP status",
        description: "Get LSP server status",
        operationId: "lsp.status",
        responses: {
          200: {
            description: "LSP server status",
            content: {
              "application/json": {
                schema: resolver(LSP.Status.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.lsp.status", c, function* () {
          const lsp = yield* LSP.Service
          return yield* lsp.status()
        }),
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.formatter.status", c, function* () {
          const svc = yield* Format.Service
          return yield* svc.status()
        }),
    )
}
