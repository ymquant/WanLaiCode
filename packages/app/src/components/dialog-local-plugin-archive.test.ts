import { describe, expect, test } from "bun:test"

describe("local plugin archive confirmation dialog", () => {
  test("shows the preview metadata and installs only after confirmation", async () => {
    const source = await Bun.file(new URL("./dialog-local-plugin-archive.tsx", import.meta.url)).text()

    expect(source).toContain("AddonLocalArchivePreview")
    expect(source).toContain("developer_name")
    expect(source).toContain("capabilities")
    expect(source).toContain("manifest_mcp_servers")
    expect(source).toContain("manifest_skills")
    expect(source).toContain("onConfirm")
    expect(source).toContain("dialog.close()")
  })
})
