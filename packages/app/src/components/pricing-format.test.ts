import { describe, expect, test } from "bun:test"
import { perMillionTokenCurrencyLabel } from "./pricing-format"

describe("perMillionTokenCurrencyLabel", () => {
  const t = (key: string) =>
    ({
      "model.pricing.unit.cny": "￥",
      "model.pricing.suffix": "/MTok",
      "model.pricing.suffix.short": "/M",
    })[key] ?? key

  test("formats per-token pricing with per-million suffixes", () => {
    expect(perMillionTokenCurrencyLabel({ currency: "CNY", unit: "per_1m_tokens" }, t)).toEqual({
      symbol: "￥",
      suffix: "/MTok",
      shortSuffix: "/M",
    })
  })

  test("does not render per-million labels for task pricing", () => {
    expect(perMillionTokenCurrencyLabel({ currency: "CNY", unit: "per_task" }, t)).toBeUndefined()
  })
})
