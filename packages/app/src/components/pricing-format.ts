export const META_SEP = "\u00A0\u00A0\u00A0"

export const formatPrice = (value: number) =>
  value === 0
    ? "0"
    : new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(value)

export const currencyLabel = (currency: string, t: (key: string) => string) => {
  const symbolKey = `model.pricing.unit.${currency.toLowerCase()}`
  return { symbol: t(symbolKey), suffix: t("model.pricing.suffix"), shortSuffix: t("model.pricing.suffix.short") }
}

export const perMillionTokenCurrencyLabel = (
  pricing: { currency: string; unit: string },
  t: (key: string) => string,
) => {
  // 只有 token 单价才使用 /M 单位；任务计费/套餐计费模型不能被误渲染成 0/M。
  if (pricing.unit !== "per_1m_tokens") return undefined
  return currencyLabel(pricing.currency, t)
}
