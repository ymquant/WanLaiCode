import { Automation } from "@/automation/automation"
import { runHeader } from "@/automation/message"
import { parseInboxItem, stripInboxDirective } from "@/automation/inbox"
import type { AutomationID, Info, RunInfo, RunTrigger, ScheduleConfig } from "@/automation/schema"
import { Provider } from "@/provider/provider"
import type { ModelID, ProviderID } from "@/provider/schema"
import type { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { Permission } from "@/permission"
import { AppRuntime } from "@/effect/app-runtime"
import { WithInstance } from "@/project/with-instance"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { runtimeDirectory } from "./directory"

const log = Log.create({ service: "automation-run" })

// 单次运行的最长等待时间。超时只是停止「等待」并把运行落成失败状态,底层回合仍可能继续跑完
// (工具是 detached 执行的);目的是不让一次挂死的运行永久占住调度器的 inflight 槽位,
// 使该自动化此后每次到点都被静默跳过。
const RUN_TIMEOUT_MS = 30 * 60_000

// 模型字符串 "providerID/modelID" → 结构化引用(modelID 可含 "/",按首个 "/" 切分)
function parseModelRef(value: string): { providerID: ProviderID; modelID: ModelID } | undefined {
  const i = value.indexOf("/")
  if (i <= 0) return undefined
  return { providerID: value.slice(0, i) as ProviderID, modelID: value.slice(i + 1) as ModelID }
}

type ResolvedModel = {
  ref: { providerID: ProviderID; modelID: ModelID } | undefined
  // 模型 variants 里存在对应档位时才传 variant:llm.ts 直接用 variants[variant] 取值,
  // 传一个该模型不支持的档位只会被静默忽略,而 provider 侧参数可能已被污染。
  variant: string | undefined
}

// 解析自动化要用的模型与推理档位。自动化是长期存在的,它绑定的模型随时可能被下掉/换名/退登,
// 到点时按原样硬用会让整次运行失败;对照 Codex 的 `Automation model unavailable; falling back`,
// 取不到就回退默认模型并记 warning,让自动化继续跑而不是彻底停摆。
const resolveModel = Effect.fn("Automation.resolveModel")(function* (automation: Info) {
    const provider = yield* Provider.Service
    const wanted = automation.model ? parseModelRef(automation.model) : undefined
    const effort = automation.reasoningEffort ?? undefined

    const load = (ref: { providerID: ProviderID; modelID: ModelID } | undefined) =>
      ref
        ? provider.getModel(ref.providerID, ref.modelID).pipe(
            Effect.map((model) => ({ ref, model })),
            Effect.catchCause(() => Effect.succeed(undefined)),
            Effect.catchDefect(() => Effect.succeed(undefined)),
          )
        : Effect.succeed(undefined)

    let loaded = yield* load(wanted)
    if (!loaded && wanted) {
      log.warn("automation model unavailable, falling back", {
        automationID: automation.id,
        model: automation.model,
      })
      const fallback = yield* provider
        .defaultModel()
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)), Effect.catchDefect(() => Effect.succeed(undefined)))
      loaded = yield* load(fallback)
    }
    if (!loaded) return { ref: wanted, variant: undefined }
    // 档位必须是该模型真实支持的 variant,否则不传(与 agent 侧 ag.variant 的校验口径一致)
    const variant = effort && loaded.model.variants?.[effort] ? effort : undefined
    return { ref: loaded.ref, variant } satisfies ResolvedModel
})

// 从回合结果判定运行是否真的成功。两类失败都不会让 prompt reject,只看有没有抛异常必然误报成功:
// 1) 模型侧失败(配额耗尽、上游 5xx 重试耗尽)被 processor 的 halt 收敛成正常 resolve,错误写在 assistant 消息上;
// 2) 被动中断(实例 scope 关闭/驱逐)走 finalizeInterrupted,只补 completed 不写 finish,
//    返回的是一条没有 error 也没有 finish 的半截 assistant。
// 判据与会话层的 assistantCompletesInstruction 保持一致:finish 缺失或停在 tool-calls/unknown
// 都不算「真的把这轮指令做完了」。
export function runOutcome(result: MessageV2.WithParts): { status: "success" | "error"; error?: string } {
  const info = result.info
  if (info.role !== "assistant") return { status: "error", error: "自动化运行未产生回复(回合被取消或中断)" }
  if (info.error) {
    const data = info.error.data as { message?: string } | undefined
    return { status: "error", error: data?.message ?? info.error.name }
  }
  if (!info.finish) return { status: "error", error: "自动化运行被中断,未产生完整回复" }
  if (["tool-calls", "unknown"].includes(info.finish))
    return { status: "error", error: `自动化运行未正常收尾(finish=${info.finish})` }
  return { status: "success" }
}

// 门禁挡住后的重试退避(对照 Codex 的 ki=60_000 与 Ii()):最迟 60 秒后重试,
// 但若正常排期比这更早就用排期,别把用户的排期往后推。
const GATE_BACKOFF_MS = 60_000

// 「对话」模式的运行门禁。thread 模式复用的是用户自己的置顶对话,直接注入会撞上三种情况:
// 会话已被删除(往不存在的会话写)、用户正在这个会话里跟模型对话(注入的执行体会被 runner
// 丢弃,却仍被标成 success)、以及刚跑过/用户刚活动过就又打断。
// 对照 Codex heartbeat 的 6 道门,我们能对齐的是其中三道(其余是 Codex 渲染层特有的资格状态)。
// 调度触发被挡住时与 Codex 一致:只调 next_run_at 并记日志,不写 automation_run 记录;
// 手动触发被挡住则**会**落一条带原因的 error 记录(用户明确点了运行,不能静默跳过)。
type GateBlock = { reason: string; nextRunAt: number }

// 门禁原因 → 给用户看的中文说明(只有手动触发才需要:调度触发是静默跳过的)
export function gateMessage(reason: string): string {
  if (reason === "thread_missing") return "绑定的对话已不存在,请在自动化设置里重新选择对话"
  if (reason.startsWith("thread_busy")) return "绑定的对话正在进行中,已跳过本次运行,稍后会自动重试"
  if (reason === "cooldown_not_elapsed") return "距上次运行/对话活动还不到一个间隔,已跳过本次运行"
  return `本次运行被跳过(${reason})`
}

// 门禁退避时刻(对照 Codex 的 Ii):min(下一个正常排期, now + 60s)。
// 取 min 是为了不把用户的排期往后推 —— 排期比 60 秒更近时就按排期来。
export function gateBackoffAt(config: ScheduleConfig, now: number): number {
  const scheduled = Automation.computeNextRun(config, now)
  return scheduled === null ? now + GATE_BACKOFF_MS : Math.min(scheduled, now + GATE_BACKOFF_MS)
}

// 冷却到期时刻(对照 Codex 的 Aee/kee)。返回 null = 不设冷却。
// 只对「每隔 N 分钟」这类间隔型排期生效:墙钟排期是用户明确指定的时刻,该按时跑。
// 基线取「上次运行」与「会话最后活动」的较晚者 —— 用户刚在这个对话里说过话,
// 就顺延一个完整间隔而不是立刻插话。
export function cooldownUntil(config: ScheduleConfig, lastRunAt: number | null, threadUpdatedAt: number | null) {
  if (config.mode !== "interval") return null
  const baseline = Math.max(lastRunAt ?? 0, threadUpdatedAt ?? 0)
  if (baseline <= 0) return null
  return baseline + Math.max(1, Math.floor(config.intervalMinutes || 1)) * 60_000
}

const threadGate = Effect.fn("Automation.threadGate")(function* (automation: Info) {
    const now = Date.now()
    const sessionID = SessionID.make(automation.threadSessionID!)
    const backoff = () => gateBackoffAt(automation.scheduleConfig, now)

    const sessions = yield* Session.Service
    const session = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!session) return { reason: "thread_missing", nextRunAt: backoff() }

    const statusSvc = yield* SessionStatus.Service
    const status = yield* statusSvc.get(sessionID).pipe(Effect.catch(() => Effect.succeed({ type: "idle" as const })))
    // busy = 用户或上一轮自动化正在这个会话里跑;retry = 正在重试同一回合。
    // 这两种状态下注入会被 runner 合并等待既有回合并丢弃本次 work。
    if (status.type === "busy" || status.type === "retry")
      return { reason: `thread_busy(${status.type})`, nextRunAt: backoff() }

    const cooldown = cooldownUntil(automation.scheduleConfig, automation.lastRunAt, session.time.updated ?? null)
    // 冷却用精确到期时刻(不套 60s 上限),下一个 tick 就不会白跑
    if (cooldown !== null && cooldown > now) return { reason: "cooldown_not_elapsed", nextRunAt: cooldown }
    return null
})

type Started = { run: RunInfo; session: { id: string; directory: string } | null; model: ResolvedModel }

// 运行的准备阶段:建会话/复用绑定对话 → 落 running 记录。排期不在这里推进 ——
// execute() 已在调用本函数之前用 claimRun 抢占并推进过。
// 建会话失败也要落一条 error 运行记录,否则前端历史区一片空白、用户看不到失败原因。
async function begin(input: { automation: Info; trigger: RunTrigger; advanceSchedule: boolean }): Promise<Started> {
  const { automation, trigger } = input
  // 已落库的运行记录:准备阶段任何一步失败都要复用它落 error,不能再 startRun 一条
  // (否则同一次触发出两条记录,且第一条永远停在 running、让侧栏会话一直转圈)
  let run: RunInfo | undefined
  let model: ResolvedModel = { ref: undefined, variant: undefined }
  try {
    // 目录解析也要在 try 内:globalAutomationDirectory() 会 mkdirSync,磁盘满/EACCES 时抛错。
    // 放在 try 外会让异常绕过「落 error 记录」,用户在历史区什么都看不到。
    const dir = runtimeDirectory(automation.directory)
    // 「对话」(heartbeat)模式:复用已附着的置顶对话注入 prompt;其余模式新建会话
    const useThread = automation.executionEnvironment === "thread" && !!automation.threadSessionID
    // 在自动化所属项目目录的实例上下文里建会话/跑 prompt,使其出现在该项目侧栏下
    const started = await WithInstance.provide({
      directory: dir,
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const resolved = yield* resolveModel(automation)
            if (useThread) return { session: { id: automation.threadSessionID!, directory: dir }, model: resolved }
            const svc = yield* Session.Service
            const session = yield* svc.create({
              title: automation.title,
              agent: automation.agent ?? undefined,
              model: resolved.ref
                ? { id: resolved.ref.modelID, providerID: resolved.ref.providerID, variant: resolved.variant }
                : undefined,
            })
            return { session, model: resolved }
          }),
        ),
    })
    model = started.model
    run = Automation.startRun({
      automationID: automation.id,
      trigger,
      sessionID: started.session.id,
      directory: started.session.directory,
    })
    if (!input.advanceSchedule) Automation.markLastRun(automation.id, Date.now())
    return { run, session: started.session, model }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failed = run ?? Automation.startRun({ automationID: automation.id, trigger, directory: automation.directory })
    Automation.finishRun(failed.id, { status: "error", error: message })
    // 排期已在 execute 抢占时推进过,这里不必再动 —— 准备阶段失败不会让调度器每 tick 重试
    log.error("automation run setup failed", { automationID: automation.id, error: message })
    return { run: { ...failed, status: "error", error: message, finishedAt: Date.now() }, session: null, model }
  }
}

// 取出模型在回复末尾给的 ::inbox-item 指令,落到运行记录上,并把指令行从展示文本里剥掉。
// 剥离放在这里而不是通用消息渲染层:指令只可能出现在自动化运行的回合里,
// 在这条唯一的路径上做,不必给全局 Markdown 管道加特例。
// 整个过程尽力而为 —— 失败只记日志,绝不影响运行状态判定。
async function harvestInboxItem(automation: Info, started: Started): Promise<void> {
  if (!started.session) return
  const sessionID = SessionID.make(started.session.id)
  try {
    await WithInstance.provide({
      directory: runtimeDirectory(automation.directory),
      fn: () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const messages = yield* sessions.messages({ sessionID })
            // 只看本次运行开始之后的助手消息。**不能只看终态那一条** —— 带工具的运行里
            // 一次模型 step 就落一条 assistant,而运行契约在每一步都会重新注入,
            // 指令很可能出现在中间某条上;只看最后一条会同时漏采(收件箱没摘要)
            // 和漏剥(指令行原样暴露在对话正文里)。
            const candidates = messages.filter(
              (m) => m.info.role === "assistant" && m.info.time.created >= started.run.startedAt,
            )
            let picked: { title?: string; summary?: string } | undefined
            for (const message of candidates) {
              for (const part of message.parts) {
                if (part.type !== "text" || typeof part.text !== "string" || !part.text) continue
                const item = parseInboxItem(part.text)
                if (!item) continue
                // 后出现的覆盖先出现的:模型改主意重写过时,最后那条才是结论
                picked = item
                const stripped = stripInboxDirective(part.text)
                if (stripped !== part.text) yield* sessions.updatePart({ ...part, text: stripped } as typeof part)
              }
            }
            if (picked) yield* Effect.sync(() => Automation.setRunInboxItem(started.run.id, picked!))
          }),
        ),
    })
  } catch (err) {
    log.warn("failed to harvest inbox item", {
      automationID: automation.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// 运行的执行阶段:把触发消息注入会话并等待回合结束,按真实结果落终态。
async function complete(automation: Info, started: Started): Promise<void> {
  if (!started.session) return
  const session = started.session
  try {
    const result = await WithInstance.provide({
      directory: runtimeDirectory(automation.directory),
      fn: () =>
        AppRuntime.runPromise(
          SessionPrompt.Service.use((svc) =>
            svc
              .prompt({
                sessionID: session.id,
                model: started.model.ref,
                // 推理档位:此前 reasoning_effort 落库、可编辑、有 API,但执行时从不接线,
                // 用户改了完全没效果。只在模型真支持该 variant 时才传(见 resolveModel)。
                variant: started.model.variant,
                agent: automation.agent ?? undefined,
                automationID: automation.id,
                parts: [
                  // 用户可见的只有任务本身;元信息头走 synthetic(只进模型输入不落展示),
                  // 避免 thread 模式把内部 Automation ID 刷进用户自己的对话里
                  { type: "text", text: automation.prompt },
                  { type: "text", text: runHeader(automation), synthetic: true },
                ],
              } as unknown as SessionPrompt.PromptInput)
              // 无人值守:整次 prompt(含子会话/doom_loop/workflow)的 ask 兜底为 allow,绝不挂起
              .pipe(Effect.provideService(Permission.FallbackRef, "allow"), Effect.timeout(RUN_TIMEOUT_MS)),
          ),
        ),
    })
    const outcome = runOutcome(result)
    await harvestInboxItem(automation, started)
    Automation.finishRun(started.run.id, { ...outcome, sessionID: session.id })
    // 通知策略 failed_runs_only:成功的运行直接标已读(不产生未读、不通知),
    // 失败的保持未读(对照 Codex 的 vne)。策略为空则一律留未读等用户查看。
    if (automation.notificationPolicy === "failed_runs_only" && outcome.status === "success")
      Automation.setRunRead(started.run.id, true)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // 超时只中断「等待」——回合是 detached 跑的,可能仍在后台跑完并写出回复。
    // 文案要说清这点,否则用户看到红点会以为自动化坏了。
    const timedOut = /TimeoutException|timeout/i.test(raw)
    // 失败路径同样要采集/剥离 ::inbox-item:超时那一刻模型很可能刚把指令写出来,
    // 不剥就原样留在对话正文里 —— thread 模式下直接落在用户自己的对话里。
    await harvestInboxItem(automation, started)
    Automation.finishRun(started.run.id, {
      status: "error",
      sessionID: session.id,
      error: timedOut
        ? `等待自动化运行超过 ${Math.round(RUN_TIMEOUT_MS / 60_000)} 分钟未结束,回合可能仍在后台继续,请打开会话查看`
        : raw,
    })
  }
}

// 执行一次完整运行(手动与调度共用,仅 trigger 与是否推进排期不同)。调度器 await 它以维持 inflight 语义。
// 返回 null = 本轮没跑(排期抢占失败,别的进程已接手)。
export async function execute(input: {
  automation: Info
  trigger: RunTrigger
  // 调度触发在起 run 之前就推进 next_run_at(避免长任务执行期间被重复触发);
  // 手动「立即运行」不动排期(对照 Codex 的 Run now),否则用户点一下按钮就会挤掉一次排期。
  advanceSchedule: boolean
}): Promise<RunInfo | null> {
  const { automation } = input
  if (input.advanceSchedule) {
    // 抢占式推进:必须在建会话之前完成,且只有抢到的进程才继续。
    // 条件更新(next_run_at 仍是我读到的那个值)同时承担两件事 ——
    // 避免长任务执行期间被本进程重复触发,以及跨进程互斥。
    const won = Automation.claimRun(automation.id, automation.nextRunAt, Date.now())
    if (!won) {
      log.info("scheduled run claim lost, another runner took this tick", { automationID: automation.id })
      return null
    }
    // 抢到之后才过门。挡住就把排期改成退避时刻并放弃本轮(不落运行记录,对照 Codex)。
    const blocked = await gate(automation)
    if (blocked) {
      Automation.deferRun(automation.id, blocked.nextRunAt)
      log.info("scheduled run skipped by gate", {
        automationID: automation.id,
        reason: blocked.reason,
        nextRunAt: blocked.nextRunAt,
      })
      return null
    }
  }
  const started = await begin(input)
  // 真的跑起来了才推进「上次运行」——它是冷却基线。被门挡住、以及准备阶段就失败
  // (session 为 null,prompt 从未发出)的那次都不算「跑过」:提前写会让
  // 「用户刚在该对话活动过就不打断」的冷却整体往后偏移一个完整间隔。
  if (started.session) Automation.markLastRun(automation.id, Date.now())
  await complete(automation, started)
  return started.run
}

// 在实例上下文里跑门禁。非 thread 模式无门可过。
async function gate(automation: Info): Promise<GateBlock | null> {
  if (automation.executionEnvironment !== "thread" || !automation.threadSessionID) return null
  return WithInstance.provide({
    directory: runtimeDirectory(automation.directory),
    fn: () => AppRuntime.runPromise(threadGate(automation)),
  })
}

// 手动触发一次自动化运行(供 Hono 路由与 experimental HttpApi handler 共用):
// 同步完成建会话与运行记录后立即返回,回合在后台跑完再落终态。自动化不存在返回 null。
export async function triggerManualRun(id: AutomationID): Promise<RunInfo | null> {
  const automation = Automation.get(id)
  if (!automation) return null
  // 连点去重:详情页/列表页的「运行」按钮点完不禁用,以前连点四下会起四个并发会话、
  // 四条运行记录、四份计费。已有在跑的运行时直接把它回给前端。
  const running = Automation.activeRun(id, RUN_TIMEOUT_MS)
  if (running) {
    log.info("manual run skipped, already running", { automationID: id, runID: running.id })
    return running
  }
  // 手动触发也要过门,但结果要**响亮**:用户是明确点了「运行」的,不能像调度那样静默跳过。
  // 落一条 error 运行记录让详情页显示原因(对照 Codex 手动 Run now 抛
  // `Heartbeat thread is busy right now.` 给 UI)。
  const blocked = await gate(automation)
  if (blocked) {
    const failed = Automation.startRun({ automationID: id, trigger: "manual", directory: automation.directory })
    Automation.finishRun(failed.id, { status: "error", error: gateMessage(blocked.reason) })
    log.info("manual run skipped by gate", { automationID: id, reason: blocked.reason })
    return { ...failed, status: "error", error: gateMessage(blocked.reason), finishedAt: Date.now() }
  }
  const started = await begin({ automation, trigger: "manual", advanceSchedule: false })
  void complete(automation, started).catch((err) =>
    log.error("manual automation run failed", {
      automationID: id,
      error: err instanceof Error ? err.message : String(err),
    }),
  )
  return started.run
}
