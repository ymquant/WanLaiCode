type CapabilityKey = "text" | "image" | "audio" | "video" | "pdf"

const outputOrder: Array<CapabilityKey> = ["text", "image", "audio", "video", "pdf"]

type CapabilityMetaInput = {
  id: string
  type?: string
  capabilities: {
    reasoning?: boolean
    output?: Partial<Record<CapabilityKey, boolean>>
  }
}

function isSeedanceVideoModel(id: string) {
  return /(?:^|[/_-])(?:doubao-)?seedance(?:[/_.-]|$)/i.test(id)
}

export function modelCapabilityMetaKeys(item: CapabilityMetaInput): Array<CapabilityKey | "reasoning"> {
  // 模型列表右侧展示的是模型“输出能力”，不是附件输入能力；reasoning_options/推理档位只说明文本推理能力，
  // 不能把 DeepSeek 这类文本模型误标成图像或视频。
  if (isSeedanceVideoModel(item.id)) return item.capabilities.reasoning ? ["video", "reasoning"] : ["video"]
  const output = item.capabilities.output ?? {}
  const typeKey = outputOrder.find((key) => item.type === key)
  const keys = outputOrder.filter((key) => output[key] || typeKey === key)
  const visible = keys.length ? keys : (["text"] as Array<CapabilityKey>)
  return item.capabilities.reasoning ? [...visible, "reasoning"] : visible
}
