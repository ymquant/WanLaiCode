import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { VcsGenerate } from "@/project/vcs-generate"
import { which } from "@/util/which"
import { Skill } from "@/skill"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import * as VcsError from "./vcs-errors"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context, "explicit")
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const ctx = yield* InstanceState.context
      const git_installed = !!which("git")
      const local_git = yield* Effect.sync(() => {
        try {
          return fs.existsSync(path.join(ctx.directory, ".git"))
        } catch {
          return false
        }
      })
      const usable = git_installed && local_git
      const [branch, default_branch] = usable
        ? yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
        : [undefined, undefined]
      return { branch, default_branch, gh_cli: !!which("gh"), git_installed, local_git }
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; ignoreWhitespace?: boolean }
    }) {
      return yield* vcs.diff(ctx.query.mode, { ignoreWhitespace: ctx.query.ignoreWhitespace === true })
    })

    const createVcsBranch = Effect.fn("InstanceHttpApi.vcsCreateBranch")(function* (ctx: {
      payload: Vcs.CreateBranchInput
    }) {
      return yield* vcs.createBranch(ctx.payload)
    })

    const switchVcsBranch = Effect.fn("InstanceHttpApi.vcsSwitchBranch")(function* (ctx: {
      payload: Vcs.SwitchBranchInput
    }) {
      return yield* vcs.switchBranch(ctx.payload)
    })

    const listVcsBranches = Effect.fn("InstanceHttpApi.vcsListBranches")(function* () {
      return yield* vcs.listBranches()
    })

    const commitVcs = Effect.fn("InstanceHttpApi.vcsCommit")(function* (ctx: { payload: Vcs.CommitInput }) {
      return yield* VcsError.mapCommitErrors(vcs.commit(ctx.payload))
    })

    const pushVcs = Effect.fn("InstanceHttpApi.vcsPush")(function* (ctx: { payload?: Vcs.PushInput }) {
      return yield* VcsError.mapPushErrors(vcs.push(ctx.payload))
    })

    const createVcsPullRequest = Effect.fn("InstanceHttpApi.vcsCreatePullRequest")(function* (ctx: {
      payload: Vcs.CreatePullRequestInput
    }) {
      return yield* VcsError.mapCreatePullRequestErrors(vcs.createPullRequest(ctx.payload))
    })

    const getVcsPullRequestReadiness = Effect.fn("InstanceHttpApi.vcsPullRequestReadiness")(function* () {
      return yield* vcs.pullRequestReadiness()
    })

    const getVcsPullRequestStatus = Effect.fn("InstanceHttpApi.vcsPullRequestStatus")(function* () {
      return yield* vcs.pullRequestStatus()
    })

    const generateVcsCommitMessage = Effect.fn("InstanceHttpApi.vcsGenerateCommitMessage")(function* (ctx: {
      payload: VcsGenerate.GenerateCommitMessageInput
    }) {
      return yield* VcsError.mapGenerateErrors(VcsGenerate.generateCommitMessage(ctx.payload))
    })

    const generateVcsPullRequest = Effect.fn("InstanceHttpApi.vcsGeneratePullRequest")(function* (ctx: {
      payload: VcsGenerate.GeneratePullRequestInput
    }) {
      return yield* VcsError.mapGenerateErrors(VcsGenerate.generatePullRequest(ctx.payload))
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsCreateBranch", createVcsBranch)
      .handle("vcsSwitchBranch", switchVcsBranch)
      .handle("vcsListBranches", listVcsBranches)
      .handle("vcsCommit", commitVcs)
      .handle("vcsPush", pushVcs)
      .handle("vcsCreatePullRequest", createVcsPullRequest)
      .handle("vcsPullRequestReadiness", getVcsPullRequestReadiness)
      .handle("vcsPullRequestStatus", getVcsPullRequestStatus)
      .handle("vcsGenerateCommitMessage", generateVcsCommitMessage)
      .handle("vcsGeneratePullRequest", generateVcsPullRequest)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
