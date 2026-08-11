import { describe, expect, test } from "bun:test"

describe("BinaryFilePlaceholder", () => {
  test("文件读取失败时显示居中的通用提示并隐藏系统异常", async () => {
    const source = await Bun.file(new URL("./binary-placeholder.tsx", import.meta.url)).text()

    expect(source).toContain("export function FileOpenErrorPlaceholder()")
    expect(source).toContain('class="absolute inset-0 flex items-center justify-center')
    expect(source).toContain('i18n.t("toast.file.loadFailed.title")')
    expect(source).not.toContain("ENOENT")
  })

  test("uses themed actions without the decorative open-file icon", async () => {
    const source = await Bun.file(new URL("./binary-placeholder.tsx", import.meta.url)).text()

    expect(source).not.toContain('<Icon name="open-file"')
    expect(source).toContain("bg-surface-raised-stronger-non-alpha")
    expect(source).toContain("border-border-base")
    expect(source).toContain("text-text-strong")
  })

  test("uses the project file icon for reveal in folder", async () => {
    const source = await Bun.file(new URL("./binary-placeholder.tsx", import.meta.url)).text()

    expect(source).toContain('import { FileIcon } from "@opencode-ai/ui/file-icon"')
    expect(source).toContain('node={{ path: "folder", type: "directory" }}')
    expect(source).not.toContain('icon="folder"')
  })
})
