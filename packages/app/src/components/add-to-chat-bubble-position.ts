const BUBBLE_HEIGHT = 33
export const ADD_TO_CHAT_BUBBLE_WIDTH = 112
const BUBBLE_MARGIN = 8
const BUBBLE_GAP = 8
const BUBBLE_VISIBLE_HALF_WIDTH = Math.ceil(ADD_TO_CHAT_BUBBLE_WIDTH * 1.15 / 2)

export function addToChatBubblePosition(rect: DOMRect, viewportWidth = window.innerWidth) {
  const top =
    rect.top - BUBBLE_HEIGHT - BUBBLE_GAP > 0 ? rect.top - BUBBLE_HEIGHT - BUBBLE_GAP : rect.bottom + BUBBLE_GAP
  const left = Math.min(
    Math.max(BUBBLE_MARGIN + BUBBLE_VISIBLE_HALF_WIDTH, rect.left + rect.width / 2),
    viewportWidth - BUBBLE_MARGIN - BUBBLE_VISIBLE_HALF_WIDTH,
  )
  return { top, left }
}
