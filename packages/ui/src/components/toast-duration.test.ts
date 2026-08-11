import { describe, expect, test } from "bun:test"

describe("ToastRegion duration", () => {
  test("uses a 2.5 second default", async () => {
    const source = await Bun.file(new URL("./toast.tsx", import.meta.url)).text()

    expect(source).toContain('data-component="toast-region" duration={2500} {...props}')
  })
})
