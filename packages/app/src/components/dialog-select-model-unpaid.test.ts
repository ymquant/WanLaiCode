import { describe, expect, test } from "bun:test"
import { shouldShowWanlaiCodeLoginError } from "./wanlaicode-login-state"

describe("shouldShowWanlaiCodeLoginError", () => {
  test("does not report a logged-in user as unauthenticated while models refresh", () => {
    expect(
      shouldShowWanlaiCodeLoginError({
        providerReady: true,
        connected: false,
        hasModels: false,
        authenticated: true,
        authLoading: false,
      }),
    ).toBe(false)
  })

  test("waits for authoritative auth status before reporting missing login", () => {
    expect(
      shouldShowWanlaiCodeLoginError({
        providerReady: true,
        connected: false,
        hasModels: false,
        authenticated: undefined,
        authLoading: true,
      }),
    ).toBe(false)
  })

  test("reports missing login only after auth is confirmed false", () => {
    expect(
      shouldShowWanlaiCodeLoginError({
        providerReady: true,
        connected: false,
        hasModels: false,
        authenticated: false,
        authLoading: false,
      }),
    ).toBe(true)
  })
})
