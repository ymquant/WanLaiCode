import { Schema } from "effect"

export const Pricing = Schema.Struct({
  currency: Schema.String,
  unit: Schema.String,
  input: Schema.Finite,
  output: Schema.Finite,
  cache_write: Schema.optional(Schema.Finite),
  cache_read: Schema.optional(Schema.Finite),
})
export type Pricing = Schema.Schema.Type<typeof Pricing>
