import { Component, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"

export const SettingsPersonalization: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const [draft, setDraft] = createSignal(settings.personalization.customInstructions())
  const dirty = () => draft() !== settings.personalization.customInstructions()
  const save = () => {
    settings.personalization.setCustomInstructions(draft())
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.personalization.saved"),
    })
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-8 no-scrollbar sm:px-10 sm:pb-10">
      <div
        class="sticky top-0 z-10"
        style={{
          background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)",
        }}
      >
        <div class="flex flex-col gap-1 pt-6 pb-6">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.personalization.title")}</h2>
        </div>
      </div>

      <div class="flex w-full flex-col gap-6">
        <SettingsList>
          <SettingsRow
            title={language.t("settings.personalization.customInstructions.title")}
            description={language.t("settings.personalization.customInstructions.description")}
          >
            <div class="w-full" />
          </SettingsRow>
        </SettingsList>

        <div class="flex flex-col gap-4">
          <div>
            <TextField
              data-action="settings-personalization-custom-instructions"
              label={language.t("settings.personalization.customInstructions.title")}
              hideLabel
              type="text"
              multiline
              value={draft()}
              onChange={setDraft}
              placeholder={language.t("settings.personalization.customInstructions.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="min-h-[300px] resize-y rounded-[22px] px-4 py-4 shadow-none"
            />
          </div>
          <div class="flex justify-end">
            <Button
              type="button"
              variant="primary"
              size="normal"
              disabled={!dirty()}
              class="h-8 rounded-full px-4 text-14-medium !shadow-none"
              onClick={save}
            >
              {language.t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string
  description: string
  children: import("solid-js").JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 border-b border-border-weak-base py-3 last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
