import { describe, expect, test } from "bun:test"
import {
  ENVIRONMENT_NAME_MAX_LENGTH,
  normalizeProjectName,
  PROJECT_NAME_MAX_LENGTH,
  projectNamePatch,
} from "./project-name"

describe("normalizeProjectName", () => {
  test("清空名称归一成空串，而不是 undefined", () => {
    // 传 undefined 会被后端 Drizzle 的 .set() 跳过，旧名字留在库里 —— 用户看到「已保存」但刷新后旧名字回来
    expect(normalizeProjectName("", "my-project")).toBe("")
    expect(normalizeProjectName("   ", "my-project")).toBe("")
  })

  test("填回 worktree basename 等价于恢复默认，归一成空串", () => {
    expect(normalizeProjectName("my-project", "my-project")).toBe("")
    expect(normalizeProjectName("  my-project  ", "my-project")).toBe("")
  })

  test("自定义名称原样保留并去掉首尾空格", () => {
    expect(normalizeProjectName("  线上环境  ", "my-project")).toBe("线上环境")
  })

  // 回归：归一层不得截断。存量长名称在「只改脚本」的保存里会原样流过这里，
  // 一旦在此截断，用户没碰过的名字会被静默改短并写回后端。
  test("存量超长名称原样保留，不被截断", () => {
    const long = "a".repeat(PROJECT_NAME_MAX_LENGTH + 20)
    expect(normalizeProjectName(long, "my-project")).toBe(long)
  })

  // 回归：超长 basename。若归一层先截断再比较，截断值不等于完整 basename，
  // 就会被误当成自定义名称持久化，而不是归一为默认名。
  test("超长 basename 仍能归一成空串", () => {
    const folder = "b".repeat(PROJECT_NAME_MAX_LENGTH + 20)
    expect(normalizeProjectName(folder, folder)).toBe("")
  })

  test("大小写与 basename 不同则视为自定义名称", () => {
    expect(normalizeProjectName("My-Project", "my-project")).toBe("My-Project")
  })
})

describe("projectNamePatch", () => {
  const LONG = "a".repeat(PROJECT_NAME_MAX_LENGTH + 20)

  // 这一组是本 PR 真正要守住的东西：只改脚本/环境变量时，name 这个键
  // 必须整个不存在。用 "name" in patch 而不是 patch.name === undefined 断言 ——
  // 后者对 { name: undefined } 也成立，而那个值会把本地缓存的名字清掉。
  test("未修改名称时不产生 name 键", () => {
    const patch = projectNamePatch(LONG, "my-project", false)
    expect("name" in patch).toBe(false)
    expect(patch).toEqual({})
  })

  // 这两条必须用 "name" in patch 断言，不能只用 toEqual({})：
  // toEqual 会把 { name: undefined } 判定为等于 {}，而这两者在下游行为完全不同 ——
  // 前者会把本地缓存的名字清成 undefined。实测过：只写 toEqual 时该 bug 能存活。
  test("存量超长名称在只改脚本的保存中不被写回", () => {
    expect("name" in projectNamePatch(LONG, "my-project", false)).toBe(false)
  })

  test("超长 basename 在只改脚本的保存中不被写回", () => {
    const folder = "b".repeat(PROJECT_NAME_MAX_LENGTH + 20)
    expect("name" in projectNamePatch(folder, folder, false)).toBe(false)
  })

  test("修改过的超长自定义名称原样写回，不被截断", () => {
    expect(projectNamePatch(LONG, "my-project", true)).toEqual({ name: LONG })
  })

  test("修改过名称才写回，且带上 name 键", () => {
    const patch = projectNamePatch("线上环境", "my-project", true)
    expect("name" in patch).toBe(true)
    expect(patch).toEqual({ name: "线上环境" })
  })

  test("修改过并清空时写回空串，用于真正清掉后端名字", () => {
    expect(projectNamePatch("", "my-project", true)).toEqual({ name: "" })
    expect(projectNamePatch("   ", "my-project", true)).toEqual({ name: "" })
  })

  test("修改过但填回 basename 时写回空串，等价恢复默认", () => {
    expect(projectNamePatch("my-project", "my-project", true)).toEqual({ name: "" })
  })

  test("修改过的超长 basename 仍归一成空串而非截断值", () => {
    const folder = "c".repeat(PROJECT_NAME_MAX_LENGTH + 20)
    expect(projectNamePatch(folder, folder, true)).toEqual({ name: "" })
  })
})

describe("名称长度常量", () => {
  // 项目名（数据库 project.name）与环境名（environment.toml 的 environmentName）
  // 是两套独立存储，必须各自持有常量。这条测试守的是「不要再合并回一个常量」。
  test("项目名与环境名各自独立声明", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(40)
    expect(ENVIRONMENT_NAME_MAX_LENGTH).toBe(40)
  })
})

// 这一组是源码文本扫描，对「行为」是弱证据，但它守的恰好是行为测试守不住的东西：
// 项目名有三个写入入口（表单页 / 侧栏弹窗 / 侧栏内联编辑），三者都走 renameProject
// 或 project.update。自审时发现内联编辑那个入口漏了长度约束 —— 后端 zod 是
// z.string().optional() 无上限，漏掉就能把任意长度直接写进库。
// 单测无法渲染这三个组件去断言 DOM，因此退一步用源码断言「约束还在」。
describe("项目改名入口的长度约束覆盖", () => {
  // 用 Bun.file 而非 node:fs —— AGENTS.md L128「优先用 Bun API，例如 Bun.file()」，
  // 且仓库既有的源码扫描测试（binary-placeholder / docx-preview 等）都是这个写法。
  const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text()

  test("表单页 project-edit 绑定了 PROJECT_NAME_MAX_LENGTH", async () => {
    const src = await read("../pages/project-edit.tsx")
    expect(src).toContain("maxLength={PROJECT_NAME_MAX_LENGTH}")
  })

  test("侧栏改名弹窗绑定了 PROJECT_NAME_MAX_LENGTH", async () => {
    const src = await read("../pages/layout/codex-sidebar/rename-project-dialog.tsx")
    expect(src).toContain("maxLength={PROJECT_NAME_MAX_LENGTH}")
  })

  test("侧栏内联编辑绑定了 PROJECT_NAME_MAX_LENGTH", async () => {
    const src = await read("../pages/layout.tsx")
    expect(src).toContain("maxLength={PROJECT_NAME_MAX_LENGTH}")
  })

  test("InlineEditor 把 maxLength 透到原生 input 上", async () => {
    const src = await read("../pages/layout/inline-editor.tsx")
    expect(src).toContain("maxLength?: number")
    expect(src).toContain("maxLength={props.maxLength}")
  })
})
