import { describe, expect, test } from "bun:test"

// LocalProvider 需要 providers/models/DataProvider 整条依赖链才能挂载，为一行接线搭这套环境
// 不划算且容易踩 mock.module 的进程级污染。这里只锁住接线本身：档位选择必须同时写全局记录，
// 否则离开目录后只剩 models.recent 可用的场景（快捷聊天）会丢失推理档位。
describe("目录档位选择同步到全局 variant 记录", () => {
  test("variant.set 在写目录级状态的同时写入 models.variant", async () => {
    const source = await Bun.file(new URL("./local.tsx", import.meta.url)).text()
    const setter = source.match(/set\(value: string \| undefined\) \{[\s\S]*?\n {8}\},/)?.[0]

    expect(setter).toBeDefined()
    expect(setter).toContain("write({ variant: value ?? null })")
    expect(setter).toContain("models.variant.set(")
  })
})
