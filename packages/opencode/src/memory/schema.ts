import { Data, Schema, Types } from "effect"

import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@/util/effect-zod"
import { optionalOmitUndefined, withStatics } from "@/util/schema"

export const MemoryID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("memory") }).pipe(
  Schema.brand("MemoryID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("memory", id)),
    zod: zod(s),
  })),
)
export type MemoryID = Schema.Schema.Type<typeof MemoryID>

export const Scope = Schema.Literals(["global", "project"])
export type Scope = Schema.Schema.Type<typeof Scope>

export const Draft = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  detail: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Draft = Types.DeepMutable<Schema.Schema.Type<typeof Draft>>

export const Entry = Schema.Struct({
  id: MemoryID,
  scope: Scope,
  name: Schema.String,
  title: Schema.String,
  summary: Schema.String,
})
  .annotate({ identifier: "MemoryEntry" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Entry = Types.DeepMutable<Schema.Schema.Type<typeof Entry>>

export const Detail = Schema.Struct({
  ...Entry.fields,
  document: Schema.String,
})
  .annotate({ identifier: "MemoryDetail" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Detail = Types.DeepMutable<Schema.Schema.Type<typeof Detail>>

export const CreateInput = Schema.Struct({
  scope: Scope,
  content: Schema.String,
  sessionID: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  id: MemoryID,
  document: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const ListInput = Schema.Struct({
  scope: optionalOmitUndefined(Scope),
  search: optionalOmitUndefined(Schema.String),
  limit: optionalOmitUndefined(Schema.Number),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ListInput = Types.DeepMutable<Schema.Schema.Type<typeof ListInput>>

export const ResetInput = Schema.Struct({
  scope: Scope,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ResetInput = Types.DeepMutable<Schema.Schema.Type<typeof ResetInput>>

export class InvalidMemoryError extends Data.TaggedError("InvalidMemoryError")<{ message: string }> {}

export * as Memory from "./schema"
