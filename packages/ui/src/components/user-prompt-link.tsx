import { createMemo, Show } from "solid-js"
import { useData } from "../context/data"
import { Icon } from "./icon"
import { stripFileLocationSuffix, type PromptLinkKind } from "@opencode-ai/core/util/prompt-link"
import { resolveUserPromptLinkTarget } from "./user-prompt-link-target"

export function UserPromptLink(props: { text: string; href: string; kind: PromptLinkKind }) {
  const data = useData()
  const github = createMemo(() => props.kind === "link" && /^https?:\/\/(?:www\.)?github\.com\//i.test(props.href))
  const activate = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const resolved =
      props.kind === "file"
        ? await data.resolveMarkdownPath?.(stripFileLocationSuffix(props.href.trim()))
        : undefined
    const target = resolveUserPromptLinkTarget({
      kind: props.kind,
      href: props.href,
      directory: data.directory,
      resolved,
    })
    if (target.type === "external") {
      // 已发送网页链接直接进入应用内浏览器，避免再次弹出仅用于编辑态的链接编辑菜单。
      await data.openExternalLink?.(target.value)
      return
    }
    // 本地文件继续走宿主统一桥接，工作区内文件会在现有文件标签中打开。
    await data.openLocalPath?.(target.value, target.kind)
  }

  return (
    <button
      type="button"
      data-highlight="prompt-link"
      data-kind={props.kind}
      data-href={props.href}
      title={props.href}
      onClick={activate}
      onDblClick={(event) => event.stopPropagation()}
    >
      <Show when={props.kind === "file"}>
        <Icon name="file-reference" size="small" />
      </Show>
      <Show when={github()}>
        <Icon name="github" size="small" />
      </Show>
      <span data-slot="user-message-prompt-link-label">{props.text}</span>
    </button>
  )
}
