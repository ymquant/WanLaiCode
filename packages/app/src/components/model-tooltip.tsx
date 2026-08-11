import { Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import type { Model as SDKModel } from "@opencode-ai/sdk/v2/client"
import { formatPrice, perMillionTokenCurrencyLabel } from "./pricing-format"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"

type ModelInfo = SDKModel & {
  provider: {
    id: string
    name: string
  }
  latest?: boolean
}

export const ModelTooltip: Component<{ model: ModelInfo; latest?: boolean; free?: boolean }> = (props) => {
  const language = useLanguage()
  const sourceName = (model: ModelInfo) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
  }
  const inputLabel = (value: string) => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "pdf") return language.t("model.input.pdf")
    return value
  }
  const title = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${sourceName(props.model)} ${props.model.name}${suffix}`
  }
  const inputs = () => {
    const input = props.model.capabilities.input
    const order: Array<InputKey> = ["text", "image", "audio", "video", "pdf"]
    const entries = order.filter((key) => input[key]).map((key) => inputLabel(key))
    return entries.length ? entries.join(", ") : undefined
  }
  const reasoning = () =>
    props.model.capabilities.reasoning
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")
  const context = () => language.t("model.tooltip.context", { limit: props.model.limit.context.toLocaleString() })

  const pricing = () => {
    const p = props.model.pricing
    if (!p) return undefined
    const label = perMillionTokenCurrencyLabel(p, language.t)
    if (!label) return undefined
    const { symbol, suffix } = label
    const lines: Array<string> = []
    lines.push(`${language.t("model.pricing.input")}: ${symbol}${formatPrice(p.input)}${suffix}`)
    lines.push(`${language.t("model.pricing.output")}: ${symbol}${formatPrice(p.output)}${suffix}`)
    if (p.cache_read !== undefined && p.cache_read > 0) {
      lines.push(`${language.t("model.pricing.cache_read")}: ${symbol}${formatPrice(p.cache_read)}${suffix}`)
    }
    if (p.cache_write !== undefined && p.cache_write > 0) {
      lines.push(`${language.t("model.pricing.cache_write")}: ${symbol}${formatPrice(p.cache_write)}${suffix}`)
    }
    return lines.length > 0 ? lines : undefined
  }

  return (
    <div class="flex flex-col gap-1 py-1">
      <div class="text-13-medium">{title()}</div>
      <Show when={inputs()}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.allows", { inputs: value() })}
          </div>
        )}
      </Show>
      <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
      <div class="text-12-regular text-text-invert-base">{context()}</div>
      <Show when={pricing()}>
        {(lines) => (
          <div class="flex flex-col gap-0.5 pt-1 border-t border-border-base mt-1">
            <div class="text-12-regular text-text-invert-base">{language.t("model.pricing.label")}:</div>
            {lines().map((line) => (
              <div class="text-12-regular text-text-invert-base">{line}</div>
            ))}
          </div>
        )}
      </Show>
    </div>
  )
}
