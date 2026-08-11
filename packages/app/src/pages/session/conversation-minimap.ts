const BASE_STEP = 7
const EDGE_INSET = 7
const ITEM_HALF_HEIGHT = 5

// 引导消息会并入同一个逻辑 turn；即使只剩一个一级锚点，Minimap 也必须保留该 turn 的预览入口。
export const shouldShowConversationMinimap = (total: number) => total > 0

const conversationMinimapStep = (input: { total: number; height: number }) => {
  if (input.total <= 1) return 0
  const height = Math.max(input.height, EDGE_INSET * 2)
  const available = Math.max(0, height - EDGE_INSET * 2)
  return Math.min(BASE_STEP, available / (input.total - 1))
}

export const conversationMinimapTop = (input: { index: number; total: number; height: number }) => {
  const height = Math.max(input.height, EDGE_INSET * 2)
  const step = conversationMinimapStep({ total: input.total, height })
  return (height - step * (input.total - 1)) / 2 + step * input.index
}

export const conversationMinimapIndexAtOffset = (input: { pointer: number; total: number; height: number }) => {
  if (input.total <= 0) return undefined
  const first = conversationMinimapTop({ index: 0, total: input.total, height: input.height })
  const last = conversationMinimapTop({ index: input.total - 1, total: input.total, height: input.height })
  if (input.pointer < first - ITEM_HALF_HEIGHT || input.pointer > last + ITEM_HALF_HEIGHT) return undefined
  if (input.total === 1) return 0

  const step = conversationMinimapStep({ total: input.total, height: input.height })
  if (!step) return 0
  return Math.min(input.total - 1, Math.max(0, Math.round((input.pointer - first) / step)))
}
