import { BusEvent } from "@/bus/bus-event"
import { Context, Schema } from "effect"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

export const Info = Schema.Literals(["ask", "auto_review", "full_access"])
  .annotate({ identifier: "PermissionMode" })
  .pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Info = Schema.Schema.Type<typeof Info>

export const resolve = (value: Info | undefined): Info => value ?? "auto_review"

export const Ref = Context.Reference<Info>("@opencode/PermissionMode", {
  defaultValue: () => resolve(undefined),
})

export const Event = {
  Updated: BusEvent.define("permission.mode.updated", Schema.Struct({ mode: Info })),
}

export * as PermissionMode from "./mode"
