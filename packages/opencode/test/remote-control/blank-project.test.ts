import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  assertBlankProjectFolderName,
  blankProjectPathExists,
  createBlankProject,
  prepareBlankProjectDefaults,
} from "@/remote-control/blank-project"
import { tmpdir } from "../fixture/fixture"

describe("remote blank project", () => {
  test("使用桌面递增规则生成默认项目名", async () => {
    await using tmp = await tmpdir()
    const parent = join(tmp.path, "Documents")
    mkdirSync(join(parent, "New project"), { recursive: true })
    mkdirSync(join(parent, "New project 2"))

    expect(prepareBlankProjectDefaults(parent)).toEqual({ parent, name: "New project 3" })
  })

  test("创建空目录并在返回前完成 git init", async () => {
    await using tmp = await tmpdir()
    const parent = join(tmp.path, "Documents")
    const path = await createBlankProject(parent, "Demo", {
      // 使用当前 JavaScript 运行时模拟成功初始化，测试不依赖机器是否安装系统 Git。
      gitExecutable: process.execPath,
      gitArguments: ["-e", "require('node:fs').mkdirSync('.git')"],
    })

    expect(path).toBe(join(parent, "Demo"))
    expect(blankProjectPathExists(parent, "Demo")).toBe(true)
    expect(existsSync(join(path, ".git"))).toBe(true)
  })

  test("Git 初始化失败时仍保留可用的空白项目目录", async () => {
    await using tmp = await tmpdir()
    const parent = join(tmp.path, "Documents")
    const target = join(parent, "Broken")

    // Git 不存在只会失去版本控制能力，不能让新建会话入口整体失败。
    await expect(createBlankProject(parent, "Broken", { gitExecutable: join(tmp.path, "missing-git") })).resolves.toBe(
      target,
    )
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(target, ".git"))).toBe(false)
  })

  test("Git 初始化超时时仍快速返回已创建的项目目录", async () => {
    await using tmp = await tmpdir()
    const parent = join(tmp.path, "Documents")
    const target = join(parent, "Slow git")
    const startedAt = Date.now()

    await expect(
      createBlankProject(parent, "Slow git", {
        // 常驻定时器模拟卡住的 Git 包装脚本，短超时验证不会拖到手机 RPC 失败。
        gitExecutable: process.execPath,
        gitArguments: ["-e", "setTimeout(() => {}, 10_000)"],
        gitTimeoutMs: 20,
      }),
    ).resolves.toBe(target)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(existsSync(target)).toBe(true)
  })

  test("拒绝路径字符、穿越片段和带扩展名的 Windows 设备名", () => {
    expect(() => assertBlankProjectFolderName("client/api")).toThrow("Invalid project name")
    expect(() => assertBlankProjectFolderName("..")).toThrow("Invalid project name")
    expect(() => assertBlankProjectFolderName("CON.txt")).toThrow("Project name is reserved")
  })
})
