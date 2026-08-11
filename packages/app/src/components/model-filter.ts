type ProviderRef = { id: string }

type KeepModelInput = {
  id: string
  provider: ProviderRef
  wanlaicode?: {
    rate_multiplier?: number
  }
}

// 是否展示「免费」标记：只信 WanlaiCode 网关下发的免费倍率。
// 不能按 DeepSeek 名称猜免费，否则旧缓存模型会绕过无套餐拦截。
export const isFreeModel = (model: KeepModelInput) =>
  model.provider.id === "wanlaicode" && model.wanlaicode?.rate_multiplier === 0

// 模型可见性由后端套餐能力和用户手动隐藏状态共同决定；这里不再维护客户端白名单，
// 避免新接入的文本、图片或视频模型因为名称未及时加入列表而被误隐藏。
