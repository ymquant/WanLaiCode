import { isImageGenerationModel } from "./image-generation"

export type ImageModelCandidate = {
  id: string
  name?: string
  capabilities?: { output?: { image?: boolean } }
  provider: { id: string }
}

type SelectImageGenerationModelInput<T extends ImageModelCandidate> = {
  current: T
  models: readonly T[]
  visible: (model: { providerID: string; modelID: string }) => boolean
}

const isImageModel = (model: ImageModelCandidate) =>
  isImageGenerationModel({ id: model.id, name: model.name, capabilities: model.capabilities })

const key = (model: ImageModelCandidate) => `${model.provider.id}/${model.id}`.toLowerCase()

export function selectImageGenerationModel<T extends ImageModelCandidate>(input: SelectImageGenerationModelInput<T>) {
  if (isImageModel(input.current)) return input.current

  const visible = input.models.filter(
    (model) => isImageModel(model) && input.visible({ providerID: model.provider.id, modelID: model.id }),
  )
  return (
    visible.find((model) => key(model) === "wanlaicode/gpt-image-2") ??
    visible.find((model) => model.provider.id === input.current.provider.id) ??
    visible.find((model) => /^gpt-image(?:[-_/]|$)/i.test(model.id)) ??
    visible.find((model) => /^dall-e(?:[-_/]|$)/i.test(model.id)) ??
    visible[0]
  )
}
