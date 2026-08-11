import {
  CommitFailedError,
  CreatePullRequestFailedError,
  PushFailedError,
} from "@/project/vcs"
import { GenerateFailedError, sanitizeGenerateErrorMessage } from "@/project/vcs-generate"
import { Effect } from "effect"
import * as ApiError from "../errors"

const messageFrom = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function mapCommitError(cause: unknown) {
  if (CommitFailedError.isInstance(cause)) return ApiError.vcsCommitFailed(cause.data.message)
  return ApiError.vcsCommitFailed(messageFrom(cause))
}

export function mapPushError(cause: unknown) {
  if (PushFailedError.isInstance(cause)) return ApiError.vcsPushFailed(cause.data.message)
  return ApiError.vcsPushFailed(messageFrom(cause))
}

export function mapCreatePullRequestError(cause: unknown) {
  if (CreatePullRequestFailedError.isInstance(cause)) {
    return ApiError.vcsCreatePullRequestFailed(cause.data.message)
  }
  return ApiError.vcsCreatePullRequestFailed(messageFrom(cause))
}

export function mapGenerateError(cause: unknown) {
  return ApiError.vcsGenerateFailed(sanitizeGenerateErrorMessage(cause))
}

export function mapCommitErrors<A, R>(self: Effect.Effect<A, InstanceType<typeof CommitFailedError>, R>) {
  return self.pipe(Effect.mapError(mapCommitError))
}

export function mapPushErrors<A, R>(self: Effect.Effect<A, InstanceType<typeof PushFailedError>, R>) {
  return self.pipe(Effect.mapError(mapPushError))
}

export function mapCreatePullRequestErrors<A, R>(
  self: Effect.Effect<A, InstanceType<typeof CreatePullRequestFailedError>, R>,
) {
  return self.pipe(Effect.mapError(mapCreatePullRequestError))
}

export function mapGenerateErrors<A, R>(self: Effect.Effect<A, InstanceType<typeof GenerateFailedError>, R>) {
  return self.pipe(Effect.mapError(mapGenerateError))
}
