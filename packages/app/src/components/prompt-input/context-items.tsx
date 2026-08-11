import { Component, For, Show, createMemo } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/core/util/path"
import type { ContextItem } from "@/context/prompt"

type PromptContextItem = ContextItem & { key: string }

type ContextItemsProps = {
  items: PromptContextItem[]
  projectTag?: { name: string; path: string }
  active: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  remove: (item: PromptContextItem) => void
  t: (key: string) => string
}

export const PromptContextItems: Component<ContextItemsProps> = (props) => {
  const reviewCommentItems = createMemo(() =>
    props.items.filter((item) => item.commentOrigin === "review" && !!item.comment?.trim()),
  )
  const regularItems = createMemo(() => props.items.filter((item) => !reviewCommentItems().includes(item)))

  const removeReviewComments = () => {
    for (const item of reviewCommentItems()) props.remove(item)
  }

  return (
    <Show when={props.projectTag || props.items.length > 0}>
      <div class="flex flex-nowrap items-center gap-2 p-2 overflow-x-auto no-scrollbar">
        <Show when={props.projectTag} keyed>
          {(tag) => (
            <Tooltip
              value={
                <span class="flex max-w-[300px]">
                  <span class="min-w-0 truncate-start text-text-invert-base [unicode-bidi:plaintext]">
                    {tag.path}
                  </span>
                </span>
              }
              placement="top"
              openDelay={500}
            >
              <div
                data-component="prompt-project-tag"
                class="shrink-0 flex h-7 items-center gap-1.5 rounded-full bg-background-stronger pl-2 pr-2.5 text-12-regular text-text-strong shadow-xs-border cursor-default select-none"
              >
                <Icon name="folder" size="small" class="shrink-0 text-icon-weak" />
                <span class="max-w-[160px] truncate">{tag.name}</span>
              </div>
            </Tooltip>
          )}
        </Show>

        <Show when={reviewCommentItems().length > 0}>
          <Tooltip
            value={
              <div class="prompt-input-scrollbar flex max-h-[inherit] min-w-[360px] max-w-[min(520px,calc(100vw-32px))] flex-col overflow-y-auto rounded-[18px] bg-surface-stronger-non-alpha">
                <For each={reviewCommentItems()}>
                  {(item, index) => {
                    const filename = getFilename(item.path)
                    const line = item.selection?.startLine

                    return (
                      <div
                        classList={{
                          "flex flex-col gap-1 px-4 py-2": true,
                          "border-b border-border-weaker-base": index() < reviewCommentItems().length - 1,
                        }}
                      >
                        <div class="flex min-h-[22px] min-w-0 items-center gap-2">
                          <FileIcon
                            node={{ path: item.path, type: "file" }}
                            mono
                            class="size-4 shrink-0 text-[#3287D8]"
                          />
                          <Tooltip
                            value={<span class="text-[13px] font-medium text-text-strong">{filename}</span>}
                            placement="top-start"
                            openDelay={120}
                            contentClass="!rounded-[14px] !border-border-weaker-base !bg-surface-stronger-non-alpha !px-4 !py-2 !shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
                          >
                            <span class="min-w-0 truncate text-[14px] font-semibold text-[#3287D8]">{item.path}</span>
                          </Tooltip>
                          <Show when={line}>
                            <span class="shrink-0 text-[13px] font-medium text-text-strong">右</span>
                            <span class="shrink-0 text-[13px] text-text-base">{line}</span>
                          </Show>
                        </div>
                        <div class="break-words whitespace-pre-wrap pl-[22px] text-[13px] leading-[1.4] text-text-strong">
                          {item.comment}
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            }
            placement="top-start"
            fitViewport
            openDelay={150}
            interactive
            contentClass="!max-w-none !rounded-[18px] !border-border-weaker-base !bg-surface-stronger-non-alpha !p-0 !shadow-[0_8px_24px_rgba(15,23,42,0.08),0_1px_4px_rgba(15,23,42,0.05)]"
            contentStyle={{
              "max-height": "calc(var(--kb-popper-content-available-height, 100vh) - 8px)",
              overflow: "hidden",
            }}
          >
            <div class="group relative flex h-14 shrink-0 items-center rounded-[14px] border border-border-weak-base bg-background-stronger pl-4 pr-10 shadow-[0_1px_2px_rgba(16,24,40,0.06)]">
              <div class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#f1f1f3] text-[#7f8085]">
                <Icon name="comment-icon" class="size-4.5" viewBox="0 0 1024 1024" />
              </div>
              <div class="ml-3 text-[15px] font-medium text-text-strong">
                {props.t("prompt.context.reviewComments").replace("{{count}}", String(reviewCommentItems().length))}
              </div>
              <IconButton
                type="button"
                icon="close-small"
                variant="ghost"
                class="absolute right-2 top-2 size-5 rounded-full bg-[#2f3136] text-[#fdfdfd] hover:bg-[#26282d]"
                onClick={(event) => {
                  event.stopPropagation()
                  removeReviewComments()
                }}
                aria-label={props.t("prompt.context.removeFile")}
              />
            </div>
          </Tooltip>
        </Show>

        <For each={regularItems()}>
          {(item) => {
            const directory = getDirectory(item.path)
            const filename = getFilename(item.path)
            const label = getFilenameTruncated(item.path, 14)
            const selected = props.active(item)

            return (
              <Tooltip
                value={
                  <span class="flex max-w-[300px]">
                    <span class="min-w-0 truncate-start text-text-invert-base [unicode-bidi:plaintext]">
                      {directory}
                    </span>
                    <span class="shrink-0">{filename}</span>
                  </span>
                }
                placement="top"
                openDelay={2000}
              >
                <div
                  classList={{
                    "group flex h-12 max-w-[200px] shrink-0 cursor-default flex-col rounded-[6px] pl-2 pr-1 py-1 shadow-xs-border transition-all transition-transform hover:shadow-xs-border-hover": true,
                    "hover:bg-surface-interactive-weak": !!item.commentID && !selected,
                    "bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover": selected,
                    "bg-background-stronger": !selected,
                  }}
                  onClick={() => props.openComment(item)}
                >
                  <div class="flex items-center gap-1.5">
                    <FileIcon node={{ path: item.path, type: "file" }} class="size-3.5 shrink-0" />
                    <div class="flex min-w-0 items-center text-11-regular font-medium">
                      <span class="whitespace-nowrap text-text-strong">{label}</span>
                      <Show when={item.selection}>
                        {(sel) => (
                          <span class="shrink-0 whitespace-nowrap text-text-weak">
                            {sel().startLine === sel().endLine
                              ? `:${sel().startLine}`
                              : `:${sel().startLine}-${sel().endLine}`}
                          </span>
                        )}
                      </Show>
                    </div>
                    <IconButton
                      type="button"
                      icon="close-small"
                      variant="ghost"
                      class="ml-auto size-3.5 text-text-weak transition-all hover:text-text-strong"
                      onClick={(event) => {
                        event.stopPropagation()
                        props.remove(item)
                      }}
                      aria-label={props.t("prompt.context.removeFile")}
                    />
                  </div>
                  <Show when={item.comment}>
                    {(comment) => <div class="ml-5 truncate pr-1 text-12-regular text-text-strong">{comment()}</div>}
                  </Show>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
