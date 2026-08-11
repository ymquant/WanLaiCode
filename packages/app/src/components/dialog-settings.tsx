import { Component, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsAppearance } from "./settings-appearance"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsGit } from "./settings-git"
import { SettingsPersonalization } from "./settings-personalization"
import { SettingsEnvironment } from "./settings-environment"
import { SettingsProxy } from "./settings-proxy"
import { SettingsArchivedSessions } from "./settings-archived-sessions"
import { SettingsMemory } from "./settings-memory"
import { SettingsRemoteControl } from "./settings-remote-control"
import { SettingsAppSnapshots } from "./settings-app-snapshots"
import { SettingsRules } from "./settings-rules"

export type SettingsTab =
  | "general"
  | "appearance"
  | "shortcuts"
  | "appSnapshots"
  | "memory"
  | "rules"
  | "providers"
  | "models"
  | "git"
  | "proxy"
  | "personalization"
  | "environment"
  | "archivedSessions"
  | "remoteControl"

export interface DialogSettingsProps {
  tab?: SettingsTab
  scratchChatDir?: () => string | undefined
}

export const DialogSettings: Component<DialogSettingsProps> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <Dialog size="x-large" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        defaultValue={
          props.tab === "remoteControl" && platform.platform !== "desktop" ? "general" : (props.tab ?? "general")
        }
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="settings-gear2" viewBox="0 0 1024 1024" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.tab.general")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="appearance">
                      <Icon name="sun" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.tab.appearance")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.tab.shortcuts")}</span>
                    </Tabs.Trigger>
                    <Show when={platform.platform === "desktop" && platform.os === "macos"}>
                      <Tabs.Trigger value="appSnapshots">
                        <Icon name="window-cursor" style={{ width: "15px", height: "15px" }} />
                        <span class="font-sans text-[13px]">{language.t("appSnapshots.title")}</span>
                      </Tabs.Trigger>
                    </Show>
                    <Tabs.Trigger value="personalization">
                      <Icon name="personalization2" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.personalization.title")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="memory">
                      <Icon name="brain" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.memory.title")}</span>
                    </Tabs.Trigger>
                    {/* 手机连接只由桌面 sidecar 持有，Web 渲染器不能展示必然不可用的入口。 */}
                    <Show when={platform.platform === "desktop"}>
                      <Tabs.Trigger value="remoteControl">
                        <Icon name="laptop" style={{ width: "15px", height: "15px" }} />
                        <span class="font-sans text-[13px]">{language.t("settings.remote.title")}</span>
                      </Tabs.Trigger>
                    </Show>
                    {/* 保留 main 新增的规则入口，与桌面快照和远控入口并列展示。 */}
                    <Tabs.Trigger value="rules">
                      <Icon name="bullet-list" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.rules.title")}</span>
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.providers.title")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="providers2" viewBox="0 0 1024 1024" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.models.title")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="git">
                      <Icon
                        name="git-branch-filled2"
                        viewBox="0 0 1024 1024"
                        style={{ width: "15px", height: "15px" }}
                      />
                      <span class="font-sans text-[13px]">{language.t("settings.git.title")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="proxy">
                      <Icon name="globe" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.proxy.title")}</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger value="environment">
                      <Icon name="folder" viewBox="0 0 20 20" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.environment.title")}</span>
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.archived")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="archivedSessions">
                      <Icon name="archive" style={{ width: "15px", height: "15px" }} />
                      <span class="font-sans text-[13px]">{language.t("settings.archivedSessions.title")}</span>
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="appearance" class="no-scrollbar">
          <SettingsAppearance />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="appSnapshots" class="no-scrollbar">
          <SettingsAppSnapshots />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="git" class="no-scrollbar">
          <SettingsGit />
        </Tabs.Content>
        <Tabs.Content value="proxy" class="no-scrollbar">
          <SettingsProxy />
        </Tabs.Content>
        <Tabs.Content value="personalization" class="no-scrollbar">
          <SettingsPersonalization />
        </Tabs.Content>
        <Tabs.Content value="memory" class="no-scrollbar">
          <SettingsMemory />
        </Tabs.Content>
        {/* 设置内容仅在桌面宿主通过本地生成 SDK 管理 gateway 状态。 */}
        <Show when={platform.platform === "desktop"}>
          <Tabs.Content value="remoteControl" class="no-scrollbar">
            <SettingsRemoteControl />
          </Tabs.Content>
        </Show>
        {/* 规则页沿用 main 的持久化编辑能力，不影响远控的独立内容页。 */}
        <Tabs.Content value="rules" class="no-scrollbar">
          <SettingsRules />
        </Tabs.Content>
        <Tabs.Content value="environment" class="no-scrollbar">
          <SettingsEnvironment scratchChatDir={props.scratchChatDir} />
        </Tabs.Content>
        <Tabs.Content value="archivedSessions" class="no-scrollbar">
          <SettingsArchivedSessions />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
