import { describe, test, expect } from "bun:test"
import { buildChangelogUrl } from "./highlights"

describe("buildChangelogUrl", () => {
  test("strips leading v and sets version param", () => {
    expect(buildChangelogUrl("v0.0.23")).toBe("https://api.wanlai.ai/changelog.json?version=0.0.23")
  })
  test("accepts bare semver", () => {
    expect(buildChangelogUrl("0.0.24")).toBe("https://api.wanlai.ai/changelog.json?version=0.0.24")
  })
  test("falls back to base URL when version missing", () => {
    expect(buildChangelogUrl(undefined)).toBe("https://api.wanlai.ai/changelog.json")
    expect(buildChangelogUrl("")).toBe("https://api.wanlai.ai/changelog.json")
  })
})
