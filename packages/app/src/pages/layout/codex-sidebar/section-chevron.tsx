import type { JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { SECTION_CHEVRON_CLASS, sectionChevronClassList, sectionChevronName } from "./section-chevron-state"

// 调用方的 header 容器必须带 group/section，否则展开态的淡出规则不会触发，chevron 会一直不可见
export const SectionChevron = (props: { expanded: () => boolean }): JSX.Element => (
  <Icon
    name={sectionChevronName(props.expanded())}
    size="small"
    class={SECTION_CHEVRON_CLASS}
    classList={sectionChevronClassList(props.expanded())}
  />
)
