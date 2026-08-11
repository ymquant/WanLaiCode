import { Menu } from "electron"

import { createMainTranslator } from "./i18n"
import type { TrayRecentSession } from "./tray-sessions"

const RECENT_VISIBLE = 3
const RECENT_MORE = 4

type TrayMenuDeps = {
  showMainWindow: () => void
  triggerCommand: (id: string) => void
  openSession: (target: { directory: string; sessionID: string }) => void
  listRecentSessions: () => Promise<TrayRecentSession[]>
  canUseAppCommands: () => boolean
  quit: () => void
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function sessionItemLabel(session: TrayRecentSession) {
  return `${truncate(session.title, 36)}\t${truncate(session.projectName, 20)}`
}

function sessionItems(
  sessions: TrayRecentSession[],
  deps: Pick<TrayMenuDeps, "openSession">,
): Electron.MenuItemConstructorOptions[] {
  return sessions.map((session) => ({
    label: sessionItemLabel(session),
    click: () => deps.openSession({ directory: session.directory, sessionID: session.sessionID }),
  }))
}

export async function buildTrayContextMenu(deps: TrayMenuDeps) {
  const t = createMainTranslator()
  const ready = deps.canUseAppCommands()
  const recent = ready ? await deps.listRecentSessions().catch(() => [] as TrayRecentSession[]) : []
  const template: Electron.MenuItemConstructorOptions[] = []

  if (recent.length > 0) {
    template.push({ label: t("desktop.tray.recent"), enabled: false })
    template.push(...sessionItems(recent.slice(0, RECENT_VISIBLE), deps))
    const more = recent.slice(RECENT_VISIBLE, RECENT_VISIBLE + RECENT_MORE)
    if (more.length > 0) {
      template.push({
        label: t("desktop.tray.more"),
        submenu: sessionItems(more, deps),
      })
    }
    template.push({ type: "separator" })
  }

  if (ready) {
    template.push({
      label: t("command.session.new"),
      click: () => {
        deps.showMainWindow()
        deps.triggerCommand("session.new")
      },
    })
    template.push({ type: "separator" })
  }
  template.push({
    label: t("desktop.tray.open"),
    click: () => deps.showMainWindow(),
  })
  template.push({ type: "separator" })
  template.push({ label: t("command.system.exit"), click: () => deps.quit() })

  return Menu.buildFromTemplate(template)
}
