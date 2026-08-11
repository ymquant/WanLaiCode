import { Component, createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useQuery } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { formatServerError } from "@/utils/server-errors"
import { SettingsList } from "./settings-list"

type ProxyMode = "system" | "manual" | "none"

const empty = {
  mode: "none" as ProxyMode,
  url: "",
  http_url: "",
  https_url: "",
  no_proxy: "",
}

function draftFromConfig(proxy: ReturnType<typeof useGlobalSync>["data"]["config"]["proxy"]) {
  return {
    mode: proxy?.mode ?? "none",
    url: proxy?.url ?? "",
    http_url: proxy?.http_url ?? "",
    https_url: proxy?.https_url ?? "",
    no_proxy: proxy?.no_proxy ?? "",
  }
}

// 校验代理地址是否可用(裸 host:port 视为 http://;只接受 http/https)。
// 仅校验、不重写用户输入——保存原文,规范化(补 scheme)由后端 supportedProxyUrl 统一处理,
// 避免输入框把裸 host:port 回显成带尾斜杠的形态、或把密码百分号编码,令用户困惑。
// 空串视为「清除代理」,合法。
function isValidProxyUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  if (!URL.canParse(withScheme)) return false
  const protocol = new URL(withScheme).protocol
  return protocol === "http:" || protocol === "https:"
}

export const SettingsProxy: Component<{ compact?: boolean }> = (props) => {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const [draft, setDraft] = createStore({ ...empty })

  const systemProxy = useQuery(() => ({
    queryKey: ["global", "proxy"],
    // 仅 system 模式展示检测值;默认 none/manual 下不必 spawn scutil/reg.exe 探测系统代理
    enabled: draft.mode === "system",
    queryFn: () => globalSDK.client.global.proxy.get().then((response) => response.data ?? {}),
  }))

  const modeOptions = createMemo(() => [
    { id: "system" as const, label: language.t("settings.proxy.mode.system") },
    { id: "manual" as const, label: language.t("settings.proxy.mode.manual") },
    { id: "none" as const, label: language.t("settings.proxy.mode.none") },
  ])
  const selectedMode = createMemo(() => modeOptions().find((option) => option.id === draft.mode) ?? modeOptions()[0])
  const fieldsDisabled = createMemo(() => draft.mode === "none")
  const systemSharedProxy = createMemo(() => {
    if (systemProxy.data?.all) return systemProxy.data.all
    if (systemProxy.data?.http && systemProxy.data.http === systemProxy.data.https) return systemProxy.data.http
    return ""
  })
  const display = {
    url: createMemo(() => (draft.mode === "system" ? systemSharedProxy() : draft.url)),
    http_url: createMemo(() => (draft.mode === "system" ? (systemProxy.data?.http ?? "") : draft.http_url)),
    https_url: createMemo(() => (draft.mode === "system" ? (systemProxy.data?.https ?? "") : draft.https_url)),
    no_proxy: createMemo(() => (draft.mode === "system" && !draft.no_proxy ? (systemProxy.data?.no_proxy ?? "") : draft.no_proxy)),
  }
  const placeholder = {
    url: createMemo(() =>
      draft.mode === "system"
        ? language.t("settings.proxy.placeholder.system.url")
        : language.t("settings.proxy.placeholder.url"),
    ),
    http_url: createMemo(() =>
      draft.mode === "system"
        ? language.t("settings.proxy.placeholder.system.httpUrl")
        : language.t("settings.proxy.placeholder.httpUrl"),
    ),
    https_url: createMemo(() =>
      draft.mode === "system"
        ? language.t("settings.proxy.placeholder.system.httpsUrl")
        : language.t("settings.proxy.placeholder.httpsUrl"),
    ),
    no_proxy: createMemo(() =>
      draft.mode === "system"
        ? language.t("settings.proxy.placeholder.system.noProxy")
        : language.t("settings.proxy.placeholder.noProxy"),
    ),
  }

  createEffect(() => {
    setDraft(draftFromConfig(globalSync.data.config.proxy))
  })

  function update(patch: Partial<typeof empty>) {
    const previous = globalSync.data.config.proxy
    const next = { ...draft, ...patch }
    setDraft(next)
    globalSync.set("config", "proxy", next)
    void globalSync.updateConfig({ proxy: next }).catch((err: unknown) => {
      const message = formatServerError(err, language.t, language.t("common.requestFailed"))
      setDraft(draftFromConfig(previous))
      globalSync.set("config", "proxy", previous)
      showToast({ title: language.t("common.requestFailed"), description: message })
    })
  }

  // 返回是否保存成功;非法时 toast 并返回 false,让 ProxyTextField 把输入框回退到已保存值。
  function updateManual(patch: Partial<typeof empty>): boolean {
    for (const key of ["url", "http_url", "https_url"] as const) {
      const raw = patch[key]
      if (raw === undefined || raw === "") continue
      if (!isValidProxyUrl(raw)) {
        // 非 http(s) 代理(如 socks5://)后端用不了,拒绝保存并提示,而非静默存下后降级直连
        showToast({
          title: language.t("common.requestFailed"),
          description: language.t("settings.proxy.error.invalidUrl"),
        })
        return false
      }
    }
    update({ ...patch, mode: "manual" }) // 保存原始输入,不重写(规范化交后端)
    return true
  }

  // compact 登录入口:填地址即用「手动代理」,并清掉设置页可能残留的 http/https 专项——
  // 否则 resolve 优先专项(https_url/http_url),刚填的通用地址不生效、登录仍失败;留空=不使用代理。
  function updateSharedProxy(url: string): boolean {
    const trimmed = url.trim()
    if (trimmed && !isValidProxyUrl(trimmed)) {
      showToast({ title: language.t("common.requestFailed"), description: language.t("settings.proxy.error.invalidUrl") })
      return false
    }
    update({ url: trimmed, http_url: "", https_url: "", mode: trimmed ? "manual" : "none" })
    return true
  }

  function updateNoProxy(no_proxy: string) {
    update({ no_proxy })
  }

  const proxyFields = (advanced: boolean) => (
    <SettingsList>
      <SettingsRow
        title={language.t("settings.proxy.row.mode.title")}
        description={language.t("settings.proxy.row.mode.description")}
      >
        <Select
          class="settings-general-select"
          options={modeOptions()}
          current={selectedMode()}
          value={(option) => option.id}
          label={(option) => option.label}
          onSelect={(option) => option && update({ mode: option.id })}
          variant="secondary"
          size="small"
          triggerVariant="settings"
        />
      </SettingsRow>

      <SettingsRow
        title={language.t("settings.proxy.row.url.title")}
        description={language.t("settings.proxy.row.url.description")}
      >
        <ProxyTextField
          value={display.url()}
          disabled={props.compact ? draft.mode === "system" : fieldsDisabled()}
          label={language.t("settings.proxy.row.url.title")}
          placeholder={placeholder.url()}
          onCommit={props.compact ? updateSharedProxy : (url) => updateManual({ url })}
        />
      </SettingsRow>

      <Show when={advanced}>
        <SettingsRow
          title={language.t("settings.proxy.row.httpUrl.title")}
          description={language.t("settings.proxy.row.httpUrl.description")}
        >
          <ProxyTextField
            value={display.http_url()}
            disabled={fieldsDisabled()}
            label={language.t("settings.proxy.row.httpUrl.title")}
            placeholder={placeholder.http_url()}
            onCommit={(http_url) => updateManual({ http_url })}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.proxy.row.httpsUrl.title")}
          description={language.t("settings.proxy.row.httpsUrl.description")}
        >
          <ProxyTextField
            value={display.https_url()}
            disabled={fieldsDisabled()}
            label={language.t("settings.proxy.row.httpsUrl.title")}
            placeholder={placeholder.https_url()}
            onCommit={(https_url) => updateManual({ https_url })}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.proxy.row.noProxy.title")}
          description={language.t("settings.proxy.row.noProxy.description")}
        >
          <ProxyTextField
            value={display.no_proxy()}
            disabled={fieldsDisabled()}
            label={language.t("settings.proxy.row.noProxy.title")}
            placeholder={placeholder.no_proxy()}
            onCommit={updateNoProxy}
          />
        </SettingsRow>
      </Show>
    </SettingsList>
  )

  const cardWrap = (children: JSX.Element) => (
    <div class="[&>div]:rounded-[18px] [&>div]:border [&>div]:border-border-weaker-base [&>div]:bg-surface-raised-stronger-non-alpha [&>div]:px-0 [&>div]:shadow-none">
      {children}
    </div>
  )

  return (
    <Show
      when={props.compact}
      fallback={
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
                <h2 class="text-16-medium text-text-strong">{language.t("settings.proxy.title")}</h2>
                <p class="text-12-regular text-text-weak">{language.t("settings.proxy.description")}</p>
              </div>
            </div>

            <div class="flex w-full flex-col gap-8">{cardWrap(proxyFields(true))}</div>
          </div>
        </>
      }
    >
      <div class="flex flex-col gap-4 px-2.5 pb-3">{cardWrap(proxyFields(false))}</div>
    </Show>
  )
}

const ProxyTextField: Component<{
  value: string
  disabled: boolean
  label: string
  placeholder: string
  onCommit: (value: string) => void | boolean
}> = (props) => {
  const [value, setValue] = createSignal(props.value)

  createEffect(() => setValue(props.value))

  function commit() {
    if (value() === props.value) return
    // onCommit 返回 false 表示校验失败未保存(如非法代理地址),把输入框回退到已保存值,避免残留误导
    if (props.onCommit(value()) === false) revert()
  }

  function revert() {
    setValue(props.value)
  }

  function blur(event: KeyboardEvent) {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur()
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
      blur(event)
    }
    if (event.key === "Escape") {
      event.preventDefault()
      revert()
      blur(event)
    }
  }

  return (
    <div class="w-full sm:w-[320px]">
      <TextField
        label={props.label}
        hideLabel
        type="text"
        value={value()}
        disabled={props.disabled}
        placeholder={props.placeholder}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        onChange={setValue}
        onBlur={commit}
        onKeyDown={keyDown}
        class="rounded-[14px] border-0 bg-transparent text-12-regular shadow-none disabled:opacity-60"
      />
    </div>
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
