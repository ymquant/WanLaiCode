import { Show, createMemo, type Component } from "solid-js"
import { QuestionMarker } from "@/pages/session/composer/question-marker"

// 模型写法不稳：前导空格可有可无，英文大小写也不固定
const RECOMMENDED = /\s*(\(recommended\)|（推荐）|\(推荐\))$/i

// 「推荐」不是数据字段，模型把它写在 label 末尾，这里拆出来单独渲染成徽章
export function splitRecommended(label: string): { label: string; recommended: boolean } {
  const match = label.match(RECOMMENDED)
  if (!match) return { label, recommended: false }
  const stripped = label.slice(0, match.index).trimEnd()
  // 整条 label 就是标记时不拆，否则选项行会变成一个没有标题的空壳
  if (!stripped) return { label, recommended: false }
  return { label: stripped, recommended: true }
}

export const QuestionOption: Component<{
  index: number
  multi: boolean
  picked: boolean
  label: string
  description?: string
  badge?: string
  recommendLabel: string
  disabled: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}> = (props) => {
  const parsed = createMemo(() => splitRecommended(props.label))

  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      aria-description={props.description}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <QuestionMarker
        variant="number"
        index={props.index + 1}
        selected={props.picked}
        indicator={props.multi ? "check" : "dot"}
      />
      <span data-slot="question-option-main">
        <span data-slot="question-option-head">
          <span data-slot="option-label">{parsed().label}</span>
          <Show when={parsed().recommended}>
            <span data-slot="question-option-recommend">{props.recommendLabel}</span>
          </Show>
        </span>
        <Show when={props.description}>
          <span data-slot="option-description" title={props.description}>
            {props.description}
          </span>
        </Show>
      </span>
      <Show when={props.badge}>
        <span data-slot="question-option-badge">{props.badge}</span>
      </Show>
    </button>
  )
}
