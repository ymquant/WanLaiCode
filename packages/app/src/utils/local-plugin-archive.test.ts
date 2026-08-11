import { describe, expect, test } from "bun:test"
import { pickLocalPluginArchive, resolveDroppedLocalPluginArchive } from "./local-plugin-archive"

describe("pickLocalPluginArchive", () => {
  test("opens a single-file picker for supported plugin archives", async () => {
    const calls: unknown[] = []
    const selected = await pickLocalPluginArchive(
      {
        openFilePickerDialog: async (options) => {
          calls.push(options)
          return "/tmp/demo.tgz"
        },
      },
      "Install local plugin package",
    )

    expect(selected).toBe("/tmp/demo.tgz")
    expect(calls).toEqual([
      {
        title: "Install local plugin package",
        multiple: false,
        extensions: ["tar", "tar.gz", "tgz"],
      },
    ])
  })

  test("ignores unavailable, cancelled, and multiple selections", async () => {
    expect(await pickLocalPluginArchive({}, "Install")).toBeUndefined()
    expect(await pickLocalPluginArchive({ openFilePickerDialog: async () => null }, "Install")).toBeUndefined()
    expect(
      await pickLocalPluginArchive({ openFilePickerDialog: async () => ["/tmp/demo.tar"] }, "Install"),
    ).toBeUndefined()
  })
})

describe("resolveDroppedLocalPluginArchive", () => {
  test("resolves one supported archive through the desktop file path bridge", () => {
    const file = new File(["archive"], "demo.tgz")

    expect(
      resolveDroppedLocalPluginArchive({
        files: [file],
        getPathForFile: () => "/tmp/demo.tgz",
      }),
    ).toBe("/tmp/demo.tgz")
  })

  test("accepts Windows absolute paths and all supported suffixes", () => {
    for (const name of ["demo.tar", "demo.tar.gz", "demo.tgz"]) {
      const file = new File(["archive"], name)
      expect(
        resolveDroppedLocalPluginArchive({
          files: [file],
          getPathForFile: () => `C:\\Users\\demo\\${name}`,
        }),
      ).toBe(`C:\\Users\\demo\\${name}`)
    }
  })

  test("rejects multiple files, unsupported files, missing path bridges, and path lookup failures", () => {
    const archive = new File(["archive"], "demo.tgz")
    const unsupported = new File(["archive"], "demo.zip")

    expect(
      resolveDroppedLocalPluginArchive({
        files: [archive, unsupported],
        getPathForFile: () => "/tmp/demo.tgz",
      }),
    ).toBeUndefined()
    expect(
      resolveDroppedLocalPluginArchive({
        files: [unsupported],
        getPathForFile: () => "/tmp/demo.zip",
      }),
    ).toBeUndefined()
    expect(resolveDroppedLocalPluginArchive({ files: [archive] })).toBeUndefined()
    expect(
      resolveDroppedLocalPluginArchive({
        files: [archive],
        getPathForFile: () => {
          throw new Error("bridge unavailable")
        },
      }),
    ).toBeUndefined()
  })
})
