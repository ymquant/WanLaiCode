type Rgb = { r: number; g: number; b: number }

export function parseCssColor(input: string): Rgb | undefined {
  const v = input.trim()
  const hex = v.startsWith("#") ? v.slice(1) : undefined
  if (hex) {
    const full =
      hex.length === 3
        ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
        : hex.length === 6
          ? hex
          : undefined
    if (!full) return undefined
    const n = Number.parseInt(full, 16)
    if (!Number.isFinite(n)) return undefined
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
  }

  const m = v.match(/rgba?\(([^)]+)\)/i)
  if (!m) return undefined
  const parts = m[1].split(",").map((x) => x.trim())
  if (parts.length < 3) return undefined
  const r = Number.parseFloat(parts[0])
  const g = Number.parseFloat(parts[1])
  const b = Number.parseFloat(parts[2])
  if (![r, g, b].every((n) => Number.isFinite(n))) return undefined
  return { r, g, b }
}

export function mixWithBlack(color: string, alpha: number, resolve?: (value: string) => string) {
  const rgb = parseCssColor(color) ?? (resolve ? parseCssColor(resolve(color)) : undefined)
  if (!rgb) return color
  const a = Math.min(1, Math.max(0, alpha))
  const r = Math.round(rgb.r * (1 - a))
  const g = Math.round(rgb.g * (1 - a))
  const b = Math.round(rgb.b * (1 - a))
  return `rgb(${r}, ${g}, ${b})`
}

export type DialogTitlebarChromeInput = {
  active: boolean
  themeId: string | undefined
  desktopOs: string | undefined
  windowsBackdrop: string | undefined
  backgroundColor: string
  colorScheme: "light" | "dark"
  resolveColor?: (value: string) => string
}

/** Dialog 打开时 titlebar 压暗策略：仅 wanlai + windows + mica 跳过（避免透明侧栏闪烁）。 */
export function resolveDialogTitlebarChrome(input: DialogTitlebarChromeInput) {
  const wanlaiGlass = input.themeId === "wanlai-theme" && input.desktopOs === "windows"
  const mica = input.windowsBackdrop === "mica"
  // 闪烁只发生在 glass 透明侧栏透出窗口底色时；其它 Windows 路径仍压暗原生 caption。
  const skipDialogDim = input.active && wanlaiGlass && mica
  const alpha = input.colorScheme === "dark" ? 0.5 : 0.2
  const glass = skipDialogDim ? true : !input.active && wanlaiGlass
  const backgroundColor = skipDialogDim
    ? input.backgroundColor
    : input.active
      ? mixWithBlack(input.backgroundColor, alpha, input.resolveColor)
      : input.backgroundColor
  return { glass, backgroundColor, skipDialogDim }
}
