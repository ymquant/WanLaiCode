import { describe, expect, test } from "bun:test"
import { resolvePromptLinkSave, type PromptLinkPopoverDraft } from "./link-popover"

const normalizeHref = (value: string) => {
  if (/^https?:\/\//i.test(value)) return value
  if (/^www\./i.test(value)) return `https://${value}`
  return undefined
}

const draft = (value: Partial<PromptLinkPopoverDraft>) => ({
  displayText: "https://example.com/old",
  href: "https://example.com/old",
  plain: true,
  mode: "url" as const,
  value: "https://example.com/new",
  ...value,
})

describe("prompt link popover save", () => {
  test("编辑裸 URL 地址时同步更新显示文字并保留纯文本格式", () => {
    expect(resolvePromptLinkSave(draft({}), normalizeHref)).toEqual({
      displayText: "https://example.com/new",
      href: "https://example.com/new",
      plain: true,
      invalid: false,
    })
  })

  test("编辑命名链接地址时保留原显示文字", () => {
    expect(
      resolvePromptLinkSave(
        draft({ displayText: "项目主页", href: "https://example.com/old", plain: false }),
        normalizeHref,
      ),
    ).toEqual({
      displayText: "项目主页",
      href: "https://example.com/new",
      plain: false,
      invalid: false,
    })
  })

  test("编辑裸 URL 显示文字后转为命名链接", () => {
    expect(resolvePromptLinkSave(draft({ mode: "text", value: "项目主页" }), normalizeHref)).toEqual({
      displayText: "项目主页",
      href: "https://example.com/old",
      plain: false,
      invalid: false,
    })
  })
})
