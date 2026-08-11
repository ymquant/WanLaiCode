import { describe, expect, test } from "bun:test"
import path from "path"

// Auth.all() 里 `if (authContent)` 对空串为假,会回落去读宿主机的 auth.json。
// 所以 CI 里写 AUTH_CONTENT: "" 并不能清空凭据 —— self-hosted runner 上只要有人
// 登录过,测试就会拿到真实 token(实测 windows runner 上 ModelsDev 的
// 「public model listing 不带 auth」用例因此必挂)。必须写成空 JSON 对象。
const WORKFLOWS = ["test.yml", "release-test-sheet.yml", "publish.yml"]

describe("CI 凭据隔离", () => {
  for (const name of WORKFLOWS) {
    test(`${name} 用空 JSON 而非空串清空 AUTH_CONTENT`, async () => {
      const file = path.join(import.meta.dir, "../../../.github/workflows", name)
      const src = await Bun.file(file).text()
      for (const key of ["WANLAICODE_AUTH_CONTENT", "OPENCODE_AUTH_CONTENT"]) {
        expect(src, `${name} 缺少 ${key}`).toContain(key)
        expect(src.includes(`${key}: ""`), `${name} 的 ${key} 是空串,不会切断磁盘回落`).toBe(false)
      }
    })
  }
})
