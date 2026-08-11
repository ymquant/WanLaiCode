import { Component, For, Show, type JSX } from "solid-js"
import { FileIcon } from "./file-icon"

type FileAttachmentItemProps = {
  filename: string
  path?: string
  layout?: "pill" | "card"
  subtitle?: string | JSX.Element
  onClick?: () => void
  class?: string
}

const containerClass =
  "composer-attachment-surface group/file-attachment inline-flex max-w-[320px] items-center gap-1 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-2 py-1.5 text-left text-text-strong transition-colors duration-200 hover:bg-surface-base-hover"
const cardClass =
  "composer-attachment-surface group/file-attachment relative inline-flex w-fit max-w-72 flex-shrink-0 overflow-hidden rounded-[15px] border border-border-base bg-surface-raised-stronger-non-alpha text-left shadow-xs transition-colors duration-200"
const cardContentClass = "pointer-events-none relative z-10 flex min-w-0 items-center gap-2.5 py-1.5 pl-1.5 pr-10"
const cardOverlayClass =
  "absolute inset-0 z-0 bg-transparent transition-colors hover:bg-surface-base-hover active:bg-surface-base-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base focus-visible:ring-inset"

function fileExtension(filename: string) {
  const idx = filename.lastIndexOf(".")
  if (idx <= 0 || idx === filename.length - 1) return undefined
  return filename.slice(idx + 1).toUpperCase()
}

function DocumentGlyph(props: { class?: string }) {
  return (
    <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true" class={props.class ?? "size-5"}>
      <path d="M1.4585 6.54161V3.45812C1.4585 3.115 1.45807 2.83254 1.47681 2.60322C1.49594 2.36903 1.53694 2.15357 1.63997 1.95136L1.70427 1.83662C1.86439 1.57557 2.09396 1.36282 2.36833 1.22301L2.44482 1.1872C2.62471 1.11004 2.81525 1.07659 3.02018 1.05984C3.24951 1.04111 3.53196 1.04153 3.87508 1.04153H5.63005C5.91595 1.04153 6.12695 1.03878 6.32992 1.08751L6.45606 1.12332C6.58043 1.16376 6.69992 1.21881 6.81169 1.2873L6.8772 1.33002C7.02732 1.43474 7.16218 1.57269 7.33903 1.74954L7.83382 2.24433L7.97624 2.38715C8.10903 2.52211 8.21429 2.63828 8.29606 2.77168L8.36035 2.88601C8.41974 3.00259 8.46523 3.12594 8.49585 3.25345L8.51172 3.33035C8.54382 3.51054 8.54183 3.70323 8.54183 3.95332V6.54161C8.54183 6.88473 8.54226 7.16719 8.52352 7.39651C8.50677 7.60145 8.47332 7.79198 8.39616 7.97187L8.36035 8.04837C8.22054 8.32273 8.00779 8.55231 7.74674 8.71243L7.632 8.77672C7.42979 8.87975 7.21433 8.92075 6.98014 8.93989C6.75082 8.95863 6.46837 8.9582 6.12524 8.9582H3.87508C3.53196 8.9582 3.24951 8.95863 3.02018 8.93989C2.81525 8.92314 2.62471 8.88969 2.44482 8.81253L2.36833 8.77672C2.09396 8.63691 1.86439 8.42416 1.70427 8.16311L1.63997 8.04837C1.53694 7.84616 1.49594 7.6307 1.47681 7.39651C1.45807 7.16719 1.4585 6.88473 1.4585 6.54161ZM5.41683 5.41653C5.64695 5.41653 5.8335 5.60308 5.8335 5.8332C5.8335 6.06332 5.64695 6.24987 5.41683 6.24987H3.75016C3.52004 6.24987 3.3335 6.06332 3.3335 5.8332C3.3335 5.60308 3.52004 5.41653 3.75016 5.41653H5.41683ZM6.25016 3.74987C6.48028 3.74987 6.66683 3.93641 6.66683 4.16653C6.66683 4.39665 6.48028 4.5832 6.25016 4.5832H3.75016C3.52004 4.5832 3.3335 4.39665 3.3335 4.16653C3.3335 3.93641 3.52004 3.74987 3.75016 3.74987H6.25016ZM2.29183 6.54161C2.29183 6.89844 2.29198 7.14104 2.30729 7.32856C2.32222 7.51123 2.34937 7.60478 2.38257 7.66995L2.41471 7.72732C2.49477 7.85785 2.60956 7.96422 2.74675 8.03413L2.80208 8.05773C2.8644 8.08002 2.95122 8.09822 3.08814 8.1094C3.27565 8.12472 3.51825 8.12487 3.87508 8.12487H6.12524C6.48207 8.12487 6.72468 8.12472 6.91219 8.1094C7.09486 8.09448 7.18841 8.06733 7.25358 8.03413L7.31095 8.00198C7.44148 7.92192 7.54785 7.80713 7.61776 7.66995L7.64136 7.61461C7.66365 7.55229 7.68185 7.46548 7.69303 7.32856C7.70835 7.14104 7.7085 6.89844 7.7085 6.54161V3.95332C7.7085 3.70924 7.70684 3.59482 7.69751 3.51712L7.6853 3.44794C7.67 3.38427 7.64741 3.32265 7.61776 3.26443L7.58561 3.20706C7.55147 3.15138 7.50616 3.09869 7.38867 2.97879L7.24463 2.83352L6.74984 2.33873C6.57722 2.16612 6.49521 2.08597 6.43368 2.03763L6.3763 1.99775C6.32043 1.96351 6.26066 1.93577 6.19849 1.91556L6.13542 1.89806C6.05066 1.87771 5.95562 1.87487 5.63005 1.87487H3.87508C3.51825 1.87487 3.27565 1.87501 3.08814 1.89033C2.95122 1.90151 2.8644 1.91971 2.80208 1.942L2.74675 1.9656C2.60956 2.03551 2.49477 2.14189 2.41471 2.27241L2.38257 2.32978C2.34937 2.39495 2.32222 2.4885 2.30729 2.67117C2.29198 2.85869 2.29183 3.10129 2.29183 3.45812V6.54161Z" />
    </svg>
  )
}

export const FileAttachmentItem: Component<FileAttachmentItemProps> = (props) => {
  const isTextAttachment = () => (props.path ?? props.filename).toLowerCase().endsWith(".txt")

  if (props.layout === "card") {
    const subtitle = () => props.subtitle ?? fileExtension(props.filename)

    return (
      <div class={`${cardClass} ${props.class ?? ""}`} title={props.path ?? props.filename}>
        <Show when={props.onClick}>
          {/* Codex 文件卡片用整卡覆盖层承接点击，内容层不抢事件，删除按钮可在外层更高 z-index 独立工作。 */}
          <button type="button" class={cardOverlayClass} onClick={() => props.onClick?.()} aria-label={props.filename} />
        </Show>
        <span class={cardContentClass}>
          <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-base text-text-weak">
            <Show when={isTextAttachment()} fallback={<FileIcon node={{ path: props.filename, type: "file" }} class="size-6" />}>
              <DocumentGlyph />
            </Show>
          </span>
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="block max-w-32 truncate text-14-medium leading-5 text-text-strong">{props.filename}</span>
            <Show when={subtitle()}>
              {(value) => (
                // 允许粘贴文本的恢复按钮穿透整卡覆盖层，普通字符串副标题仍保持原有视觉。
                <span class="pointer-events-auto relative z-20 truncate text-14-regular leading-5 text-text-weak">
                  {value()}
                </span>
              )}
            </Show>
          </span>
        </span>
      </div>
    )
  }

  return (
    <div class={containerClass}>
      {/* 默认 pill 用在已发送消息里，按 Codex 的轻量附件样式保持圆角、弱背景和 14px 标题。 */}
      <Show when={isTextAttachment()} fallback={<FileIcon node={{ path: props.filename, type: "file" }} class="size-4 shrink-0 text-text-weak" />}>
        <DocumentGlyph class="size-4 shrink-0 text-text-weak" />
      </Show>
      <span class="max-w-[260px] truncate pr-1 text-14-medium leading-5 text-text-strong" title={props.path ?? props.filename}>
        {props.filename}
      </span>
    </div>
  )
}

type FileAttachmentsProps = {
  files: Array<{ filename: string; path?: string }>
}

export const FileAttachments: Component<FileAttachmentsProps> = (props) => {
  return (
    <Show when={props.files.length > 0}>
      <div class="flex flex-wrap gap-2">
        <For each={props.files}>
          {(file) => <FileAttachmentItem filename={file.filename} path={file.path} />}
        </For>
      </div>
    </Show>
  )
}
