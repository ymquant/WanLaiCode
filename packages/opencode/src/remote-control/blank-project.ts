import { execFile } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const blankProjectGitTimeoutMs = 3_000

export const blankProjectDefaultBase = "New project"

// Electron IPC 与远控 sidecar 位于不同进程；这里保持桌面端相同的 Documents 默认目录。
export function blankProjectParent(parent?: string) {
  const trimmed = parent?.trim()
  if (trimmed && /[\u0000-\u001F\u007F]/.test(trimmed)) throw new Error("Invalid project path")
  return trimmed || join(homedir(), "Documents")
}

// 手机输入会先即时校验，远控桌面仍必须独立拒绝非法字符和路径片段。
export function sanitizeBlankProjectFolderName(name: string) {
  return name
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]/g, "")
    .replace(/\.+$/, "")
    .trim()
}

export function assertBlankProjectFolderName(name: string) {
  const folder = sanitizeBlankProjectFolderName(name)
  if (!folder || folder === "." || folder === ".." || folder.includes("..") || folder !== name.trim()) {
    throw new Error("Invalid project name")
  }
  // Windows 设备名即使带扩展名也不可作为目录；在其他平台同样拒绝可保证跨平台项目一致。
  if (windowsReserved.test(folder.split(".", 1)[0] ?? "")) throw new Error("Project name is reserved")
  return folder
}

export function resolveBlankProjectTarget(parentInput: string | undefined, name: string) {
  const parent = resolve(blankProjectParent(parentInput))
  const target = resolve(parent, assertBlankProjectFolderName(name))
  const nested = relative(parent, target)
  if (!nested || nested === ".." || nested.startsWith(`..${sep}`)) throw new Error("Invalid project path")
  return target
}

export function blankProjectPathExists(parentInput: string | undefined, name: string) {
  return existsSync(resolveBlankProjectTarget(parentInput, name))
}

// 默认名称与桌面侧边栏一致：New project、New project 2、New project 3……
export function nextBlankProjectFolderName(parent: string, base = blankProjectDefaultBase) {
  let index = 1
  let name = base
  while (existsSync(join(parent, name))) {
    index += 1
    name = `${base} ${index}`
  }
  return name
}

export function prepareBlankProjectDefaults(parentInput?: string) {
  const parent = resolve(blankProjectParent(parentInput))
  // 桌面弹窗打开时会确保用户选择的父目录存在，远控入口保持相同行为。
  mkdirSync(parent, { recursive: true })
  return { parent, name: nextBlankProjectFolderName(parent) }
}

export type BlankProjectCreateOptions = {
  // 测试可替换 Git 命令；生产使用当前桌面环境中的 git，失败或超时都不会影响目录创建。
  gitExecutable?: string
  gitArguments?: string[]
  gitTimeoutMs?: number
}

export async function createBlankProject(
  parentInput: string | undefined,
  name: string,
  options: BlankProjectCreateOptions = {},
) {
  const target = resolveBlankProjectTarget(parentInput, name)
  mkdirSync(resolve(blankProjectParent(parentInput)), { recursive: true })
  try {
    // 非 recursive mkdir 是最终的原子重名检查，不能信任弹窗阶段的 exists 结果。
    mkdirSync(target)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Directory already exists: ${target}`)
    }
    throw error
  }

  // 远控 sidecar 会被打进 Electron 的 Node 主进程，必须使用 Node API，不能依赖 Bun 全局对象。
  const gitArguments = options.gitArguments ?? ["init"]
  await new Promise<void>((complete) => {
    execFile(
      options.gitExecutable ?? "git",
      gitArguments,
      {
        cwd: target,
        // 卡住的 Git 包装脚本必须在手机 RPC 超时前结束，目录创建结果仍按成功返回。
        timeout: options.gitTimeoutMs ?? blankProjectGitTimeoutMs,
      },
      (error) => {
        // 与桌面入口一致：Git 只是增强能力，初始化失败不能阻止空白项目创建。
        if (error) console.warn("[remote-control] blank project git init failed:", error.message)
        complete()
      },
    )
  })
  return target
}

// 将文件系统异常压缩为手机四语文案已经覆盖的稳定错误码。
export function blankProjectErrorCode(error: unknown) {
  if (!(error instanceof Error)) return "create_failed"
  if (error.message.startsWith("Directory already exists:")) return "project_exists"
  if (error.message === "Invalid project name" || error.message === "Project name is reserved") {
    return "invalid_project_name"
  }
  if (error.message === "Invalid project path") return "invalid_project_path"
  return "create_failed"
}
