import { createEffect, onCleanup } from "solid-js"
import { useLocal } from "@/context/local"
import { releaseQuickChatModelSelection, updateQuickChatModelSelection } from "@/utils/quick-chat"

// 只做模型快照同步，不引入 Dock 界面：全局 Dock 在 LocalProvider 之外，
// 拿不到目录级的当前模型，只能由目录内的这个空组件把选择推给快捷聊天。
// 离开目录时释放快照，避免根级继续沿用已离开目录的模型而不是全局最近使用的模型。
export function QuickChatModelBridge() {
  const local = useLocal()
  const owner = Symbol("quick-chat-model-bridge")

  createEffect(() => {
    const model = local.model.current()
    if (!model) {
      releaseQuickChatModelSelection(owner)
      return
    }
    updateQuickChatModelSelection(
      {
        model: {
          providerID: model.provider.id,
          modelID: model.id,
          variant: local.model.variant.current(),
        },
      },
      owner,
    )
  })

  onCleanup(() => releaseQuickChatModelSelection(owner))

  return null
}
