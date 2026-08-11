import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { useQueryClient } from "@tanstack/solid-query"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { createSettingsRulesSaveQueue, restoreSettingsRulesConfig } from "./settings-rules-save"

type Rule = { id: string; title: string; content: string; enabled: boolean }

export function SettingsRules() {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const queryClient = useQueryClient()
  const [state, setState] = createStore<{
    form?: Rule
    saving?: string
  }>({})
  const saveGen = new Map<string, number>()
  const enqueueSave = createSettingsRulesSaveQueue()
  const config = () => globalSync.data.config
  const rules = () => config().rules ?? []
  const imports = () => ({
    agents_md: config().instruction_import?.agents_md !== false,
    claude_md: config().instruction_import?.claude_md !== false,
  })
  const unavailable = () => globalSync.config.loading || globalSync.config.error || !!state.saving

  async function save(patch: Pick<Config, "instruction_import" | "rules">, saving: string) {
    const previous = queryClient.getQueryData<Config>(["config"])
    const optimistic = { ...previous, ...patch }
    const gen = (saveGen.get(saving) ?? 0) + 1
    saveGen.set(saving, gen)
    queryClient.setQueryData<Config>(["config"], optimistic)
    setState("saving", saving)
    try {
      await enqueueSave(() => globalSync.updateConfig(patch))
      return true
    } catch (error) {
      if (saveGen.get(saving) !== gen) return false
      const refreshed = await globalSync.config.refetch()
      if (refreshed.isError) {
        queryClient.setQueryData<Config>(["config"], (current) =>
          restoreSettingsRulesConfig({ current, optimistic, previous }),
        )
      }
      showToast({
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t, language.t("common.requestFailed")),
      })
      return false
    } finally {
      if (saveGen.get(saving) === gen) setState("saving", undefined)
    }
  }

  function setImport(key: "agents_md" | "claude_md", enabled: boolean) {
    void save({ instruction_import: { ...imports(), [key]: enabled } }, key)
  }

  function createRule() {
    setState("form", { id: crypto.randomUUID(), title: "", content: "", enabled: true })
  }

  function updateRule(rule: Rule) {
    setState("form", { ...rule })
  }

  function deleteRule(id: string) {
    void save({ rules: rules().filter((rule) => rule.id !== id) }, id)
  }

  async function saveRule() {
    if (!state.form?.title.trim() || !state.form.content.trim()) return
    const next = {
      ...state.form,
      title: state.form.title.trim(),
      content: state.form.content.trim(),
    }
    const isEdit = rules().some((rule) => rule.id === next.id)
    const updated = isEdit ? rules().map((rule) => rule.id === next.id ? next : rule) : [...rules(), next]
    try {
      if (await save({ rules: updated }, next.id)) setState("form", undefined)
    } catch {
      return
    }
  }

  return (
    <div class="settings-rules-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10">
      <style>{`
        .settings-rules-scrollbar { scrollbar-width: thin; scrollbar-color: var(--border-weak-base) transparent; }
        .settings-rules-scrollbar::-webkit-scrollbar { width: 10px; }
        .settings-rules-scrollbar::-webkit-scrollbar-thumb { background: var(--border-weak-base); border: 2px solid transparent; border-radius: 999px; background-clip: padding-box; }
        [data-component="switch"].settings-general-switch [data-slot="switch-control"] {
          width: 40px;
          height: 24px;
          border-radius: 999px;
          border: 1px solid var(--border-weaker-base);
          background: var(--surface-weak);
          transition: background-color 150ms, border-color 150ms;
        }
        [data-component="switch"].settings-general-switch [data-slot="switch-thumb"] {
          width: 18px;
          height: 18px;
          border: none;
          border-radius: 999px;
          background: var(--surface-raised-stronger-non-alpha);
          box-shadow: 0 1px 2px color-mix(in srgb, var(--text-strong) 12%, transparent);
          transform: translateX(2px);
          transition: transform 150ms, background-color 150ms;
        }
        [data-component="switch"].settings-general-switch:hover:not([data-disabled], [data-readonly]) [data-slot="switch-control"] {
          border-color: var(--border-weak-hover);
          background: var(--surface-weaker);
        }
        [data-component="switch"].settings-general-switch[data-checked] [data-slot="switch-control"] {
          border-color: #4098ff;
          background: #4098ff;
        }
        [data-component="switch"].settings-general-switch[data-checked] [data-slot="switch-thumb"] {
          transform: translateX(18px);
          background: #ffffff;
        }
        [data-component="switch"].settings-general-switch[data-checked]:hover:not([data-disabled], [data-readonly]) [data-slot="switch-control"] {
          border-color: #2f8cff;
          background: #2f8cff;
        }
        [data-component="switch"].settings-general-switch[data-disabled] [data-slot="switch-control"] {
          border-color: var(--border-weaker-base);
          background: var(--input-disabled);
        }
        [data-component="switch"].settings-general-switch[data-disabled] [data-slot="switch-thumb"] {
          background: var(--surface-raised-stronger-non-alpha);
        }
      `}</style>
      <div class="flex flex-col gap-7 pt-6">
        <section class="flex flex-col gap-3">
          <h2 class="text-14-medium text-text-strong">{language.t("settings.rules.import.title")}</h2>
          <div class="overflow-hidden rounded-lg border border-border-weaker-base bg-surface-base">
            <div class="flex min-h-16 items-center justify-between gap-4 border-b border-border-weaker-base px-4 py-3">
              <div class="min-w-0">
                <div class="text-13-medium text-text-strong">{language.t("settings.rules.import.agents.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("settings.rules.import.agents.description")}</div>
              </div>
              <Switch class="settings-general-switch shrink-0" checked={imports().agents_md} disabled={globalSync.config.loading || globalSync.config.error || !!state.saving} onChange={(checked) => setImport("agents_md", checked)} hideLabel>
                {language.t("settings.rules.import.agents.title")}
              </Switch>
            </div>
            <div class="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
              <div class="min-w-0">
                <div class="text-13-medium text-text-strong">{language.t("settings.rules.import.claude.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("settings.rules.import.claude.description")}</div>
              </div>
              <Switch class="settings-general-switch shrink-0" checked={imports().claude_md} disabled={globalSync.config.loading || globalSync.config.error || !!state.saving} onChange={(checked) => setImport("claude_md", checked)} hideLabel>
                {language.t("settings.rules.import.claude.title")}
              </Switch>
            </div>
          </div>
        </section>

        <Show when={globalSync.config.error}>
          <div class="flex items-center justify-between gap-4 border border-border-weaker-base bg-surface-base px-4 py-3">
            <div class="text-13-regular text-text-danger">{language.t("common.requestFailed")}</div>
            <Button size="small" variant="secondary" onClick={() => void globalSync.config.refetch()}>
              {language.t("common.retry")}
            </Button>
          </div>
        </Show>

        <section class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <h2 class="text-14-medium text-text-strong">{language.t("settings.rules.title")}</h2>
          </div>
          <div class="overflow-hidden rounded-lg border border-border-weaker-base bg-surface-base">
            <div class="flex items-center justify-between gap-4 border-b border-border-weaker-base px-4 py-3">
              <div>
                <div class="text-13-medium text-text-strong">{language.t("settings.rules.list.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">{language.t("settings.rules.list.description")}</div>
              </div>
              <Button size="small" variant="secondary" icon="plus" disabled={unavailable()} onClick={createRule}>{language.t("settings.rules.create")}</Button>
            </div>

            <Show when={state.form}>
              {(form) => (
                <div class="flex flex-col gap-3 border-b border-border-weaker-base px-4 py-4">
                  <TextField label={language.t("settings.rules.form.title")} value={form().title} onChange={(title) => setState("form", "title", title)} />
                  <TextField multiline label={language.t("settings.rules.form.content")} value={form().content} onChange={(content) => setState("form", "content", content)} class="min-h-28" />
                  <div class="flex justify-end gap-2">
                    <Button size="small" variant="ghost" onClick={() => setState("form", undefined)}>{language.t("common.cancel")}</Button>
                    <Button size="small" variant="secondary" disabled={unavailable() || !form().title.trim() || !form().content.trim()} onClick={saveRule}>{language.t("common.save")}</Button>
                  </div>
                </div>
              )}
            </Show>

            <Show when={rules().length > 0} fallback={
              <div class="flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
                <div class="text-13-medium text-text-base">{language.t("settings.rules.empty.title")}</div>
                <div class="text-12-regular text-text-weak">{language.t("settings.rules.empty.description")}</div>
              </div>
            }>
              <For each={rules()}>
                {(rule) => (
                  <div class="group flex items-start gap-3 border-b border-border-weaker-base px-4 py-3 last:border-0">
                    <Switch class="settings-general-switch mt-0.5 shrink-0" checked={rule.enabled} disabled={unavailable()} onChange={(enabled) => void save({ rules: rules().map((item) => item.id === rule.id ? { ...item, enabled } : item) }, rule.id)} hideLabel>{rule.title}</Switch>
                    <button type="button" class="min-w-0 flex-1 text-left" onClick={() => updateRule(rule)}>
                      <div class="truncate text-13-medium text-text-strong">{rule.title}</div>
                      <div class="mt-1 line-clamp-2 whitespace-pre-wrap text-12-regular text-text-weak">{rule.content}</div>
                    </button>
                    <IconButton icon="edit" variant="ghost" disabled={unavailable()} aria-label={language.t("common.edit")} onClick={() => updateRule(rule)} />
                    <IconButton icon="trash" variant="ghost" disabled={unavailable()} aria-label={language.t("common.delete")} onClick={() => deleteRule(rule.id)} />
                  </div>
                )}
              </For>
            </Show>
          </div>
        </section>
      </div>
    </div>
  )
}
