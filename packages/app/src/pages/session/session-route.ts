// 从常驻目录布局的 URL 中解析会话路由；具体会话路由挂在父级之外，不能只依赖 useParams().id。
export function parseSessionRoute(pathname: string) {
  const match = pathname.match(/\/session(?:\/([^/?#]*))?(?:[?#]|$)/)
  return { matched: !!match, id: match?.[1] || undefined }
}

export function parseSessionId(pathname: string): string | undefined {
  return parseSessionRoute(pathname).id
}

// 当前 URL 命中会话路由时优先使用 URL 中的 ID，避免常驻父路由残留的旧参数覆盖新会话。
export function resolveSessionId(pathname: string, routeParam?: string): string | undefined {
  const route = parseSessionRoute(pathname)
  return route.matched ? route.id : routeParam
}
