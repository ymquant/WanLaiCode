import type { CommandOption } from "@/context/command"
import type { SlashCommand } from "./slash-popover"

function slashTriggers(option: CommandOption) {
  const seen = new Set<string>()
  return [option.slash, ...(option.slashAliases ?? [])]
    .map((value) => value?.trim().replace(/^\/+/, ""))
    .filter((value): value is string => !!value)
    .filter((value) => {
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
}

export function builtinSlashCommands(options: CommandOption[]): SlashCommand[] {
  return options
    .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
    .flatMap((opt) =>
      slashTriggers(opt).map((trigger, index) => ({
        id: index === 0 ? opt.id : `${opt.id}.slash.${trigger}`,
        commandID: opt.id,
        trigger,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      })),
    )
}

export function orderedSlashCommands(input: { builtin: SlashCommand[]; custom: SlashCommand[] }) {
  return [...input.builtin, ...input.custom]
}
