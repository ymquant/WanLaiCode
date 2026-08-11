import { Glob } from "@opencode-ai/core/util/glob"

const FOLDERS = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "vendor",
  ".npm",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".turbo",
  ".output",
  "desktop",
  ".sst",
  ".cache",
  ".webkit-cache",
  "__pycache__",
  ".pytest_cache",
  "mypy_cache",
  ".history",
  ".gradle",
  ".vs",
])

const FILES = [
  "**/*.swp",
  "**/*.swo",

  "**/*.pyc",

  // OS
  "**/.DS_Store",
  "**/Thumbs.db",

  // Logs & temp
  "**/logs/**",
  "**/tmp/**",
  "**/temp/**",
  "**/*.log",

  // Coverage/test outputs
  "**/coverage/**",
  "**/.nyc_output/**",
]

export const PATTERNS = [...FILES, ...FOLDERS]

// parcel-watcher(wrapper.js normalizeOptions)对 ignore 用 is-glob 区分两类：
//   - 无 glob 字符的裸名 → path.resolve(dir, name) 存 ignorePaths，字面路径剪枝，可靠但
//     只忽略根级 <root>/name，不覆盖嵌套的 <root>/sub/name。
//   - 含 glob 字符 → micromatch.makeRe 转正则存 ignoreGlobs，匹配路径本身；`**/name` 只
//     匹配目录节点，要 `**/name/**` 才能忽略其内容（同本文件既有的 `**/coverage/**`）。
// 故 watcher 订阅用三者并集：裸名保根级可靠忽略（所有后端），两条 glob 尽力覆盖任意深度
// 的嵌套产物目录（monorepo 子包 / Rust crate 的深层 target/build/dist）。是原 PATTERNS 的
// 严格超集，永不劣于基线；真正的风暴兜底在 watcher-coalesce 的去重+阈值折叠。
export function watcherPatterns(): string[] {
  const folders = [...FOLDERS]
  return [...FILES, ...folders, ...folders.map((f) => `**/${f}`), ...folders.map((f) => `**/${f}/**`)]
}

export function match(
  filepath: string,
  opts?: {
    extra?: string[]
    whitelist?: string[]
  },
) {
  for (const pattern of opts?.whitelist || []) {
    if (Glob.match(pattern, filepath)) return false
  }

  const parts = filepath.split(/[/\\]/)
  for (let i = 0; i < parts.length; i++) {
    if (FOLDERS.has(parts[i])) return true
  }

  const extra = opts?.extra || []
  for (const pattern of [...FILES, ...extra]) {
    if (Glob.match(pattern, filepath)) return true
  }

  return false
}

export * as FileIgnore from "./ignore"
