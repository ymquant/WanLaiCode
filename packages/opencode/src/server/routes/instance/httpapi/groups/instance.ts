import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { VcsGenerate } from "@/project/vcs-generate"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"
import {
  ApiVcsCommitFailedError,
  ApiVcsCreatePullRequestFailedError,
  ApiVcsGenerateFailedError,
  ApiVcsPushFailedError,
} from "../errors"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const VcsDiffQuery = Schema.Struct({
  mode: Vcs.Mode,
  ignoreWhitespace: Schema.optional(Schema.Boolean),
})

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsDiff: "/vcs/diff",
  vcsCreateBranch: "/vcs/branch",
  vcsSwitchBranch: "/vcs/branch/switch",
  vcsListBranches: "/vcs/branches",
  vcsCommit: "/vcs/commit",
  vcsPush: "/vcs/push",
  vcsCreatePullRequest: "/vcs/pull-request",
  vcsPullRequestReadiness: "/vcs/pull-request/readiness",
  vcsPullRequestStatus: "/vcs/pull-request/status",
  vcsGenerateCommitMessage: "/vcs/generate/commit-message",
  vcsGeneratePullRequest: "/vcs/generate/pull-request",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.post("vcsCreateBranch", InstancePaths.vcsCreateBranch, {
          payload: Vcs.CreateBranchInput,
          success: described(Vcs.CreateBranchOutput, "Branch created and checked out"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.createBranch",
            summary: "Create and check out a new branch",
            description:
              "Run `git switch -c <name>` (fallback to `git checkout -b`) in the current project directory and update vcs state.",
          }),
        ),
        HttpApiEndpoint.post("vcsSwitchBranch", InstancePaths.vcsSwitchBranch, {
          payload: Vcs.SwitchBranchInput,
          success: described(Vcs.CreateBranchOutput, "Branch switched"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.switchBranch",
            summary: "Switch to an existing branch",
            description: "Run `git switch <name>` (fallback to `git checkout <name>`) and update vcs state.",
          }),
        ),
        HttpApiEndpoint.get("vcsListBranches", InstancePaths.vcsListBranches, {
          success: described(Vcs.ListBranchesOutput, "Local branches"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.listBranches",
            summary: "List local branches",
            description: "List the project's local git branches plus the currently checked-out one.",
          }),
        ),
        HttpApiEndpoint.post("vcsCommit", InstancePaths.vcsCommit, {
          payload: Vcs.CommitInput,
          success: described(Vcs.CommitOutput, "Commit created"),
          error: ApiVcsCommitFailedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.commit",
            summary: "Stage and commit",
            description: "Run `git add -A` (optional) then `git commit -m <message>` in the project directory.",
          }),
        ),
        HttpApiEndpoint.post("vcsPush", InstancePaths.vcsPush, {
          payload: Schema.optional(Vcs.PushInput),
          success: described(Vcs.PushOutput, "Branch pushed"),
          error: ApiVcsPushFailedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.push",
            summary: "Push current branch",
            description:
              "Run `git push --porcelain -u origin <current-branch>` (add `--force-with-lease` when `force=true`).",
          }),
        ),
        HttpApiEndpoint.post("vcsCreatePullRequest", InstancePaths.vcsCreatePullRequest, {
          payload: Vcs.CreatePullRequestInput,
          success: described(Vcs.CreatePullRequestOutput, "Pull request created"),
          error: ApiVcsCreatePullRequestFailedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.createPullRequest",
            summary: "Create pull request",
            description: "Run `gh pr create --title <title> [--body <body>]` in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("vcsPullRequestReadiness", InstancePaths.vcsPullRequestReadiness, {
          success: described(Vcs.PullRequestReadiness, "Pull request readiness"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.pullRequestReadiness",
            summary: "Pull request readiness",
            description:
              "Inspect git/gh preconditions for creating a pull request (remote, auth, unpushed commits, worktree changes).",
          }),
        ),
        HttpApiEndpoint.get("vcsPullRequestStatus", InstancePaths.vcsPullRequestStatus, {
          success: described(Vcs.PullRequestStatus, "Pull request status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.pullRequestStatus",
            summary: "Pull request status",
            description: "Lightweight gh auth and open pull request lookup for the current branch.",
          }),
        ),
        HttpApiEndpoint.post("vcsGenerateCommitMessage", InstancePaths.vcsGenerateCommitMessage, {
          payload: VcsGenerate.GenerateCommitMessageInput,
          success: described(VcsGenerate.GenerateCommitMessageOutput, "Generated commit message"),
          error: ApiVcsGenerateFailedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.generateCommitMessage",
            summary: "Generate commit message",
            description: "Use AI to generate a commit message from the current diff.",
          }),
        ),
        HttpApiEndpoint.post("vcsGeneratePullRequest", InstancePaths.vcsGeneratePullRequest, {
          payload: VcsGenerate.GeneratePullRequestInput,
          success: described(VcsGenerate.GeneratePullRequestOutput, "Generated pull request"),
          error: ApiVcsGenerateFailedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.generatePullRequest",
            summary: "Generate pull request",
            description: "Use AI to generate a pull request title and description from branch changes.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
