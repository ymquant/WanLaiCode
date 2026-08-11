import { Match, Switch, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

export const QuestionMarker: Component<{
  variant: "number" | "pencil"
  index?: number
  selected: boolean
  indicator?: "dot" | "check"
}> = (props) => (
  <span data-slot="question-marker" data-variant={props.variant} data-picked={props.selected} aria-hidden="true">
    <Switch fallback={props.index}>
      <Match when={props.variant === "pencil"}>
        <Icon name="pencil-line" size="small" />
      </Match>
      <Match when={props.selected && props.indicator === "dot"}>
        <span data-slot="question-marker-dot" />
      </Match>
      <Match when={props.selected && props.indicator === "check"}>
        <Icon name="check-small" size="small" />
      </Match>
    </Switch>
  </span>
)
