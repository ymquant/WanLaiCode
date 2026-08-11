export * as ConfigProxy from "./proxy"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Mode = Schema.Literals(["system", "manual", "none"]).annotate({
  description: "Proxy mode. Defaults to none when omitted (no system/env proxy auto-detection).",
})
export type Mode = Schema.Schema.Type<typeof Mode>

export const Info = Schema.Struct({
  mode: Schema.optional(Mode).annotate({
    description: "Proxy mode. Defaults to none when omitted (no system/env proxy auto-detection).",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "Proxy URL used for both HTTP and HTTPS requests in manual mode.",
  }),
  http_url: Schema.optional(Schema.String).annotate({
    description: "Proxy URL used for HTTP requests in manual mode.",
  }),
  https_url: Schema.optional(Schema.String).annotate({
    description: "Proxy URL used for HTTPS requests in manual mode.",
  }),
  no_proxy: Schema.optional(Schema.String).annotate({
    description: "Comma-separated hosts that should bypass the proxy.",
  }),
})
  .annotate({ identifier: "ProxyConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
