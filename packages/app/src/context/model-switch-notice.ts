import type { ModelKey, ModelSwitchNotice } from "./local"

export type ModelSwitchNoticeAction =
  | { type: "create"; notice: ModelSwitchNotice }
  | { type: "clear" }
  | { type: "keep" }

// 根据切换前后模型与锚点消息，决定本次模型切换提示的去向：
// - create：真实切换到不同模型且带锚点 → 生成一条内联提示
// - clear ：模型确实变了但没有锚点（如快捷键循环 model.cycle）→ 清掉旧提示，避免与当前模型矛盾
// - keep  ：重新选中同一模型或来源缺失 → 保持现有提示不动
export function resolveModelSwitchNotice(input: {
  from: ModelKey | undefined
  to: ModelKey | undefined
  afterMessageID: string | undefined
}): ModelSwitchNoticeAction {
  const { from, to, afterMessageID } = input
  if (!from || !to) return { type: "keep" }
  if (from.providerID === to.providerID && from.modelID === to.modelID) return { type: "keep" }
  if (afterMessageID) return { type: "create", notice: { afterMessageID, from, to } }
  return { type: "clear" }
}
