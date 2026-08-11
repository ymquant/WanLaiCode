export const IMAGE_GENERATION_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8] as const

export const IMAGE_GENERATION_SIZES = [
  { labelKey: "prompt.imageGeneration.size.auto", value: "auto", hint: "auto · 自动" },
  { labelKey: "prompt.imageGeneration.size.square1k", value: "1024x1024", hint: "1024x1024 · 1:1" },
  { labelKey: "prompt.imageGeneration.size.landscape2k", value: "1536x1024", hint: "1536x1024 · 3:2" },
  { labelKey: "prompt.imageGeneration.size.portrait2k", value: "1024x1536", hint: "1024x1536 · 2:3" },
  { labelKey: "prompt.imageGeneration.size.square2k", value: "2048x2048", hint: "2048x2048 · 1:1" },
  { labelKey: "prompt.imageGeneration.size.landscape4k", value: "3840x2160", hint: "3840x2160 · 16:9" },
  { labelKey: "prompt.imageGeneration.size.portrait4k", value: "2160x3840", hint: "2160x3840 · 9:16" },
] as const

const imageModelPattern = /(?:^|[-_/])(?:gpt-image|dall-e)(?:[-_/]|$)/i
const sizePattern = /^(\d+)\s*[xX×]\s*(\d+)$/
const multiple = 16
const maxEdge = 3840
const maxRatio = 3
const minPixels = 655_360
const maxPixels = 8_294_400

function roundToMultiple(value: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

function floorToMultiple(value: number) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

function ceilToMultiple(value: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple)
}

function normalizeDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1024, height: 1024 }
  }

  let normalizedWidth = roundToMultiple(width)
  let normalizedHeight = roundToMultiple(height)

  const scaleToFit = (scale: number) => {
    normalizedWidth = floorToMultiple(normalizedWidth * scale)
    normalizedHeight = floorToMultiple(normalizedHeight * scale)
  }

  const scaleToFill = (scale: number) => {
    normalizedWidth = ceilToMultiple(normalizedWidth * scale)
    normalizedHeight = ceilToMultiple(normalizedHeight * scale)
  }

  for (let i = 0; i < 4; i++) {
    const edge = Math.max(normalizedWidth, normalizedHeight)
    if (edge > maxEdge) scaleToFit(maxEdge / edge)

    if (normalizedWidth / normalizedHeight > maxRatio) {
      normalizedWidth = floorToMultiple(normalizedHeight * maxRatio)
    }
    if (normalizedHeight / normalizedWidth > maxRatio) {
      normalizedHeight = floorToMultiple(normalizedWidth * maxRatio)
    }

    const pixels = normalizedWidth * normalizedHeight
    if (pixels > maxPixels) scaleToFit(Math.sqrt(maxPixels / pixels))
    if (pixels < minPixels) scaleToFill(Math.sqrt(minPixels / pixels))
  }

  return { width: normalizedWidth, height: normalizedHeight }
}

function matchesImageModel(value: string | undefined) {
  return imageModelPattern.test((value ?? "").replace(/\s+/g, "-"))
}

export function isImageGenerationModel(input: {
  id?: string
  name?: string
  capabilities?: { output?: { text?: boolean; image?: boolean } }
}) {
  if (matchesImageModel(input.id) || matchesImageModel(input.name)) return true
  return input.capabilities?.output?.image === true && input.capabilities.output.text !== true
}

export function imageGenerationSizeParts(value: string) {
  const match = value.match(sizePattern)
  if (!match) return undefined
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  }
}

export function normalizeImageGenerationSize(value: string) {
  if (value === "auto") return value
  const parts = imageGenerationSizeParts(value)
  if (!parts) return "1024x1024"
  const normalized = normalizeDimensions(parts.width, parts.height)
  return `${normalized.width}x${normalized.height}`
}

export function imageGenerationSizeLabel(value: string) {
  const preset = IMAGE_GENERATION_SIZES.find((item) => item.value === value)
  if (preset) return preset.labelKey
  return value
}
