import { describe, expect, test } from "bun:test"
import {
  SECTION_CHEVRON_REVEAL_CLASS,
  sectionChevronClassList,
  sectionChevronName,
} from "./section-chevron-state"

describe("sectionChevronName", () => {
  test("points down when expanded and right when collapsed", () => {
    expect(sectionChevronName(true)).toBe("chevron-down")
    expect(sectionChevronName(false)).toBe("chevron-right")
  })
})

describe("sectionChevronClassList", () => {
  test("collapsed chevron stays visible without hover", () => {
    expect(sectionChevronClassList(false)[SECTION_CHEVRON_REVEAL_CLASS]).toBe(false)
  })

  test("expanded chevron only reveals on hover or focus", () => {
    expect(sectionChevronClassList(true)[SECTION_CHEVRON_REVEAL_CLASS]).toBe(true)
  })

  test("reveal class carries both hover and focus-within variants", () => {
    expect(SECTION_CHEVRON_REVEAL_CLASS).toContain("opacity-0")
    expect(SECTION_CHEVRON_REVEAL_CLASS).toContain("group-hover/section:opacity-100")
    expect(SECTION_CHEVRON_REVEAL_CLASS).toContain("group-focus-within/section:opacity-100")
  })
})

// 动态扫描而非硬编码清单：新增 section 只要渲染 SectionChevron 就自动纳入约束，
// 否则漏掉 group/section 的第 5 个 section 会静默通过
const CHEVRON_HEADERS: string[] = []
for await (const file of new Bun.Glob("*.tsx").scan({ cwd: import.meta.dir })) {
  const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text()
  if (source.includes("<SectionChevron")) CHEVRON_HEADERS.push(file)
}

describe("sidebar section headers", () => {
  test("scan finds every section that renders a chevron", () => {
    // 扫描失败会让下面的循环空转、断言恒真，这里兜住那种情况
    expect(CHEVRON_HEADERS).toContain("chats.tsx")
    expect(CHEVRON_HEADERS).toContain("projects.tsx")
    expect(CHEVRON_HEADERS).toContain("pinned.tsx")
    expect(CHEVRON_HEADERS).toContain("automations.tsx")
  })

  for (const file of CHEVRON_HEADERS) {
    test(`${file} renders the chevron under a group/section ancestor`, async () => {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text()

      // 淡出规则依赖祖先的 group/section；缺了它 chevron 在展开态会永久不可见
      expect(source).toContain("<SectionChevron")
      expect(source.indexOf("group/section")).toBeGreaterThan(-1)
      expect(source.indexOf("group/section")).toBeLessThan(source.indexOf("<SectionChevron"))
    })

    test(`${file} keeps group/section on the header container, not the button`, async () => {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text()
      const button = source.slice(source.indexOf("onClick={toggleSection}"), source.indexOf("<SectionChevron"))

      // 挂在 button 自身时，日后新增的同级操作按钮会落在 group 外，hover 不再点亮 chevron
      expect(source).toContain('<div class="group/section flex items-center')
      expect(button).not.toContain("group/section")
    })

    test(`${file} exposes aria-expanded on the toggle button`, async () => {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text()
      const button = source.slice(source.indexOf("onClick={toggleSection}"), source.indexOf("<SectionChevron"))

      expect(button).toContain("aria-expanded={sectionExpanded()}")
    })
  }
})
