import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"

export type SessionTimelineItem = {
  id: string
  text: string
  time: string
}

export const DialogSessionTimeline: Component<{
  items: () => SessionTimelineItem[]
  onSelect: (item: SessionTimelineItem) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.sessionTimeline.title")} description={language.t("dialog.sessionTimeline.description")}>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.sessionTimeline.empty")}
        key={(item) => item.id}
        items={props.items}
        filterKeys={["text"]}
        onSelect={(item) => {
          if (!item) return
          props.onSelect(item)
          dialog.close()
        }}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
