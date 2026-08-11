import { resolver } from "hono-openapi"
import z from "zod"
import { NotFoundError } from "@/storage/storage"
import { MessageID, SessionID } from "@/session/schema"

// Hono OpenAPI 需要显式描述 409 body；字段与 Effect HttpApi 的 typed error 保持一致。
export const SteerTurnInactiveErrorSchema = z.object({
  name: z.literal("SteerTurnInactiveError"),
  data: z.object({
    message: z.string(),
    sessionID: SessionID.zod,
    expectedTurnID: MessageID.zod,
    actualTurnID: MessageID.zod.optional(),
  }),
})

// 空 steer 的 400 响应也先经过同源 schema 归一化，避免 legacy Hono 把 Error 实例直接写进 JSON。
export const SteerEmptyInputErrorSchema = z.object({
  name: z.literal("SteerEmptyInputError"),
  data: z.object({
    message: z.string(),
  }),
})

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z
            .object({
              data: z.any(),
              errors: z.array(z.record(z.string(), z.any())),
              success: z.literal(false),
            })
            .meta({
              ref: "BadRequestError",
            }),
        ),
      },
    },
  },
  403: {
    description: "Forbidden",
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(NotFoundError.Schema),
      },
    },
  },
  409: {
    description: "Target turn is no longer active",
    content: {
      "application/json": {
        schema: resolver(SteerTurnInactiveErrorSchema),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
