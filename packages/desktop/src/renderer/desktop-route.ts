/**
 * 将 Electron 的入口地址规范化为应用路由，避免刷新时把 /index.html 当成未知页面。
 */
export function desktopRouteFromLocation(pathname: string, search = "", hash = "") {
  if (!pathname || pathname === "/" || pathname === "/index.html") return `/${search}${hash}`
  return `${pathname}${search}${hash}`
}

/**
 * 将内存路由写回真实地址，让桌面端刷新后仍能恢复当前会话和深链位置。
 */
export function desktopAddressForRoute(route: string, currentPathname: string) {
  if (!route || route === "/") return currentPathname === "/index.html" ? "/index.html" : "/"
  if (currentPathname === "/index.html" && (route.startsWith("/?") || route.startsWith("/#"))) {
    return `/index.html${route.slice(1)}`
  }
  return route
}
