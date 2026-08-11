import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const Event = {
  UserCenterChanged: BusEvent.define(
    "wanlaicode.user-center.changed",
    Schema.Struct({
      resources: Schema.Array(Schema.String),
      reason: Schema.optional(Schema.String),
      product_code: Schema.optional(Schema.String),
    }),
  ),
  UserCenterAuthExpired: BusEvent.define(
    "wanlaicode.user-center.auth.expired",
    Schema.Struct({
      reason: Schema.optional(Schema.String),
      product_code: Schema.optional(Schema.String),
    }),
  ),
}
