export const SECTION_CHEVRON_CLASS = "shrink-0 text-icon-base transition-opacity duration-120"

// 展开态才淡出：折叠态必须常显，否则用户看不出这一区还能展开
export const SECTION_CHEVRON_REVEAL_CLASS =
  "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100"

export const sectionChevronName = (expanded: boolean) => (expanded ? "chevron-down" : "chevron-right")

export const sectionChevronClassList = (expanded: boolean) => ({
  [SECTION_CHEVRON_REVEAL_CLASS]: expanded,
})
