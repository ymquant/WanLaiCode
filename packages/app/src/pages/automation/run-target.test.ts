import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { runSessionPath } from "./run-target"

describe("runSessionPath", () => {
  test("手动运行返回会话时给出该会话的路由", () => {
    const dir = "/Users/developer/Library/Application Support/ai.wanlaicode.desktop/wanlaicode/automation/global"
    expect(runSessionPath({ sessionID: "ses_abc", directory: dir })).toBe(`/${base64Encode(dir)}/session/ses_abc`)
  })

  test("缺少 sessionID 或 directory 时不跳转", () => {
    expect(runSessionPath({ sessionID: null, directory: "/tmp/x" })).toBeUndefined()
    expect(runSessionPath({ sessionID: "ses_abc", directory: null })).toBeUndefined()
    expect(runSessionPath(undefined)).toBeUndefined()
    expect(runSessionPath(null)).toBeUndefined()
  })
})
