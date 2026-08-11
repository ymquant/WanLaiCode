import { Cause, Effect, Layer, Context, Schema } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { access, readdir, stat } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Git } from "@/git"
import { lazy } from "@/util/lazy"
import { Config } from "@/config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { WatcherBuffer, parcelKindToEvent } from "./watcher-coalesce"
import * as Log from "@opencode-ai/core/util/log"
import { which } from "../util/which"

declare const OPENCODE_LIBC: string | undefined

const log = Log.create({ service: "file.watcher" })
const SUBSCRIBE_TIMEOUT_MS = 10_000
// parcel 回调按窗口缓冲再 flush：去重高频重复变更，编译等风暴场景避免逐条广播。
const WATCHER_FLUSH_MS = 100
// 单次 flush 唯一路径超过该上限时，折叠成父目录 change 事件，防止事件总线/SSE/渲染进程被打爆。
const WATCHER_FLUSH_CAP = 2000

export const Event = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    Schema.Struct({
      file: Schema.String,
      event: Schema.Literals(["add", "change", "unlink"]),
    }),
  ),
  // 运行时检测到 worktree 的 git 状态发生变化（用户在已打开的项目里 `git init` / `git clone`
  // 或反向的 `rm -rf .git`）。Project 监听该事件后会重新跑 fromDirectory：
  //   - 新增 .git: DB.vcs 由 undefined 切到 "git"，前端出现分支选择器
  //   - 移除 .git: DB.vcs 切回 undefined（fromDirectory 内部 fakeVcs 兜底），前端隐藏分支选择器
  WorktreeVcsChanged: BusEvent.define(
    "file.watcher.worktree_vcs_changed",
    Schema.Struct({
      directory: Schema.String,
      vcs: Schema.optional(Schema.Literals(["git"])),
    }),
  ),
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch (error) {
    log.error("failed to load watcher binding", { error })
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const rel = path.relative(dir, item)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service

    const state = yield* InstanceState.make(
      Effect.fn("FileWatcher.state")(
        function* () {
          if (Flag.WANLAICODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return

          const ctx = yield* InstanceState.context

          log.info("init", { directory: ctx.directory, worktree: ctx.worktree })

          const backend = getBackend()
          if (!backend) {
            log.error("watcher backend not supported", { directory: ctx.directory, platform: process.platform })
            return
          }

          const w = watcher()
          if (!w) return

          log.info("watcher backend", { directory: ctx.directory, platform: process.platform, backend })

          const subs: ParcelWatcher.AsyncSubscription[] = []

          // 缓冲 + 防抖 flush：跨 parcel 批次去重（同一路径保留最后一次 kind），
          // 超阈值时折叠为目录级 change 事件。write/edit 等工具是直接 bus.publish，
          // 不经此回调，故 agent 编辑后的即时刷新不受防抖影响。
          const buffer = new WatcherBuffer()
          let flushTimer: ReturnType<typeof setTimeout> | undefined
          const flush = InstanceState.bind(() => {
            flushTimer = undefined
            for (const evt of buffer.drain(WATCHER_FLUSH_CAP))
              void Bus.publish(Event.Updated, { file: evt.file, event: evt.event })
          })
          // 单个 finalizer 保证顺序：先 await unsubscribe 停掉 parcel 原生事件投递，再清
          // timer/buffer。若拆成两个 finalizer，Effect 的 LIFO 顺序会「先清后退订」，中间窗口
          // parcel 仍可能回调 cb，往已清空 buffer 写入并重建不受追踪的孤儿 flush timer。
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe())))
              if (flushTimer) clearTimeout(flushTimer)
              flushTimer = undefined
              buffer.clear()
            }),
          )
          const cb: ParcelWatcher.SubscribeCallback = InstanceState.bind((err, evts) => {
            if (err) return
            for (const evt of evts) {
              const kind = parcelKindToEvent(evt.type)
              if (kind) buffer.add(evt.path, kind)
            }
            if (!flushTimer) flushTimer = setTimeout(flush, WATCHER_FLUSH_MS)
          })

          const subscribe = (dir: string, ignore: string[]) => {
            const pending = w.subscribe(dir, cb, { ignore, backend })
            return Effect.gen(function* () {
              const sub = yield* Effect.promise(() => pending)
              subs.push(sub)
            }).pipe(
              Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
              Effect.catchCause((cause) => {
                log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                pending.then((s) => s.unsubscribe()).catch(() => {})
                return Effect.void
              }),
            )
          }

          const cfg = yield* config.get()
          const cfgIgnores = cfg.watcher?.ignore ?? []

          yield* Effect.forkScoped(
            subscribe(ctx.directory, [...FileIgnore.watcherPatterns(), ...cfgIgnores, ...protecteds(ctx.directory)]),
          )

          // 不依赖 ctx.project.vcs 缓存：直接 rev-parse 探测当前 worktree，并起一个轻量
          // 轮询追踪 git 状态变化（git init / git clone / rm -rf .git 都能捕捉）。
          const subscribeGitDir = Effect.fn("FileWatcher.subscribeGitDir")(function* (vcsDir: string) {
            if (cfgIgnores.includes(".git") || cfgIgnores.includes(vcsDir)) return false
            const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
              (entry) => entry !== "HEAD",
            )
            yield* subscribe(vcsDir, ignore)
            return true
          })

          const probeGitDir = Effect.fn("FileWatcher.probeGitDir")(function* () {
            const r = yield* git.run(["rev-parse", "--git-dir"], { cwd: ctx.directory })
            if (r.exitCode !== 0) return undefined
            const raw = r.text().trim()
            if (!raw) return undefined
            return path.resolve(ctx.worktree, raw)
          })

          // currentVcsDir 是「当前已知的 .git 绝对路径」缓存，跨两个阶段共享：
          // ① 启动对账：拿初始探测结果对比 DB.vcs，发现不一致就广播一次
          // ② 后台轮询 while-loop：与下一秒探测结果对比，diff 出 git 状态翻转
          let currentVcsDir = yield* probeGitDir()
          if (currentVcsDir) {
            yield* subscribeGitDir(currentVcsDir)
          }

          const dotgitPath = path.join(ctx.directory, ".git")
          const dotgitExists = () =>
            Effect.promise(() =>
              access(dotgitPath).then(
                () => true,
                () => false,
              ),
            )

          // 启动时若实际探测结果与 DB 缓存的 ctx.project.vcs 不一致（典型场景：先前在
          // app 外面手动 rm -rf .git / git init，DB 缓存还停留在旧值），立即对齐一次，
          // 不必等 polling 第一个周期。
          const cachedIsGit = ctx.project.vcs === "git"
          const existsAtStartup = yield* dotgitExists()
          const gitInstalledAtStartup = !!which("git")
          const shouldBeGit = existsAtStartup && gitInstalledAtStartup
          if (shouldBeGit !== cachedIsGit) {
            log.info("worktree vcs mismatch at startup", {
              directory: ctx.directory,
              cached: ctx.project.vcs,
              probed: shouldBeGit ? "git" : undefined,
            })
            void Bus.publish(Event.WorktreeVcsChanged, {
              directory: ctx.directory,
              vcs: shouldBeGit ? "git" : undefined,
            })
            if (currentVcsDir) {
              void Bus.publish(Event.Updated, {
                file: path.join(currentVcsDir, "HEAD"),
                event: "change",
              })
            }
          }

          // 后台轮询：先用 fs.access 廉价探测 worktree/.git 是否存在（微秒级，零子进程），
          // 只在「存在态翻转」时再 spawn `git rev-parse` 拿真正的 vcsDir。这样 1s 间隔
          // 也几乎零开销，对用户来说接近实时（git init / rm -rf .git 一秒内出反馈）。
          // HEAD 文件 mtime 的兜底轮询：parcel-watcher 对「删了又重建的同名 .git」
          // 偶尔会丢事件（旧 inode 的订阅还活着但收不到新 inode 的变化），所以这里
          // 顺手 stat 一下 HEAD，mtime 变了就主动注入合成事件，触发 Vcs 重算分支。
          let lastHeadMtime: number | undefined
          const probeHeadMtime = (dir: string) =>
            Effect.promise(() =>
              stat(path.join(dir, "HEAD")).then(
                (s) => s.mtimeMs,
                () => undefined,
              ),
            )

          yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep("1 second")
                const exists = yield* dotgitExists()
                if (exists === !!currentVcsDir) {
                  // 状态没翻转：若当前是 git，顺手检查 HEAD mtime 兜底分支切换
                  if (currentVcsDir) {
                    const mt = yield* probeHeadMtime(currentVcsDir)
                    if (mt !== undefined && lastHeadMtime !== undefined && mt !== lastHeadMtime) {
                      log.info("HEAD mtime changed", { directory: ctx.directory, mtime: mt })
                      void Bus.publish(Event.Updated, {
                        file: path.join(currentVcsDir, "HEAD"),
                        event: "change",
                      })
                    }
                    if (mt !== undefined) lastHeadMtime = mt
                  }
                  continue
                }
                const nextDir = exists
                  ? ((yield* probeGitDir()) ?? path.resolve(ctx.directory, ".git"))
                  : undefined
                if (nextDir === currentVcsDir) continue
                const prevDir = currentVcsDir
                currentVcsDir = nextDir
                if (nextDir) {
                  yield* subscribeGitDir(nextDir)
                  lastHeadMtime = yield* probeHeadMtime(nextDir)
                } else {
                  lastHeadMtime = undefined
                }
                const gitInstalled = !!which("git")
                log.info("worktree vcs changed", {
                  directory: ctx.directory,
                  from: prevDir,
                  to: nextDir,
                  exists,
                  gitInstalled,
                })
                // 1) 通知 Project 重新探测，刷新 DB.vcs 并广播 project.updated
                void Bus.publish(Event.WorktreeVcsChanged, {
                  directory: ctx.directory,
                  vcs: exists && gitInstalled ? "git" : undefined,
                })
                // 2) Vcs.state 的 HEAD 订阅依赖 file.watcher.updated；parcel-watcher 不会对
                // 已存在文件补发 snapshot，且 .git 被删除时也不会有 HEAD 事件，所以这里手动
                // 注入一次 HEAD 事件，触发分支重读（git 已删除时 git.branch 返回 undefined，
                // value.current 会被清空并广播 BranchUpdated）
                const headPath = nextDir ?? prevDir
                if (headPath) {
                  void Bus.publish(Event.Updated, {
                    file: path.join(headPath, "HEAD"),
                    event: "change",
                  })
                }
              }
            }),
          )
        },
        Effect.catchCause((cause) => {
          log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
      ),
    )

    return Service.of({
      init: Effect.fn("FileWatcher.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Git.defaultLayer))

export * as FileWatcher from "./watcher"
