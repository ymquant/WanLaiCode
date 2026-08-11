import { describe, test, expect } from "bun:test"
import { internalErrorBody } from "../../src/server/routes/instance/httpapi/middleware/error"
import { publicErrorResponse } from "../../src/server/public-error-response"
import { steerEmptyInput, steerTurnInactive } from "../../src/server/routes/instance/httpapi/errors"
import { SteerEmptyInputError, SteerTurnInactiveError } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"

describe("httpapi internalErrorBody", () => {
  test("不含 stack / 文件路径，reason 为 INTERNAL_ERROR", () => {
    const body = internalErrorBody()
    const text = JSON.stringify(body)
    expect(text).not.toContain("stack")
    expect(text).not.toContain(".js:")
    expect(text).not.toContain("app.asar")
    expect((body as any).data.reason).toBe("INTERNAL_ERROR")
  })

  test("引导目标回合失效时返回可恢复的 409 契约", () => {
    // 保留目标与当前回合，前端才能判断原引导不得静默转投到新回合。
    const error = new SteerTurnInactiveError({
      message: "target turn inactive",
      sessionID: SessionID.descending(),
      expectedTurnID: MessageID.ascending(),
      actualTurnID: MessageID.ascending(),
    })
    expect(publicErrorResponse(steerTurnInactive(error))).toEqual({
      status: 409,
      body: {
        name: "SteerTurnInactiveError",
        data: {
          message: error.message,
          sessionID: error.sessionID,
          expectedTurnID: error.expectedTurnID,
          actualTurnID: error.actualTurnID,
        },
      },
    })
  })

  test("活动回合中的空引导返回 400 且没有 ACK 形状", () => {
    // 空输入错误必须走独立 400 契约，不能被误映射成活动回合失效或成功 ACK。
    expect(publicErrorResponse(steerEmptyInput(new SteerEmptyInputError()))).toEqual({
      status: 400,
      body: {
        name: "SteerEmptyInputError",
        data: { message: "input must not be empty" },
      },
    })
  })
})
