import { isDefaultTitle as isDefaultTerminalTitle } from "@/context/terminal-title"

export const canShellOwnTitle = (input: { shellOwnsTitle?: boolean }) => {
  if (input.shellOwnsTitle === false) return false
  return true
}

export const terminalTabLabel = (input: {
  title?: string
  titleNumber?: number
  projectName?: string
  shellOwnsTitle?: boolean
  t: (key: string, vars?: Record<string, string | number | boolean>) => string
}) => {
  const title = input.title ?? ""
  const number = input.titleNumber ?? 0
  const isDefaultTitle = Number.isFinite(number) && number > 0 && isDefaultTerminalTitle(title, number)

  if (input.projectName && number > 0 && (isDefaultTitle || input.shellOwnsTitle === true)) {
    return `${input.projectName} ${number}`
  }
  if (title && !isDefaultTitle) return title
  if (number > 0) return input.t("terminal.title.numbered", { number })
  if (title) return title
  return input.t("terminal.title")
}
