import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./rename-thread-dialog.tsx", import.meta.url)).text()

describe("RenameThreadDialog", () => {
  test("routes the update through the session directory", () => {
    const call = source.slice(
      source.indexOf("globalSDK.client.session.update"),
      source.indexOf("const [, setStore]"),
    )

    expect(call).toContain("directory: props.directory")
  })

  test("exposes modal dialog semantics", () => {
    const container = source.slice(
      source.indexOf('data-component="rename-thread-dialog"'),
      source.indexOf("<form"),
    )

    expect(container).toContain('role="dialog"')
    expect(container).toContain('aria-modal="true"')
  })
})
