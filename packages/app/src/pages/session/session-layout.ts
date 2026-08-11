import { useLocation, useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { parseSessionId, parseSessionRoute, resolveSessionId } from "./session-route"

export { parseSessionId, parseSessionRoute, resolveSessionId }

export const useSessionKey = () => {
  const params = useParams<{ dir: string; id?: string }>()
  const location = useLocation()
  const id = createMemo(() => resolveSessionId(location.pathname, params.id))
  const sessionKey = createMemo(() => `${params.dir}${id() ? "/" + id() : ""}`)
  return {
    params: new Proxy(params, {
      get(target, prop) {
        if (prop === "id") return id()
        return Reflect.get(target, prop)
      },
    }),
    sessionKey,
  }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey } = useSessionKey()
  return {
    params,
    sessionKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
