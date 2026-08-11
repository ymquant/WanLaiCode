import type { InstalledOpener } from "@/context/platform"
import { createSignal } from "solid-js"

const DEFAULT_OPENER_KEY = "wanlaicode.default-editor-opener-id"
const [defaultEditorOpenerID, setDefaultEditorOpenerID] = createSignal<string | undefined>(readStoredDefaultOpenerID())

function readStoredDefaultOpenerID() {
  if (typeof localStorage === "undefined") return undefined
  try {
    return localStorage.getItem(DEFAULT_OPENER_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function setDefaultEditorOpener(opener: InstalledOpener) {
  setDefaultEditorOpenerID(opener.id)
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(DEFAULT_OPENER_KEY, opener.id)
  } catch {
    // 默认编辑器偏好只影响打开入口；存储失败时保持本次打开动作，不阻断用户。
  }
}

export function clearDefaultEditorOpener() {
  setDefaultEditorOpenerID(undefined)
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(DEFAULT_OPENER_KEY)
  } catch {
    // 清理偏好失败时仅保留当前进程内默认值，不影响打开文件。
  }
}

export function getDefaultEditorOpener(openers: InstalledOpener[]) {
  const editors = openers.filter((opener) => opener.kind === "editor")
  if (editors.length === 0) return undefined
  const stored = defaultEditorOpenerID()
  return editors.find((opener) => opener.id === stored) ?? editors.find((opener) => opener.id.toLowerCase().includes("cursor")) ?? editors[0]
}

export function orderOpenersByDefaultEditor(openers: InstalledOpener[]) {
  const selected = getDefaultEditorOpener(openers)
  if (!selected) return openers
  // 文件右键菜单和输入框点击都取列表里的首个 editor；这里统一把用户选过的默认编辑器排到最前面。
  return [selected, ...openers.filter((opener) => opener.id !== selected.id)]
}
