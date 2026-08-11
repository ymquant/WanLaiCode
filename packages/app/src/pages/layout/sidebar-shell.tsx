import { type Accessor, type JSX } from "solid-js"

// 极薄壳：单纯渲染 sidebar 内容，处理 mobile / opened 可见性
export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  renderSidebar: () => JSX.Element
}): JSX.Element => {
  const expanded = () => !!props.mobile || props.opened()
  return (
    <div
      data-component="app-shell-left-panel"
      class="h-full w-full"
      classList={{ "pointer-events-none": !expanded() }}
      aria-hidden={!expanded()}
    >
      {props.renderSidebar()}
    </div>
  )
}
