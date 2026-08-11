import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { createMemo, type Component } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { builtinSlashCommands } from "@/components/prompt-input/slash-commands"
import type { SlashCommand } from "@/components/prompt-input/slash-popover"

const HELP_COMMAND_TRIGGER_DELAY_MS = 120

export const DialogSlashHelp: Component = () => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const items = createMemo(() =>
    builtinSlashCommands(command.options)
      .filter((item) => item.trigger !== "help")
      .sort((a, b) => a.trigger.localeCompare(b.trigger)),
  )

  const select = (item: SlashCommand | undefined) => {
    if (!item) return
    const id = item.commandID ?? item.id
    dialog.close()
    setTimeout(() => command.trigger(id, "slash"), HELP_COMMAND_TRIGGER_DELAY_MS)
  }

  return (
    <Dialog title={language.t("dialog.slashHelp.title")} description={language.t("dialog.slashHelp.description")}>
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("dialog.slashHelp.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.slashHelp.empty")}
        key={(item) => item.id}
        items={items}
        filterKeys={["id", "title", "description"]}
        onSelect={select}
      >
        {(item) => (
          <div class="w-full flex flex-col gap-0.5 min-w-0 text-left">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-14-regular text-text-strong shrink-0">/{item.trigger}</span>
              <span class="text-12-regular text-text-weak truncate">{item.title}</span>
            </div>
            <span class="text-12-regular text-text-weaker truncate">{item.description}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
