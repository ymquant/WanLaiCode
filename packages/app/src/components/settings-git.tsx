import { Component, type JSX } from "solid-js"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"

export const SettingsGit: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <>
      <style>{`
        .settings-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: var(--border-weak-base) transparent;
        }

        .settings-scrollbar::-webkit-scrollbar {
          width: 10px;
        }

        .settings-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb {
          background: var(--border-weak-base);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }

        .settings-scrollbar::-webkit-scrollbar-thumb:hover {
          background: var(--border-weak-hover);
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      <div class="settings-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10 sm:pb-10">
      <div
        class="sticky top-0 z-10"
        style={{
          background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)",
        }}
      >
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.git.title")}</h2>
        </div>
      </div>

      <div class="flex w-full flex-col gap-8">
        <div class="[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.git.row.branchPrefix.title")}
              description={language.t("settings.git.row.branchPrefix.description")}
            >
              <div class="w-full sm:w-[280px]">
                <TextField
                  data-action="settings-git-branch-prefix"
                  label={language.t("settings.git.row.branchPrefix.title")}
                  hideLabel
                  type="text"
                  value={settings.git.branchPrefix()}
                  onChange={(value) => settings.git.setBranchPrefix(value)}
                  placeholder="codex"
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="rounded-[14px] border-0 bg-transparent text-12-regular shadow-none"
                />
              </div>
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
      </div>
    </>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 border-b border-border-weaker-base px-4 py-4 last:border-none sm:flex-nowrap sm:px-[14px]">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
