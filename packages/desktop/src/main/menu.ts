import { Menu, shell } from "electron"
import { brandNameCn } from "@opencode-ai/brand"

import { DEBUG_UPDATER, UPDATER_ENABLED } from "./constants"
import { createMainWindow } from "./windows"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  reload: () => void
  relaunch: () => void
  simulateUpdateCheckFlow?: (scenario: "success" | "cancel" | "error" | "confirm") => void
}

export function createMenu(deps: Deps) {
  if (process.platform !== "darwin") return

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: brandNameCn(),
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          enabled: UPDATER_ENABLED,
          click: () => deps.checkForUpdates(),
        },
        {
          label: "Reload Webview",
          click: () => deps.reload(),
        },
        {
          label: "Restart",
          click: () => deps.relaunch(),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Session", accelerator: "Shift+Cmd+S", click: () => deps.trigger("session.new") },
        { label: "Open Project...", accelerator: "Cmd+O", click: () => deps.trigger("project.open") },
        {
          label: "New Window",
          accelerator: "Cmd+Shift+N",
          click: () => createMainWindow(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", accelerator: "Cmd+B", click: () => deps.trigger("sidebar.toggle") },
        { label: "Toggle Terminal", accelerator: "Ctrl+`", click: () => deps.trigger("terminal.toggle") },
        { label: "Toggle File Tree", click: () => deps.trigger("fileTree.toggle") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(DEBUG_UPDATER && deps.simulateUpdateCheckFlow
          ? ([
              { type: "separator" },
              {
                label: "Simulate Update Full Flow",
                submenu: [
                  { label: "Success (Dialog → Install)", click: () => deps.simulateUpdateCheckFlow?.("success") },
                  { label: "Cancel mid-download", click: () => deps.simulateUpdateCheckFlow?.("cancel") },
                  { label: "Download error", click: () => deps.simulateUpdateCheckFlow?.("error") },
                  { label: "Confirm install (busy sessions)", click: () => deps.simulateUpdateCheckFlow?.("confirm") },
                ],
              },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Back", accelerator: "Cmd+[", click: () => deps.trigger("common.goBack") },
        { label: "Forward", accelerator: "Cmd+]", click: () => deps.trigger("common.goForward") },
        { type: "separator" },
        {
          label: "Previous Session",
          accelerator: "Option+Up",
          click: () => deps.trigger("session.previous"),
        },
        {
          label: "Next Session",
          accelerator: "Option+Down",
          click: () => deps.trigger("session.next"),
        },
        { type: "separator" },
        {
          label: "Previous Project",
          accelerator: "Cmd+Option+Up",
          click: () => deps.trigger("project.previous"),
        },
        {
          label: "Next Project",
          accelerator: "Cmd+Option+Down",
          click: () => deps.trigger("project.next"),
        },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "WanLaiCodex Documentation", click: () => shell.openExternal("https://doc.wanlai.ai/") },
        { label: "Support Forum", click: () => shell.openExternal("https://wanlai.ai/contact") },
        { type: "separator" },
        { type: "separator" },
        {
          label: "Share Feedback",
          click: () =>
            shell.openExternal("https://wanlai.ai/community/public"),
        },
        {
          label: "Report a Bug",
          click: () => deps.trigger("system.reportIssue"),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
