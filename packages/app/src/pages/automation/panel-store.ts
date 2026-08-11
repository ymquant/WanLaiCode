import { createSignal } from "solid-js"

// 会话右侧边栏里打开的「自动化详情面板」。按 sessionKey 作用域,避免跨会话残留:
// 点对话里的内联自动化卡片时 openAutomationPanel(当前会话 key, automationID)。
type OpenState = { sessionKey: string; automationID: string }

const [state, setState] = createSignal<OpenState | undefined>()
// 折叠态:复用标题栏右侧边栏折叠开关切换,折叠时隐藏面板但保留打开状态(可再展开)
const [collapsed, setCollapsed] = createSignal(false)

export const automationPanel = state
export const automationPanelCollapsed = collapsed

export function openAutomationPanel(sessionKey: string, automationID: string) {
  setState({ sessionKey, automationID })
  setCollapsed(false)
}

export function closeAutomationPanel() {
  setState(undefined)
  setCollapsed(false)
}

export function toggleAutomationPanelCollapsed() {
  setCollapsed((v) => !v)
}
