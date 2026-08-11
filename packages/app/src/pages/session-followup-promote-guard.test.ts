import { describe, expect, test } from "bun:test"

describe("压缩中 promoteFollowupToSteer 函数入口短路", () => {
  test("入口第一条可执行语句就是压缩短路守卫，其前不能有任何副作用", async () => {
    const source = await Bun.file(new URL("./session.tsx", import.meta.url)).text()

    // 声明形式容忍无害重构：const 箭头函数或 function 声明皆可，参数改名/换行也不受影响——
    // 只锚定“函数体在哪开始”，不锚定具体书写方式。
    const declarationPattern =
      /(?:const\s+promoteFollowupToSteer\s*=\s*\([^)]*\)\s*=>|function\s+promoteFollowupToSteer\s*\([^)]*\))\s*\{/
    const declarationMatch = declarationPattern.exec(source)
    expect(declarationMatch).not.toBeNull()
    const bodyStart = declarationMatch!.index + declarationMatch![0].length

    // 只截取函数体开头一小段（注释 + 守卫足够，不需要覆盖到函数结尾），刻意不依赖后续语句
    // 具体怎么写——这样即使 guard 之后的代码被重构（改名/重排/新增语句），断言依然只关心
    // "守卫是不是第一条可执行语句"这一件事，避免像旧版那样锚定某个具体的"下一条语句"文本。
    const bodyPrefix = source.slice(bodyStart, bodyStart + 400)
    const executableLines = bodyPrefix
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"))

    // 短路必须是函数体的第一条可执行语句：其前不能有插入乐观气泡、setFollowup 等任何副作用，
    // 否则压缩期间点击会先留下鬼气泡，再被后面的预检挡下却不会 unstage。
    expect(executableLines[0]).toBe("if (sessionCompacting(sessionID)) return")
  })
})
