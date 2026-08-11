import { isImageGenerationModel } from "./image-generation"

export type TextModelCandidate = {
  id: string
  name?: string
  capabilities?: { input?: { text?: boolean }; output?: { text?: boolean; image?: boolean } }
  provider: { id: string }
}

type SelectTextModelInput<T extends TextModelCandidate> = {
  current: T
  models: readonly T[]
  visible: (model: { providerID: string; modelID: string }) => boolean
}

const isTextModel = (model: TextModelCandidate) => {
  if (isImageGenerationModel({ id: model.id, name: model.name, capabilities: model.capabilities })) return false
  return model.capabilities?.input?.text !== false && model.capabilities?.output?.text !== false
}

export function selectTextModel<T extends TextModelCandidate>(input: SelectTextModelInput<T>) {
  if (isTextModel(input.current)) return input.current

  const visible = input.models.filter(
    (model) => isTextModel(model) && input.visible({ providerID: model.provider.id, modelID: model.id }),
  )
  return visible.find((model) => model.provider.id === input.current.provider.id) ?? visible[0]
}
