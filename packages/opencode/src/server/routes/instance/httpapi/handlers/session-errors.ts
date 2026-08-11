import { NotFoundError } from "@/storage/storage"
import { Effect } from "effect"
import * as ApiError from "../errors"

type StorageNotFound = InstanceType<typeof NotFoundError>

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFound, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.data.message)))
}

export function mapThrownStorageNotFound<A>(run: () => A) {
  return Effect.try({
    try: run,
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      NotFoundError.isInstance(error) ? Effect.fail(ApiError.notFound(error.data.message)) : Effect.die(error),
    ),
  )
}
