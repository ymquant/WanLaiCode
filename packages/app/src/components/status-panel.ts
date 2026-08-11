export type StatusPresentation = "popover" | "dialog"

export const statusPanelClassList = (presentation: StatusPresentation = "popover") => ({
  "w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]": presentation === "popover",
  "w-full": presentation === "dialog",
})

export const statusPanelStyle = (presentation: StatusPresentation = "popover") => {
  if (presentation === "dialog") {
    return {
      tabs: "tabs bg-transparent overflow-hidden",
      tabList: "bg-transparent border-b-0 px-4 pt-2 pb-0 gap-0 h-10 [&::after]:!hidden",
      tab: "text-12-regular flex-1 min-w-0 justify-center",
      tabButton: "w-full justify-center",
      content: "flex flex-col px-4 pb-2",
      surface: "flex flex-col p-3 min-h-14",
      action: "secondary",
    } as const
  }

  return {
    tabs: "tabs bg-background-strong overflow-hidden",
    tabList: "bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10",
    tab: "text-12-regular",
    tabButton: undefined,
    content: "flex flex-col px-2 pb-2",
    surface: "flex flex-col p-3 bg-background-base rounded-sm min-h-14",
    action: "secondary",
  } as const
}
