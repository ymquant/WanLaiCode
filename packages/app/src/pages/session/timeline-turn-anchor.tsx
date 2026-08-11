import type { JSX } from "solid-js"

export function TimelineTurnAnchor(props: {
  messageID: string
  turnID?: string
  anchor: (messageID: string) => string
  active: boolean
  latest: boolean
  children: JSX.Element
}) {
  // 这一层是时间线跳转、Minimap 和虚拟化共同依赖的真实 DOM 锚点，属性必须始终指向当前已加载 user。
  return (
    <div
      id={props.anchor(props.messageID)}
      data-message-id={props.messageID}
      data-turn-id={props.turnID}
      class="min-w-0 w-full max-w-full"
      style={{
        // 最新一轮即使已结束也不虚拟化：contain-intrinsic-size:auto 只有在元素已经带着该属性渲染后才有记忆尺寸。
        // 活跃期间若提前移除属性，结束瞬间直接启用 500px 兜底会让数千像素的长回合塌陷并拖动滚动位置。
        // 因此等用户发送下一条消息、旧轮不再是 latest 后才启用；此时视口仍和旧轮相交，浏览器会在同次布局记录真实高度。
        // 内层 SessionTurn 的同名虚拟化豁免继续由 message-part.css 负责，避免两层 contain 互相放大误差。
        "content-visibility": props.active || props.latest ? undefined : "auto",
        "contain-intrinsic-size": props.active || props.latest ? undefined : "auto 500px",
      }}
    >
      {props.children}
    </div>
  )
}
