import { Component, For, Show, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { Link } from "./link"
import { SettingsList } from "./settings-list"

type ThemeOption = {
  id: string
  name: string
}

const listClass =
  "[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none"
const selectClass = "settings-appearance-select"

export const SettingsAppearance: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const settings = useSettings()

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())
  const uiFontSize = () => settings.appearance.fontSize()
  const [uiFontSizeDraft, setUIFontSizeDraft] = createSignal(String(uiFontSize()))

  const commitUIFontSize = () => {
    const parsed = Number.parseFloat(uiFontSizeDraft())
    if (Number.isNaN(parsed)) {
      setUIFontSizeDraft(String(uiFontSize()))
      return
    }
    const next = Math.min(16, Math.max(11, Math.round(parsed * 2) / 2))
    settings.appearance.setFontSize(next)
    setUIFontSizeDraft(String(next))
  }

  createEffect(() => {
    setUIFontSizeDraft(String(uiFontSize()))
  })

  onMount(() => {
    void theme.loadThemes()
  })

  const themeModes = createMemo(() => [
    { value: "system" as ColorScheme, label: language.t("theme.scheme.system") },
    { value: "light" as ColorScheme, label: language.t("theme.scheme.light") },
    { value: "dark" as ColorScheme, label: language.t("theme.scheme.dark") },
  ])

  const labelColor = (mode: ColorScheme) => {
    if (theme.colorScheme() !== mode) return "text-text-base"
    const applied = theme.appliedMode()
    if (applied === "dark") return "text-white"
    return "text-black"
  }

  return (
    <div class="settings-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10 sm:pb-10">
      <style>{`
        [data-slot="select-select-trigger"].settings-appearance-select {
          width: 12.857rem;
          min-width: 12.857rem;
          height: 2.143rem;
          padding: 0 0.857rem;
          border: 1px solid var(--border-weaker-base);
          border-radius: 0.714rem;
          background: var(--surface-raised-stronger-non-alpha);
          gap: 0.571rem;
          justify-content: space-between;
          text-align: left;
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-appearance-select [data-slot="select-select-trigger-value"] {
          flex: 1;
          text-align: left;
          color: var(--text-strong);
          font-size: 1rem;
          font-weight: 400;
        }

        [data-slot="select-select-trigger"].settings-appearance-select [data-slot="select-select-trigger-icon"] {
          width: 1.143rem;
          height: 1.143rem;
          overflow: hidden;
          flex-shrink: 0;
          color: var(--icon-base);
          background: transparent;
          border-radius: 0;
        }
        [data-slot="select-select-trigger"].settings-appearance-select [data-slot="select-select-trigger-icon"] [data-slot="icon-svg"] {
          clip-path: inset(45% 0 0 0);
          transform: translateY(-0.071rem);
        }

        [data-slot="select-select-trigger"].settings-appearance-select:hover:not(:disabled),
        [data-slot="select-select-trigger"].settings-appearance-select[data-expanded],
        [data-slot="select-select-trigger"].settings-appearance-select[data-expanded]:hover:not(:disabled) {
          background: var(--input-hover);
          border-color: var(--border-weak-hover);
          box-shadow: none;
        }

        [data-slot="select-select-trigger"].settings-appearance-select:focus,
        [data-slot="select-select-trigger"].settings-appearance-select:focus-visible {
          background: var(--input-focus);
          border-color: var(--border-weak-hover);
          box-shadow: none;
        }

        .settings-appearance-font-input {
          width: 12.857rem;
          height: 2.143rem;
          padding: 0 0.571rem 0 0.714rem;
          border: 1px solid var(--border-weaker-base);
          border-radius: 0.714rem;
          background: var(--surface-raised-stronger-non-alpha);
          color: var(--text-strong);
          font-size: 0.857rem;
          text-align: center;
          outline: none;
          box-shadow: none;
        }

        .settings-appearance-font-input:hover {
          border-color: var(--border-weak-hover);
          background: var(--input-hover);
        }

        .settings-appearance-font-input:focus,
        .settings-appearance-font-input:focus-visible {
          border-color: var(--border-weak-hover);
          background: var(--input-focus);
        }

        .settings-appearance-font-size {
          width: 5.286rem;
          min-width: 5.286rem;
          height: 2.143rem;
          padding: 0 0.571rem 0 0.714rem;
          border: 1px solid var(--border-weaker-base);
          border-radius: 0.714rem;
          background: var(--surface-raised-stronger-non-alpha);
          color: var(--text-strong);
          font-size: 0.929rem;
          font-weight: 400;
          text-align: center;
          outline: none;
          box-shadow: none;
        }

        .settings-appearance-font-size:hover {
          border-color: var(--border-weak-hover);
          background: var(--input-hover);
        }

        .settings-appearance-font-size:focus,
        .settings-appearance-font-size:focus-visible {
          border-color: var(--border-weak-hover);
          background: var(--input-focus);
        }

        .settings-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: var(--border-weak-base) transparent;
        }

        .settings-scrollbar::-webkit-scrollbar {
          width: 0.714rem;
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

        .theme-mode-card {
          flex: 1;
          min-width: 0;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          border-radius: 0.857rem;
          border: 2px solid var(--border-weaker-base);
          background: var(--surface-weak);
          transition: border-color 150ms, background 150ms;
          overflow: hidden;
          padding: 0;
        }

        .theme-mode-card:hover {
          border-color: var(--border-weak-hover);
        }

        .theme-mode-card.active {
          border-color: #4098ff;
          background: color-mix(in srgb, #4098ff 8%, var(--surface-weak));
        }

        .theme-mode-card .preview-block {
          width: 100%;
          height: 10.857rem;
        }

        .theme-mode-card .preview-block svg {
          display: block;
          width: 100%;
          height: 100%;
        }

        .code-preview-block {
          font-family: var(--font-family-mono, ui-monospace, monospace);
          font-size: 0.786rem;
          line-height: 1.5;
          padding: 0.571rem 0.714rem;
          overflow: hidden;
        }

        .code-preview-container {
          display: flex;
          border: 1px solid var(--border-weaker-base);
          border-radius: 0.571rem;
          overflow: hidden;
          background: var(--background-base);
          color: var(--text-strong);
        }

        .code-preview-container > .code-preview-block:first-child {
          border-right: 1px solid var(--border-weaker-base);
        }

        .code-preview-block .keyword { color: var(--syntax-keyword); }
        .code-preview-block .string { color: var(--syntax-string); }
        .code-preview-block .property { color: var(--syntax-property); }
        .code-preview-block .number { color: var(--syntax-number); }
        .code-preview-block .comment { color: var(--syntax-comment); }
        .code-preview-block .punctuation { color: var(--syntax-punctuation); }
        .code-preview-block .type { color: var(--syntax-type); }

        .diff-line-num { color: var(--text-dim); font-size: 0.714rem; }

        .diff-delete-line {
          background-color: var(--surface-diff-delete-base);
          color: var(--text-diff-delete-base);
        }

        .diff-add-line {
          background-color: var(--surface-diff-add-base);
          color: var(--text-diff-add-base);
        }
      `}</style>

      <div
        class="sticky top-0 z-10"
        style={{
          background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)",
        }}
      >
        <div class="flex flex-col gap-1 pt-6 pb-4">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.appearance")}</h2>
        </div>
      </div>

      <div class="flex w-full flex-col gap-5">
        {/* Theme Mode Cards */}
        <div class="flex flex-col gap-1">
          <div class="flex gap-3">
            <For each={themeModes()}>
              {(mode) => (
                <div class="flex flex-1 flex-col items-center gap-2">
                  <button
                    type="button"
                    class="theme-mode-card"
                    classList={{ active: theme.colorScheme() === mode.value }}
                    onClick={() => theme.setColorScheme(mode.value)}
                    onMouseEnter={() => theme.previewColorScheme(mode.value)}
                    onMouseLeave={() => theme.cancelPreview()}
                    data-action={`settings-theme-mode-${mode.value}`}
                  >
                    <div class="relative">
                      <div class="preview-block">
                      <Show when={mode.value === "system"}>
                        <svg viewBox="0 0 280 160" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" class="h-full w-full">
                          <rect width="280" height="160" fill="#f8f9fa"/>
                          <rect x="0" y="0" width="72" height="160" fill="#e9ecef"/>
                          <rect x="0" y="0" width="280" height="24" fill="#dee2e6"/>
                          <circle cx="12" cy="12" r="4" fill="#adb5bd"/>
                          <circle cx="24" cy="12" r="4" fill="#adb5bd"/>
                          <circle cx="36" cy="12" r="4" fill="#adb5bd"/>
                          <rect x="12" y="40" width="40" height="5" rx="2.5" fill="#d0d0d0"/>
                          <rect x="12" y="52" width="30" height="5" rx="2.5" fill="#ddd"/>
                          <rect x="12" y="64" width="36" height="5" rx="2.5" fill="#ddd"/>
                          <rect x="12" y="76" width="28" height="5" rx="2.5" fill="#ddd"/>
                          <rect x="84" y="38" width="100" height="5" rx="2.5" fill="#dee2e6"/>
                          <rect x="84" y="50" width="70" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="62" width="85" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="74" width="60" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="86" width="90" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="140" y="0" width="140" height="160" fill="#1e1e2e"/>
                          <rect x="140" y="0" width="72" height="160" fill="#181825"/>
                          <rect x="140" y="0" width="140" height="24" fill="#313244"/>
                          <circle cx="152" cy="12" r="4" fill="#585b70"/>
                          <circle cx="164" cy="12" r="4" fill="#585b70"/>
                          <circle cx="176" cy="12" r="4" fill="#585b70"/>
                          <rect x="152" y="40" width="40" height="5" rx="2.5" fill="#45475a"/>
                          <rect x="152" y="52" width="30" height="5" rx="2.5" fill="#313244"/>
                          <rect x="152" y="64" width="36" height="5" rx="2.5" fill="#313244"/>
                          <rect x="152" y="76" width="28" height="5" rx="2.5" fill="#313244"/>
                          <rect x="224" y="38" width="100" height="5" rx="2.5" fill="#45475a"/>
                          <rect x="224" y="50" width="70" height="5" rx="2.5" fill="#313244"/>
                          <rect x="224" y="62" width="85" height="5" rx="2.5" fill="#313244"/>
                          <rect x="224" y="74" width="60" height="5" rx="2.5" fill="#313244"/>
                          <rect x="224" y="86" width="90" height="5" rx="2.5" fill="#313244"/>
                          <line x1="140" y1="0" x2="140" y2="160" stroke="#6c7086" stroke-width="1" stroke-dasharray="2 2"/>
                        </svg>
                      </Show>
                      <Show when={mode.value === "light"}>
                        <svg viewBox="0 0 280 160" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" class="h-full w-full">
                          <rect width="280" height="160" fill="#f8f9fa"/>
                          <rect x="0" y="0" width="72" height="160" fill="#e9ecef"/>
                          <rect x="0" y="0" width="280" height="24" fill="#dee2e6"/>
                          <circle cx="12" cy="12" r="4" fill="#adb5bd"/>
                          <circle cx="24" cy="12" r="4" fill="#adb5bd"/>
                          <circle cx="36" cy="12" r="4" fill="#adb5bd"/>
                          <rect x="12" y="40" width="40" height="5" rx="2.5" fill="#d0d0d0"/>
                          <rect x="12" y="52" width="30" height="5" rx="2.5" fill="#ddd"/>
                          <rect x="12" y="64" width="36" height="5" rx="2.5" fill="#ddd"/>
                          <rect x="84" y="38" width="120" height="5" rx="2.5" fill="#dee2e6"/>
                          <rect x="84" y="50" width="90" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="62" width="105" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="74" width="80" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="86" width="110" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="84" y="98" width="70" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="70" y="60" width="120" height="70" rx="6" fill="white" stroke="#dee2e6" stroke-width="1"/>
                          <rect x="82" y="76" width="65" height="5" rx="2.5" fill="#dee2e6"/>
                          <rect x="82" y="88" width="45" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="82" y="100" width="75" height="5" rx="2.5" fill="#e9ecef"/>
                          <rect x="82" y="112" width="40" height="5" rx="2.5" fill="#e9ecef"/>
                        </svg>
                      </Show>
                      <Show when={mode.value === "dark"}>
                        <svg viewBox="0 0 280 160" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" class="h-full w-full">
                          <rect width="280" height="160" fill="#1e1e2e"/>
                          <rect x="0" y="0" width="72" height="160" fill="#181825"/>
                          <rect x="0" y="0" width="280" height="24" fill="#313244"/>
                          <circle cx="12" cy="12" r="4" fill="#585b70"/>
                          <circle cx="24" cy="12" r="4" fill="#585b70"/>
                          <circle cx="36" cy="12" r="4" fill="#585b70"/>
                          <rect x="12" y="40" width="40" height="5" rx="2.5" fill="#45475a"/>
                          <rect x="12" y="52" width="30" height="5" rx="2.5" fill="#313244"/>
                          <rect x="12" y="64" width="36" height="5" rx="2.5" fill="#313244"/>
                          <rect x="84" y="38" width="120" height="5" rx="2.5" fill="#45475a"/>
                          <rect x="84" y="50" width="90" height="5" rx="2.5" fill="#313244"/>
                          <rect x="84" y="62" width="105" height="5" rx="2.5" fill="#313244"/>
                          <rect x="84" y="74" width="80" height="5" rx="2.5" fill="#313244"/>
                          <rect x="84" y="86" width="110" height="5" rx="2.5" fill="#313244"/>
                          <rect x="84" y="98" width="70" height="5" rx="2.5" fill="#313244"/>
                          <rect x="70" y="60" width="120" height="70" rx="6" fill="#252536" stroke="#313244" stroke-width="1"/>
                          <rect x="82" y="76" width="65" height="5" rx="2.5" fill="#45475a"/>
                          <rect x="82" y="88" width="45" height="5" rx="2.5" fill="#313244"/>
                          <rect x="82" y="100" width="75" height="5" rx="2.5" fill="#313244"/>
                          <rect x="82" y="112" width="40" height="5" rx="2.5" fill="#313244"/>
                        </svg>
                      </Show>
                    </div>
                    <Show when={theme.colorScheme() === mode.value}>
                      <div class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#4098ff]">
                        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M1 4L3.5 6.5L9 1" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </div>
                    </Show>
                  </div>
                </button>
                  <span class={`text-13-medium ${labelColor(mode.value)}`}>{mode.label}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        {/* Code Preview */}
        <div class="flex flex-col gap-1">
          <div class="code-preview-container">
            <div class="flex-1 code-preview-block">
              <div class="flex gap-2"><span class="diff-line-num w-4 shrink-0 text-right">1</span><span><span class="keyword">const</span> <span class="property">themePreview</span><span class="punctuation">:</span> <span class="type">ThemeConfig</span> <span class="punctuation">=</span> <span class="punctuation">{'{'}</span></span></div>
              <div class="flex gap-2 diff-delete-line"><span class="diff-line-num w-4 shrink-0 text-right">2</span><span>&nbsp;&nbsp;<span class="property">surface</span><span class="punctuation">:</span> <span class="string">"sidebar"</span><span class="punctuation">,</span></span></div>
              <div class="flex gap-2 diff-delete-line"><span class="diff-line-num w-4 shrink-0 text-right">3</span><span>&nbsp;&nbsp;<span class="property">accent</span><span class="punctuation">:</span> <span class="string">"#2563eb"</span><span class="punctuation">,</span></span></div>
              <div class="flex gap-2 diff-delete-line"><span class="diff-line-num w-4 shrink-0 text-right">4</span><span>&nbsp;&nbsp;<span class="property">contrast</span><span class="punctuation">:</span> <span class="number">42</span><span class="punctuation">,</span></span></div>
              <div class="flex gap-2"><span class="diff-line-num w-4 shrink-0 text-right">5</span><span><span class="punctuation">{'}'}</span><span class="punctuation">;</span></span></div>
            </div>
            <div class="flex-1 code-preview-block">
              <div class="flex gap-2"><span class="diff-line-num w-4 shrink-0 text-right">1</span><span><span class="keyword">const</span> <span class="property">themePreview</span><span class="punctuation">:</span> <span class="type">ThemeConfig</span> <span class="punctuation">=</span> <span class="punctuation">{'{'}</span></span></div>
              <div class="flex gap-2 diff-add-line"><span class="diff-line-num w-4 shrink-0 text-right">2</span><span>&nbsp;&nbsp;<span class="property">surface</span><span class="punctuation">:</span> <span class="string">"sidebar-elevated"</span><span class="punctuation">,</span></span></div>
              <div class="flex gap-2 diff-add-line"><span class="diff-line-num w-4 shrink-0 text-right">3</span><span>&nbsp;&nbsp;<span class="property">accent</span><span class="punctuation">:</span> <span class="string">"#0ea5e9"</span><span class="punctuation">,</span></span></div>
              <div class="flex gap-2 diff-add-line"><span class="diff-line-num w-4 shrink-0 text-right">4</span><span>&nbsp;&nbsp;<span class="property">contrast</span><span class="punctuation">:</span> <span class="number">68</span><span class="punctuation">,</span></span></div>
              <div class="flex gap-2"><span class="diff-line-num w-4 shrink-0 text-right">5</span><span><span class="punctuation">{'}'}</span><span class="punctuation">;</span></span></div>
            </div>
          </div>
        </div>

        {/* Theme Configuration */}
        <div class="flex flex-col gap-1">
          <div class={listClass}>
            <SettingsList>
              <SettingsRow
                title={language.t("settings.appearance.row.theme.title")}
                description={
                  <>
                    {language.t("settings.general.row.theme.description")}{" "}
                    <Link href="https://doc.wanlai.ai/">{language.t("common.learnMore")}</Link>
                  </>
                }
              >
                <Select
                  class={selectClass}
                  data-action="settings-theme"
                  options={themeOptions()}
                  current={themeOptions().find((o) => o.id === theme.themeId())}
                  value={(o) => o.id}
                  label={(o) => o.name}
                  onSelect={(option) => {
                    if (!option) return
                    theme.setTheme(option.id)
                  }}
                  onHighlight={(option) => {
                    if (!option) return
                    theme.previewTheme(option.id)
                    return () => theme.cancelPreview()
                  }}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </SettingsRow>

              <SettingsRow
                title={language.t("settings.appearance.row.uiFont.title")}
              >
                <input
                  data-action="settings-ui-font"
                  type="text"
                  value={sans()}
                  onInput={(e) => settings.appearance.setUIFont(e.currentTarget.value)}
                  placeholder={sansDefault}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="settings-appearance-font-input"
                  style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
                />
              </SettingsRow>

              <SettingsRow
                title={language.t("settings.appearance.row.codeFont.title")}
              >
                <input
                  data-action="settings-code-font"
                  type="text"
                  value={mono()}
                  onInput={(e) => settings.appearance.setFont(e.currentTarget.value)}
                  placeholder={monoDefault}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="settings-appearance-font-input"
                  style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                />
              </SettingsRow>

              <SettingsRow
                title={language.t("settings.appearance.row.terminalFont.title")}
              >
                <input
                  data-action="settings-terminal-font"
                  type="text"
                  value={terminal()}
                  onInput={(e) => settings.appearance.setTerminalFont(e.currentTarget.value)}
                  placeholder={terminalDefault}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="settings-appearance-font-input"
                  style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
                />
              </SettingsRow>

              <SettingsRow
                title={language.t("settings.appearance.row.uiFontSize.title")}
              >
                <div class="flex items-center gap-2">
                  <input
                    data-action="settings-ui-font-size"
                    class="settings-appearance-font-size"
                    type="number"
                    min="11"
                    max="16"
                    step="0.5"
                    value={uiFontSizeDraft()}
                    onInput={(event) => setUIFontSizeDraft(event.currentTarget.value)}
                    onBlur={commitUIFontSize}
                  />
                  <span class="text-12-regular text-text-weak">px</span>
                </div>
              </SettingsRow>
            </SettingsList>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description?: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 border-b border-border-weaker-base px-4 py-2.5 last:border-none sm:flex-nowrap sm:px-[14px]">
      <div class="flex min-w-0 flex-1 flex-col" classList={{ "gap-0.5": !!props.description }}>
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <Show when={props.description}>
          <span class="text-12-regular text-text-weak">{props.description}</span>
        </Show>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
