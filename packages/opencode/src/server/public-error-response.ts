import { Provider } from "@/provider/provider"
import { GenerateFailedError } from "@/project/vcs-generate"
import { CreateBranchFailedError, isVcsOperationFailedError, SwitchBranchFailedError } from "@/project/vcs"
import { NamedError } from "@opencode-ai/core/util/error"
import { NotFoundError } from "@/storage/storage"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { SteerEmptyInputErrorSchema, SteerTurnInactiveErrorSchema } from "./error"

const statusForNamedError = (error: NamedError): ContentfulStatusCode => {
  if (error instanceof NotFoundError) return 404
  if (error instanceof Provider.ModelNotFoundError) return 400
  if (error instanceof GenerateFailedError) return 400
  if (isVcsOperationFailedError(error)) return 400
  if (error.name === "ProviderAuthValidationFailed") return 400
  if (error.name.startsWith("Worktree")) return 400
  return 500
}

const wireShape = (error: unknown) => {
  if (typeof error !== "object" || !error || !("name" in error) || !("data" in error)) return
  const data = (error as { data: unknown }).data
  if (typeof data !== "object" || !data || !("message" in data)) return
  const message = (data as { message: unknown }).message
  if (typeof message !== "string" || !message) return
  return error as { name: string; data: { message: string } }
}

export function publicErrorResponse(error: unknown) {
  if (error instanceof NamedError) {
    return { status: statusForNamedError(error), body: error.toObject() }
  }
  if (error instanceof CreateBranchFailedError) {
    return { status: 400 as const, body: { name: "VcsCreateBranchFailedError", data: { message: error.message } } }
  }
  if (error instanceof SwitchBranchFailedError) {
    return { status: 400 as const, body: { name: "VcsSwitchBranchFailedError", data: { message: error.message } } }
  }
  // 用 OpenAPI 同源 schema 规范化为 plain body，同时拒绝缺少回合字段的同名伪错误。
  const inactiveTurn = SteerTurnInactiveErrorSchema.safeParse(error)
  if (inactiveTurn.success) return { status: 409 as const, body: inactiveTurn.data }
  const emptySteer = SteerEmptyInputErrorSchema.safeParse(error)
  if (emptySteer.success) return { status: 400 as const, body: emptySteer.data }
  const shaped = wireShape(error)
  if (shaped) return { status: 400 as const, body: shaped }
  return undefined
}
