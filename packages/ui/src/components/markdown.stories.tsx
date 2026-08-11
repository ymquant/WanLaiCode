// @ts-nocheck
import * as mod from "./markdown"
import { create } from "../storybook/scaffold"
import { markdown } from "../storybook/fixtures"

const docs = `### Overview
Render sanitized Markdown with code blocks, inline code, and safe links.

Pair with \`Code\` for standalone code views.

### API
- Required: \`text\` Markdown string.
- Uses the Marked context provider for parsing and sanitization.

### Variants and states
- Code blocks include copy buttons when rendered.

### Behavior
- Sanitizes HTML and auto-converts inline URL code to links.
- Adds copy buttons to code blocks.

### Accessibility
- Copy buttons include aria-labels from i18n.
- TODO: confirm link target behavior in sanitized output.

### Theming/tokens
- Uses \`data-component="markdown"\` and related slots for styling.

`

const story = create({
  title: "UI/Markdown",
  mod,
  args: {
    text: markdown,
  },
})

const mathText = [
  "## 数学公式渲染验证",
  "",
  "行内 dollar 定界符:勾股定理 $a^2 + b^2 = c^2$,圆面积 $S = \\pi r^2$。",
  "",
  "块级 dollar 定界符(分式 + 根号):",
  "",
  "$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$",
  "",
  "LaTeX 风格行内定界符:欧拉恒等式 \\(e^{i\\pi} + 1 = 0\\)。",
  "",
  "LaTeX 风格块级定界符(等差数列求和):",
  "",
  "\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]",
  "",
  "对照组(反引号代码应保持代码样式、不被当公式):`a^2 + b^2 = c^2`",
].join("\n")

const mathStory = create({
  title: "UI/Markdown",
  mod,
  args: {
    text: mathText,
  },
})

// 回归:多个含空格的行内公式 + 块级公式同处一个段落(单换行软换行),
// 历史上 nonStandard:false 会导致 $ 配对错乱报错,nonStandard:true 正常。
const mixedParagraphStory = create({
  title: "UI/Markdown",
  mod,
  args: {
    text: [
      "行内:$a^2 + b^2 = c^2$,圆面积 $S = \\pi r^2$",
      "块级分式根号:$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$",
      "LaTeX 行内:\\(e^{i\\pi} + 1 = 0\\)",
      "LaTeX 块级:\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]",
      "货币不应被当公式:花了 $5 买了 $10;以数字开头的公式仍渲染 $5x$",
    ].join("\n"),
  },
})

export default {
  title: "UI/Markdown",
  id: "components-markdown",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic
export const Math = mathStory.Basic
export const MixedParagraph = mixedParagraphStory.Basic
