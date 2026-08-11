import type { TitlebarTheme, WindowsBackdrop } from "../preload/types"

/** 纯函数：titlebar 是否走 glass（透明 overlay + 透明窗口底）。不读真实 OS，便于 Linux CI 覆盖。 */
export function useGlassTitlebar(
  theme: Partial<Pick<TitlebarTheme, "glass">> = {},
  backdrop: WindowsBackdrop,
) {
  return theme.glass === true && backdrop === "mica"
}

/** 纯函数：setTitlebar 应写入的窗口底色。glass+mica 用透明底，否则用主题实色。 */
export function resolveTitlebarWindowBackground(
  theme: Partial<Pick<TitlebarTheme, "glass" | "backgroundColor">> = {},
  backdrop: WindowsBackdrop,
  transparentBg = "#00000000",
) {
  if (useGlassTitlebar(theme, backdrop)) return transparentBg
  return theme.backgroundColor
}
