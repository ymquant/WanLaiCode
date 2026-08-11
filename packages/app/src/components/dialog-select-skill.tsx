import { createQuery } from "@tanstack/solid-query"
import { Component, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Skill = {
  name: string
  description: string
  location: string
  content: string
}

export const DialogSelectSkill: Component<{ onSelect: (skill: Skill) => void }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()

  const skills = createQuery(() => ({
    queryKey: ["skill", "list", sdk.directory],
    queryFn: async () => (await sdk.client.app.skills()).data ?? [],
  }))

  const items = () => skills.data ?? []

  return (
    <Dialog title={language.t("dialog.skill.title")} description={language.t("dialog.skill.description")}>
      <Show when={skills.isError}>
        <div class="text-13-regular text-text-danger px-2 py-3">
          {language.t("dialog.skill.error")}
          {skills.error instanceof Error ? `: ${skills.error.message}` : ""}
        </div>
      </Show>
      <div class="px-2 pb-3">
        <Button
          class="w-full"
          variant="secondary"
          size="large"
          onClick={() => {
            dialog.close()
            navigate("/plugins")
          }}
        >
          {language.t("dialog.skill.library")}
        </Button>
      </div>
      <List
        search={{ placeholder: language.t("dialog.skill.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.skill.empty")}
        loadingMessage={language.t("common.loading.ellipsis")}
        key={(x) => x?.name ?? ""}
        items={items}
        filterKeys={["name", "description", "location"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={(skill) => {
          if (!skill) return
          props.onSelect(skill)
          dialog.close()
        }}
      >
        {(skill) => (
          <div class="w-full flex flex-col gap-0.5 min-w-0 text-left">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-14-regular text-text-strong truncate">/{skill.name}</span>
              <Show when={skill.location}>
                <span class="text-11-regular text-text-weaker truncate">{skill.location}</span>
              </Show>
            </div>
            <Show when={skill.description}>
              <span class="text-12-regular text-text-weak truncate">{skill.description}</span>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
