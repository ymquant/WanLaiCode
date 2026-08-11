import { Schema } from "effect"
import type { ErrorMessageMap } from "./localize-message"

export const ErrorMessageMapSchema = Schema.Record(Schema.String, Schema.String)

export type { ErrorMessageMap }
