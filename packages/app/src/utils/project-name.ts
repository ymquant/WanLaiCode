// 项目名称上限：对应数据库 project.name 字段，作用于 project-edit 页和侧栏改名弹窗。
export const PROJECT_NAME_MAX_LENGTH = 40

// 环境名称上限：对应 environment.toml 的 environmentName 字段，是另一套存储。
// 当前取值与项目名称相同，但刻意分开声明 —— 两者语义无关，
// 共用一个常量会导致将来调整项目名上限时静默改掉环境名上限。
export const ENVIRONMENT_NAME_MAX_LENGTH = 40

// 项目/环境名称写回后端前的归一：清空、或填回 worktree basename，都要落成空串。
//
// 后端 Project.update 把 name 无条件塞进 Drizzle 的 .set()，而 Drizzle 会跳过值为
// undefined 的列 —— 所以传 undefined 表示「保留旧名字」，只有空串才能真正清掉。
// 归一成空串后，展示链路的 `if (!base.name)` 分支会回落到 worktree basename，
// 也让「用户没改名」和「用户主动改回默认名」这两种情况得到同一个结果。
//
// 这里刻意不做长度截断：长度是输入层的约束（TextField 的 maxLength + onChange 里的
// slice），归一层拿到的可能是用户根本没碰过的存量值。在这里截断会让「只改脚本」的
// 保存把存量长名称一起改短，也会让超长 basename 因为截断后不等于原值而被误当成
// 自定义名称持久化。
export function normalizeProjectName(input: string, folderName: string) {
  const trimmed = input.trim()
  if (trimmed === folderName) return ""
  return trimmed
}

// 决定这次保存要不要写回 name，返回一个用于展开的 patch。
//
// 必须返回 {} 而不是 { name: undefined }：这条链路上三处对 undefined 的处理规则不一致 ——
//   1. 后端 Project.update 走 Drizzle 的 .set()，跳过 undefined（= 保留旧值）
//   2. 调用方在 produce 里写的 { ...draft[idx], ...patch } 展开，不跳过显式 undefined
//      （= 把本地缓存的名字清成 undefined）
//   3. globalSync.project.meta 内部同样是 { ...previous, ...patch } 合并，也不跳过
// 只有「整个键不存在」才能同时满足三处的「保持不动」语义。
// 注意第 2 条的机制在调用方而非 globalSync.set —— 后者是 Solid store setter 的包装，
// 做的是路径式更新，本身并不展开对象。
//
// touched 必须由调用方按「用户是否真的动过输入框」传入，不能靠比较值推断：
// 输入框初始就被填成后端值或目录名，值相等既可能是没动过，也可能是改回了原样。
export function projectNamePatch(input: string, folderName: string, touched: boolean) {
  if (!touched) return {}
  return { name: normalizeProjectName(input, folderName) }
}
