const ADD_TO_CHAT_ASSISTANT_COMPONENTS = new Set([
  "assistant-message",
  "session-turn",
  "text-part",
  "reasoning-part",
  "tool-part-wrapper",
  "bash-output",
  "activity-tool-group-trigger",
  "activity-tool-group-list",
  "activity-edit-preview",
  "session-turn-diffs-group",
  "session-turn-diffs-content",
])
const ADD_TO_CHAT_ASSISTANT_SLOTS = new Set([
  "session-turn-assistant-content",
  "session-turn-diffs",
  "session-turn-diffs-header",
  "session-turn-diff-trigger",
  "session-turn-diff-view",
  "basic-tool-tool-title",
  "basic-tool-tool-subtitle",
  "basic-tool-tool-arg",
  "basic-tool-tool-action",
  "activity-tool-item-row",
  "activity-tool-item-prefix",
  "activity-tool-item-command",
  "activity-tool-item-desc",
  "activity-tool-item-file",
  "activity-tool-item-diff",
  "bash-header",
  "bash-header-title",
  "bash-copy",
  "bash-command",
  "bash-output-body",
  "bash-empty",
  "bash-scroll",
  "bash-pre",
  "bash-status",
  "bash-status-text",
])
const ADD_TO_CHAT_BLOCKED_COMPONENTS = new Set(["user-message", "prompt-input", "add-to-chat-bubble"])

export function isAssistantConversationContent(node: Node | null): boolean {
  let allowed = false
  let blocked = false
  let el: Node | null = node
  while (el) {
    if (el.nodeType === Node.ELEMENT_NODE) {
      const element = el as HTMLElement
      if (element.dataset.component && ADD_TO_CHAT_BLOCKED_COMPONENTS.has(element.dataset.component)) blocked = true
      if (element.dataset.component && ADD_TO_CHAT_ASSISTANT_COMPONENTS.has(element.dataset.component)) allowed = true
      if (element.dataset.slot && ADD_TO_CHAT_ASSISTANT_SLOTS.has(element.dataset.slot)) allowed = true
    }
    el = el.parentNode
  }
  return !blocked && allowed
}
