import { For, Show, createMemo } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  createSortable,
  maybeTransformStyle,
} from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { followupSendNowDisabled, followupSendNowTooltip } from "@/pages/session/followup-queue"

function move(ids: string[], from: number, to: number) {
  const next = ids.slice()
  const [item] = next.splice(from, 1)
  if (!item) return ids
  next.splice(to, 0, item)
  return next
}

function QueuedIcon(props: { class?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class={props.class}
      aria-hidden="true"
    >
      <path
        d="M2.66797 11V3.33301C2.66797 2.96574 2.96574 2.66797 3.33301 2.66797C3.70028 2.66797 3.99805 2.96574 3.99805 3.33301V11C3.99805 11.7109 3.99894 12.2044 4.03027 12.5879C4.06098 12.9634 4.11776 13.175 4.19824 13.333L4.26856 13.459C4.44487 13.7465 4.69781 13.9808 5 14.1348L5.12988 14.1904C5.27366 14.2419 5.46311 14.2797 5.74512 14.3027C6.12864 14.3341 6.62197 14.335 7.33301 14.335H15L15.0674 14.3418L14.1123 13.3867L14.0273 13.2822C13.8571 13.0242 13.8854 12.6735 14.1123 12.4463C14.3397 12.2189 14.6911 12.1906 14.9492 12.3613L15.0537 12.4463L17.1367 14.5293C17.3964 14.7889 17.3963 15.21 17.1367 15.4697L15.0537 17.5537C14.794 17.8134 14.372 17.8134 14.1123 17.5537C13.8526 17.294 13.8526 16.872 14.1123 16.6123L15.0664 15.6582L15 15.665H7.33301C6.64392 15.665 6.08696 15.6647 5.63672 15.6279C5.23614 15.5952 4.87531 15.5309 4.53906 15.3867L4.39649 15.3193C3.87528 15.0538 3.43887 14.6502 3.13477 14.1543L3.0127 13.9365C2.82084 13.5599 2.74153 13.1541 2.7041 12.6963C2.66732 12.2461 2.66797 11.6889 2.66797 11ZM15.665 15C15.665 15.0226 15.6594 15.0444 15.6572 15.0664L15.7256 14.999L15.6572 14.9316C15.6595 14.9541 15.665 14.9769 15.665 15ZM11.666 8.91797L11.8008 8.93164C12.1036 8.99381 12.3311 9.2618 12.3311 9.58301C12.3311 9.90422 12.1036 10.1722 11.8008 10.2344L11.666 10.248H7.5C7.13273 10.248 6.83496 9.95028 6.83496 9.58301C6.83496 9.21574 7.13273 8.91797 7.5 8.91797H11.666ZM14.166 4.33496L14.3008 4.34863C14.6036 4.41083 14.8311 4.67881 14.8311 5C14.8309 5.32109 14.6035 5.58924 14.3008 5.65137L14.166 5.66504H7.5C7.13284 5.66504 6.83514 5.36712 6.83496 5C6.83496 4.63273 7.13273 4.33496 7.5 4.33496H14.166Z"
        fill="currentColor"
      />
    </svg>
  )
}

function SteerIcon(props: { class?: string }) {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class={props.class}
      aria-hidden="true"
    >
      <path
        d="M13.1293 7.34753C13.3565 7.12027 13.7081 7.09207 13.9662 7.26257L14.0707 7.34753L18.0707 11.3475C18.3304 11.6072 18.3304 12.0292 18.0707 12.2889L14.0707 16.2889C13.811 16.5486 13.389 16.5486 13.1293 16.2889C12.8696 16.0292 12.8696 15.6072 13.1293 15.3475L15.9935 12.4833H6.59998C4.57585 12.4833 2.93494 10.8424 2.93494 8.81824V5.31824C2.93494 4.95097 3.23271 4.6532 3.59998 4.6532C3.96724 4.6532 4.26501 4.95097 4.26501 5.31824V8.81824C4.26501 10.1078 5.31039 11.1532 6.59998 11.1532H15.9935L13.1293 8.28894L13.0443 8.18445C12.8738 7.92632 12.902 7.5748 13.1293 7.34753Z"
        fill="currentColor"
      />
    </svg>
  )
}

function DragDots(props: { class?: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" class={props.class} aria-hidden="true">
      <circle cx="9.5" cy="5.5" r="1.5" fill="currentColor" />
      <circle cx="9.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="9.5" cy="18.5" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="5.5" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="18.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function TrashIcon(props: { class?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M10.6299 1.33496C12.0335 1.33496 13.2695 2.25996 13.666 3.60645L13.8809 4.33496H17L17.1338 4.34863C17.4369 4.41057 17.665 4.67858 17.665 5C17.665 5.32142 17.4369 5.58943 17.1338 5.65137L17 5.66504H16.6543L15.8574 14.9912C15.7177 16.629 14.3478 17.8877 12.7041 17.8877H7.2959C5.75502 17.8877 4.45439 16.7815 4.18262 15.2939L4.14258 14.9912L3.34668 5.66504H3C2.63273 5.66504 2.33496 5.36727 2.33496 5C2.33496 4.63273 2.63273 4.33496 3 4.33496H6.11914L6.33398 3.60645L6.41797 3.3584C6.88565 2.14747 8.05427 1.33496 9.37012 1.33496H10.6299ZM5.46777 14.8779L5.49121 15.0537C5.64881 15.9161 6.40256 16.5576 7.2959 16.5576H12.7041C13.6571 16.5576 14.4512 15.8275 14.5322 14.8779L15.3193 5.66504H4.68164L5.46777 14.8779ZM7.66797 12.8271V8.66016C7.66797 8.29299 7.96588 7.99528 8.33301 7.99512C8.70028 7.99512 8.99805 8.29289 8.99805 8.66016V12.8271C8.99779 13.1942 8.70012 13.4912 8.33301 13.4912C7.96604 13.491 7.66823 13.1941 7.66797 12.8271ZM11.002 12.8271V8.66016C11.002 8.29289 11.2997 7.99512 11.667 7.99512C12.0341 7.9953 12.332 8.293 12.332 8.66016V12.8271C12.3318 13.1941 12.0339 13.491 11.667 13.4912C11.2999 13.4912 11.0022 13.1942 11.002 12.8271ZM9.37012 2.66504C8.60726 2.66504 7.92938 3.13589 7.6582 3.83789L7.60938 3.98145L7.50586 4.33496H12.4941L12.3906 3.98145C12.1607 3.20084 11.4437 2.66504 10.6299 2.66504H9.37012Z" />
    </svg>
  )
}

function MoreIcon(props: { class?: string }) {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class={props.class}
      aria-hidden="true"
    >
      <path
        d="M15.6981 9.04712C16.5255 9.04712 17.1959 9.71781 17.1961 10.5452C17.1961 11.3727 16.5256 12.0442 15.6981 12.0442C14.8706 12.0442 14.2 11.3727 14.2 10.5452C14.2002 9.71781 14.8707 9.04712 15.6981 9.04712Z"
        fill="currentColor"
      />
      <path
        d="M4.69806 9.04712C5.52546 9.04712 6.19691 9.71781 6.19708 10.5452C6.19708 11.3727 5.52557 12.0442 4.69806 12.0442C3.8707 12.044 3.20001 11.3726 3.20001 10.5452C3.20019 9.71792 3.87081 9.04729 4.69806 9.04712Z"
        fill="currentColor"
      />
      <path
        d="M10.2003 9.04712C11.0276 9.0473 11.6982 9.71792 11.6984 10.5452C11.6984 11.3726 11.0277 12.044 10.2003 12.0442C9.37284 12.0442 8.70132 11.3727 8.70132 10.5452C8.7015 9.71781 9.37295 9.04712 10.2003 9.04712Z"
        fill="currentColor"
      />
    </svg>
  )
}

type FollowupDockMode = "queued" | "ready" | "paused" | "failed"

function SessionFollowupRow(props: {
  item: { id: string; text: string; canSteer?: boolean; steerDisabledReason?: string }
  mode: FollowupDockMode
  sending?: string
  queueingEnabled: boolean
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onQueueingChange: (enabled: boolean) => void
}) {
  const language = useLanguage()
  const sortable = createSortable(props.item.id)
  const sending = () => props.sending === props.item.id
  const sendingAny = () => !!props.sending
  const dragging = () => sortable.isActiveDraggable
  const queued = () => props.mode === "queued"
  const dockActionLabel = () => {
    if (props.mode === "queued") return language.t("session.followupDock.reorderQueued")
    if (props.mode === "failed") return language.t("session.followupDock.reorderFailed")
    return language.t("session.followupDock.reorderReady")
  }

  return (
    <div
      ref={sortable.ref}
      style={maybeTransformStyle(sortable.transform)}
      data-slot="followup-row"
      class="group overflow-visible touch-none"
      classList={{ "opacity-60": sending() || sortable.isActiveDraggable }}
    >
      <div class="flex min-h-6 min-w-0 items-center justify-between gap-2 py-0.5 text-13-regular">
        <div class="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            {...sortable.dragActivators}
            data-followup-drag-handle
            class="relative -ml-3 flex h-4 cursor-grab touch-none items-center justify-center pl-3 active:cursor-grabbing"
            aria-label={dockActionLabel()}
          >
            <DragDots
              class={`pointer-events-none absolute left-0 top-1/2 z-10 size-4 -translate-y-1/2 text-icon-weak/70 transition-opacity ${
                dragging() ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            />
            <Show when={queued()}>
              <QueuedIcon
                class={`size-4 shrink-0 text-icon-weak/70 transition-opacity ${
                  dragging() ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                }`}
              />
            </Show>
          </span>
          <span class="line-clamp-2 min-w-0 leading-4 text-text-weak" title={props.item.text}>
            {props.item.text}
          </span>
        </div>
        <div class="flex shrink-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
          {/* slash command 在忙态只能排队；会话空闲后仍可用同一按钮按普通 command 发送。 */}
          <Show when={props.item.canSteer !== false || !queued()}>
            <Tooltip
              placement="top"
              value={followupSendNowTooltip({
                steerDisabledReason: props.item.steerDisabledReason,
                defaultTooltip: language.t("session.followupDock.sendNowTooltip"),
              })}
            >
              <Button
                type="button"
                size="small"
                variant="ghost"
                class="h-6 cursor-default gap-1 px-1.5 text-13-medium text-text-weak hover:text-text-base [&>svg]:size-4"
                disabled={followupSendNowDisabled({
                  sendingAny: sendingAny(),
                  steerDisabledReason: props.item.steerDisabledReason,
                })}
                data-active={sending() ? "true" : "false"}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  props.onSend(props.item.id)
                }}
                aria-label={language.t("session.followupDock.sendNow")}
              >
                <SteerIcon class="size-4 shrink-0" />
                {language.t("session.followupDock.sendNow")}
              </Button>
            </Tooltip>
          </Show>
          <Tooltip
            placement="top"
            value={
              queued()
                ? language.t("session.followupDock.deleteQueued")
                : language.t("session.followupDock.deleteReady")
            }
          >
            <button
              type="button"
              class="flex size-6 shrink-0 items-center justify-center rounded text-icon-weak transition-colors hover:bg-surface-base-hover hover:text-icon-base disabled:text-icon-disabled"
              disabled={sending()}
              aria-label={
                queued()
                  ? language.t("session.followupDock.deleteQueued")
                  : language.t("session.followupDock.deleteReady")
              }
              onClick={(event) => {
                event.stopPropagation()
                props.onDelete(props.item.id)
              }}
            >
              <TrashIcon class="size-4" />
            </button>
          </Tooltip>
          <DropdownMenu gutter={4} placement="top-end">
            <Tooltip
              placement="top"
              value={
                queued() ? language.t("session.followupDock.moreQueued") : language.t("session.followupDock.moreReady")
              }
            >
              <DropdownMenu.Trigger
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded text-icon-weak transition-colors hover:bg-surface-base-hover hover:text-icon-base disabled:text-icon-disabled data-[expanded]:bg-surface-base-active"
                disabled={sending()}
                aria-label={
                  queued()
                    ? language.t("session.followupDock.moreQueued")
                    : language.t("session.followupDock.moreReady")
                }
                onClick={(event: MouseEvent) => event.stopPropagation()}
              >
                <MoreIcon class="size-4" />
              </DropdownMenu.Trigger>
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="codex-chat-menu min-w-[152px]">
                <DropdownMenu.Item
                  onSelect={() => {
                    props.onEdit(props.item.id)
                  }}
                >
                  <Icon name="edit" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => {
                    props.onQueueingChange(!props.queueingEnabled)
                  }}
                >
                  <QueuedIcon class="size-4 text-icon-weak" />
                  <DropdownMenu.ItemLabel>
                    {props.queueingEnabled
                      ? language.t("session.followupDock.turnOffQueueing")
                      : language.t("session.followupDock.turnOnQueueing")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}

export function SessionFollowupDock(props: {
  items: { id: string; text: string; canSteer?: boolean; steerDisabledReason?: string }[]
  mode: FollowupDockMode
  sending?: string
  queueingEnabled: boolean
  activeDraggable?: string
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onQueueingChange: (enabled: boolean) => void
  onReorder: (ids: string[]) => void
}) {
  const language = useLanguage()
  const ids = createMemo(() => props.items.map((item) => item.id))
  const activeItem = createMemo(() => props.items.find((item) => item.id === props.activeDraggable))
  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    props.onDragStart(id)
  }
  const handleDragEnd = (event: DragEvent) => {
    const { draggable, droppable } = event
    props.onDragEnd()
    if (!draggable || !droppable) return

    const from = ids().indexOf(String(draggable.id))
    const to = ids().indexOf(String(droppable.id))
    if (from < 0 || to < 0 || from === to) return
    props.onReorder(move(ids(), from, to))
  }

  return (
    <DockTray
      data-component="session-followup-dock"
      class="relative min-w-0 overflow-clip rounded-t-[16px] rounded-b-none border-x border-t border-b-0 border-border-weak-base bg-background-base/70 text-text-base backdrop-blur-sm"
      style={{ "margin-bottom": "-1px" }}
    >
      <DragDropProvider onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <ConstrainDragXAxis />
        <div class="flex max-h-[30dvh] flex-col gap-px overflow-x-hidden overflow-y-auto py-1 pl-[17px] pr-3 no-scrollbar">
          <SortableProvider ids={ids()}>
            <For each={props.items}>
              {(item) => (
                <SessionFollowupRow
                  item={item}
                  mode={props.mode}
                  sending={props.sending}
                  queueingEnabled={props.queueingEnabled}
                  onSend={props.onSend}
                  onEdit={props.onEdit}
                  onDelete={props.onDelete}
                  onQueueingChange={props.onQueueingChange}
                />
              )}
            </For>
          </SortableProvider>
        </div>
        <DragOverlay>
          <Show when={activeItem()} keyed>
            {(item) => (
              <div class="rounded-lg bg-background-strong/95 px-3 py-1 text-13-regular text-text-weak shadow-lg backdrop-blur">
                <div class="flex min-w-0 items-center gap-1.5">
                  <Show when={props.mode === "queued"}>
                    <QueuedIcon class="size-4 shrink-0 text-icon-weak/70" />
                  </Show>
                  <span class="line-clamp-2 leading-4">{item.text}</span>
                </div>
              </div>
            )}
          </Show>
        </DragOverlay>
      </DragDropProvider>
    </DockTray>
  )
}
