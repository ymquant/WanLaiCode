import { MessageID, SessionID } from "@/session/schema"
import type { SteerEmptyInputError, SteerTurnInactiveError } from "@/session/prompt"
import { Schema } from "effect"

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}

// Effect HttpApi 必须声明带字段的 409 契约，并与 legacy Hono 的同名响应保持完全一致。
export class ApiSteerTurnInactiveError extends Schema.ErrorClass<ApiSteerTurnInactiveError>("SteerTurnInactiveError")(
  {
    name: Schema.Literal("SteerTurnInactiveError"),
    data: Schema.Struct({
      message: Schema.String,
      sessionID: SessionID,
      expectedTurnID: MessageID,
      actualTurnID: Schema.optional(MessageID),
    }),
  },
  { httpApiStatus: 409 },
) {}

export function steerTurnInactive(error: SteerTurnInactiveError) {
  // domain error 保留完整回合信息，客户端据此决定恢复普通队列，而不是把引导误投到新回合。
  return new ApiSteerTurnInactiveError({
    name: "SteerTurnInactiveError",
    data: {
      message: error.message,
      sessionID: error.sessionID,
      expectedTurnID: error.expectedTurnID,
      ...(error.actualTurnID !== undefined ? { actualTurnID: error.actualTurnID } : {}),
    },
  })
}

// 两套 HTTP 实现共用同一 400 wire shape，确保空 steer 不会被当成 500 或 durable ACK。
export class ApiSteerEmptyInputError extends Schema.ErrorClass<ApiSteerEmptyInputError>("SteerEmptyInputError")(
  {
    name: Schema.Literal("SteerEmptyInputError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export function steerEmptyInput(error: SteerEmptyInputError) {
  return new ApiSteerEmptyInputError({
    name: "SteerEmptyInputError",
    data: { message: error.message },
  })
}

export class ApiVcsCommitFailedError extends Schema.ErrorClass<ApiVcsCommitFailedError>("VcsCommitFailedError")(
  {
    name: Schema.Literal("VcsCommitFailedError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiVcsPushFailedError extends Schema.ErrorClass<ApiVcsPushFailedError>("VcsPushFailedError")(
  {
    name: Schema.Literal("VcsPushFailedError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiVcsCreatePullRequestFailedError extends Schema.ErrorClass<ApiVcsCreatePullRequestFailedError>(
  "VcsCreatePullRequestFailedError",
)(
  {
    name: Schema.Literal("VcsCreatePullRequestFailedError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiVcsGenerateFailedError extends Schema.ErrorClass<ApiVcsGenerateFailedError>("VcsGenerateFailedError")(
  {
    name: Schema.Literal("VcsGenerateFailedError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export function vcsCommitFailed(message: string) {
  return new ApiVcsCommitFailedError({
    name: "VcsCommitFailedError",
    data: { message },
  })
}

export function vcsPushFailed(message: string) {
  return new ApiVcsPushFailedError({
    name: "VcsPushFailedError",
    data: { message },
  })
}

export function vcsCreatePullRequestFailed(message: string) {
  return new ApiVcsCreatePullRequestFailedError({
    name: "VcsCreatePullRequestFailedError",
    data: { message },
  })
}

export function vcsGenerateFailed(message: string) {
  return new ApiVcsGenerateFailedError({
    name: "VcsGenerateFailedError",
    data: { message },
  })
}
