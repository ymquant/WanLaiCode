import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import { brandNameEn } from "@opencode-ai/brand"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createResource, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { useQueryClient } from "@tanstack/solid-query"
import { formatServerError } from "@/utils/server-errors"
import { completeWanlaiCodeLogin } from "./wanlaicode-login-complete"

type ValidationResult =
  | { ok: true }
  | {
      ok: false
      status?: number
      code?: string
      message?: string
      debug?: string
    }

export function DialogConnectProvider(props: { provider: string; preferredMethod?: "oauth" | "api"; hideBackButton?: boolean }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const providers = useProviders()
  const queryClient = useQueryClient()

  const all = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const alive = { value: true }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    alive.value = false
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const provider = createMemo(() => {
    return (
      providers.all().find((x) => x.id === props.provider) ??
      globalSync.data.provider.all.find((x) => x.id === props.provider) ??
      (props.provider === "wanlaicode"
        ? {
            id: "wanlaicode",
            name: brandNameEn(),
            env: ["WANLAICODE_API_KEY"],
            models: {},
          }
        : {
            id: props.provider,
            name: props.provider,
            env: [],
            models: {},
          })
    )
  })
  const fallback = createMemo<ProviderAuthMethod[]>(() => {
    if (props.provider === "wanlaicode") {
      return [
        {
          type: "oauth" as const,
          label: language.t("login.wanlaicode.continue"),
        },
        {
          type: "api" as const,
          label: language.t("login.wanlaicode.other"),
        },
      ]
    }
    return [
      {
        type: "api" as const,
        label: language.t("provider.connect.method.apiKey"),
      },
    ]
  })
  const [auth] = createResource(
    () => props.provider,
    async () => {
      const cached = globalSync.data.provider_auth[props.provider]
      if (cached) return cached
      const res = await globalSDK.client.provider.auth()
      if (!alive.value) return fallback()
      globalSync.set("provider_auth", res.data ?? {})
      return res.data?.[props.provider] ?? fallback()
    },
  )
  const loading = createMemo(() => auth.loading && !globalSync.data.provider_auth[props.provider])
  const methods = createMemo(() => auth.latest ?? globalSync.data.provider_auth[props.provider] ?? fallback())
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: "pending" as undefined | "pending" | "complete" | "error" | "prompt",
    error: undefined as string | undefined,
    submitting: false,
  })

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: ProviderAuthAuthorization }
    | { type: "auth.error"; error: string }
    | { type: "submit.start" }
    | { type: "submit.finish" }

  function dispatch(action: Action) {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          draft.submitting = false
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          draft.submitting = false
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        if (action.type === "submit.start") {
          draft.submitting = true
          draft.error = undefined
          return
        }
        if (action.type === "submit.finish") {
          draft.submitting = false
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))

  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "api") return language.t("provider.connect.method.apiKey")
    return value.label ?? ""
  }

  function formatError(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && "data" in value) {
      const data = (value as { data?: { message?: unknown } }).data
      if (typeof data?.message === "string" && data.message) return data.message
    }
    if (value && typeof value === "object" && "error" in value) {
      const nested = formatError((value as { error?: unknown }).error, "")
      if (nested) return nested
    }
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message
      if (typeof message === "string" && message) return message
    }
    if (value instanceof Error && value.message) return value.message
    if (typeof value === "string" && value) return value
    return fallback
  }

  function classifyOAuthError(value: unknown): string {
    const message = formatError(value, "")
    const normalized = message.toLowerCase()

    if (normalized.includes("oauth callback timeout") || normalized.includes("callback timeout") || normalized.includes("took too long")) {
      return language.t("provider.connect.oauth.error.timeout")
    }
    if (normalized.includes("user cancelled") || normalized.includes("cancelled") || normalized.includes("canceled")) {
      return language.t("provider.connect.oauth.error.cancelled")
    }
    if (normalized.includes("invalid oauth state") || normalized.includes("csrf")) {
      return language.t("provider.connect.oauth.error.invalidState")
    }
    if (normalized.includes("missing authorization code") || normalized.includes("no authorization code")) {
      return language.t("provider.connect.oauth.error.missingCode")
    }
    if (normalized.includes("access denied") || normalized.includes("user denied")) {
      return language.t("provider.connect.oauth.error.accessDenied")
    }
    if (normalized.includes("network") || normalized.includes("econn") || normalized.includes("fetch")) {
      return language.t("provider.connect.oauth.error.network")
    }
    if (normalized.includes("server stopped")) {
      return language.t("provider.connect.oauth.error.serverStopped")
    }
    return language.t("provider.connect.oauth.error.unknown")
  }

  function classifyApiKeyError(value: unknown) {
    // 先用 resolveError 统一解析 reason/status → category
    const resolved = resolveError(value)
    switch (resolved.category) {
      case "api_key_invalid":
      case "auth_invalid":
      case "auth_expired":
        return language.t("provider.connect.apiKey.error.invalid")
      case "entitlement_missing":
      case "subscription_expired":
      case "subscription_suspended":
        return language.t("provider.connect.apiKey.error.noEntitlement")
    }
    // validate 语境领域启发式：无精确码的 403 仍按「无权益」展示（精确码已在上方 switch 处理）。
    const status =
      value && typeof value === "object"
        ? (((value as any).status as number | undefined) ?? ((value as any).response?.status as number | undefined))
        : undefined
    if (status === 403) return language.t("provider.connect.apiKey.error.noEntitlement")
    // 网络/本地 文本降级兜底
    const message = formatError(value, "")
    const normalized = message.toLowerCase()
    if (
      normalized.includes("fetch") ||
      normalized.includes("network") ||
      normalized.includes("econn") ||
      normalized.includes("timedout")
    ) {
      return language.t("provider.connect.apiKey.error.network")
    }
    if (message) return message
    return language.t("provider.connect.apiKey.error.local")
  }

  async function validateWanlaiCodeApiKey(apiKey: string): Promise<ValidationResult> {
    const response = await globalSDK.client.provider.wanlaicode.apiKey
      .validate({ apiKey })
      .catch((error: unknown) => ({ error }))

    if (response && typeof response === "object" && "error" in response) {
      const error = response.error
      const message = formatServerError(error, undefined, language.t("provider.connect.apiKey.error.local"))
      return {
        ok: false,
        message,
        debug: `wanlaicode validation fetch failed: ${message}`,
      }
    }

    const result = response as { data?: { ok?: boolean } }
    if (result.data?.ok) return { ok: true }

    return {
      ok: false,
      message: language.t("provider.connect.apiKey.error.local"),
    }
  }

  async function selectMethod(index: number, inputs?: Record<string, string>) {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    const method = methods()[index]
    dispatch({ type: "method.select", index })

    if (method.type === "oauth") {
      if (method.prompts?.length && !inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.pending" })
      const start = Date.now()
      await globalSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.provider,
            method: index,
            inputs,
          },
          { throwOnError: true },
        )
        .then((x) => {
          if (!alive.value) return
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              if (!alive.value) return
              dispatch({ type: "auth.complete", authorization: x.data! })
            }, delay)
            return
          }
          dispatch({ type: "auth.complete", authorization: x.data! })
        })
        .catch((e) => {
          if (!alive.value) return
          dispatch({ type: "auth.error", error: classifyOAuthError(e) })
        })
    }
  }

  function OAuthPromptsView() {
    const [formStore, setFormStore] = createStore({
      value: {} as Record<string, string>,
      index: 0,
    })

    const prompts = createMemo<NonNullable<ProviderAuthMethod["prompts"]>>(() => {
      const value = method()
      if (value?.type !== "oauth") return []
      return value.prompts ?? []
    })
    const matches = (prompt: NonNullable<ReturnType<typeof prompts>[number]>, value: Record<string, string>) => {
      if (!prompt.when) return true
      const actual = value[prompt.when.key]
      if (actual === undefined) return false
      return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
    }
    const current = createMemo(() => {
      const all = prompts()
      const index = all.findIndex((prompt, index) => index >= formStore.index && matches(prompt, formStore.value))
      if (index === -1) return
      return {
        index,
        prompt: all[index],
      }
    })
    const valid = createMemo(() => {
      const item = current()
      if (!item || item.prompt.type !== "text") return false
      const value = formStore.value[item.prompt.key] ?? ""
      return value.trim().length > 0
    })

    async function next(index: number, value: Record<string, string>) {
      if (store.methodIndex === undefined) return
      const next = prompts().findIndex((prompt, i) => i > index && matches(prompt, value))
      if (next !== -1) {
        setFormStore("index", next)
        return
      }
      await selectMethod(store.methodIndex, value)
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      const item = current()
      if (!item || item.prompt.type !== "text") return
      if (!valid()) return
      await next(item.index, formStore.value)
    }

    const item = () => current()
    const text = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "text") return
      return prompt
    })
    const select = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "select") return
      return prompt
    })

    return (
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <Switch>
          <Match when={item()?.prompt.type === "text"}>
            <TextField
              type="text"
              label={text()?.message ?? ""}
              placeholder={text()?.placeholder}
              value={text() ? (formStore.value[text()!.key] ?? "") : ""}
              onChange={(value) => {
                const prompt = text()
                if (!prompt) return
                setFormStore("value", prompt.key, value)
              }}
            />
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={!valid()}>
              {language.t("common.continue")}
            </Button>
          </Match>
          <Match when={item()?.prompt.type === "select"}>
            <div class="w-full flex flex-col gap-1.5">
              <div class="text-14-regular text-text-base">{select()?.message}</div>
              <div>
                <List
                  items={select()?.options ?? []}
                  key={(x) => x.value}
                  current={select()?.options.find((x) => x.value === formStore.value[select()!.key])}
                  onSelect={(value) => {
                    if (!value) return
                    const prompt = select()
                    if (!prompt) return
                    const nextValue = {
                      ...formStore.value,
                      [prompt.key]: value.value,
                    }
                    setFormStore("value", prompt.key, value.value)
                    void next(item()!.index, nextValue)
                  }}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{option.label}</span>
                      <span class="text-14-regular text-text-weak">{option.hint}</span>
                    </div>
                  )}
                </List>
              </div>
            </div>
          </Match>
        </Switch>
      </form>
    )
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  let auto = false
  createEffect(() => {
    if (auto) return
    if (loading()) return
    if (methods().length === 1) {
      auto = true
      void selectMethod(0)
      return
    }
    if (props.preferredMethod) {
      const index = methods().findIndex((m) => m.type === props.preferredMethod)
      if (index !== -1) {
        auto = true
        void selectMethod(index)
      }
    }
  })

  async function complete() {
    const openMainWindow = window.api?.openMainWindow
    await completeWanlaiCodeLogin({
      dispose: () => globalSDK.client.global.dispose(),
      invalidateBootstrap: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
      invalidateProviders: () =>
        queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === "providers" }),
      openMainWindow,
    })
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: provider().name }),
      description: language.t("provider.connect.toast.connected.description", { provider: provider().name }),
    })
  }

  function goBack() {
    if (methods().length === 1) {
      all()
      return
    }
    if (store.authorization) {
      dispatch({ type: "method.reset" })
      return
    }
    if (store.methodIndex !== undefined) {
      dispatch({ type: "method.reset" })
      return
    }
    all()
  }

  function MethodSelection() {
    const filteredMethods = createMemo(() =>
      props.provider === "wanlaicode" ? methods().filter((m) => m.type !== "oauth") : methods(),
    )
    return (
      <>
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.selectMethod", { provider: provider().name })}
        </div>
        <div>
          <List
            ref={(ref) => {
              listRef = ref
            }}
            items={filteredMethods}
            key={(m) => m?.label}
            onSelect={async (selected) => {
              if (!selected) return
              const originalIndex = methods().findIndex((m) => m.label === selected.label)
              if (originalIndex === -1) return
              void selectMethod(originalIndex)
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-x-2">
                <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                  <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                </div>
                <span>{methodLabel(i)}</span>
              </div>
            )}
          </List>
        </div>
      </>
    )
  }

  function ApiAuthView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      if (store.submitting) return

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const apiKey = formData.get("apiKey") as string

      if (!apiKey?.trim()) {
        setFormStore("error", language.t("provider.connect.apiKey.required"))
        return
      }

      setFormStore("error", undefined)
      dispatch({ type: "submit.start" })

      if (props.provider === "wanlaicode") {
        const validation = await validateWanlaiCodeApiKey(apiKey.trim())
        dispatch({ type: "submit.finish" })
        if (!validation.ok) {
          showToast({
            variant: "error",
            title: language.t("provider.connect.apiKey.error.title"),
          })
          return
        }
        await globalSDK.client.auth.set({
          providerID: props.provider,
          auth: {
            type: "api",
            key: apiKey.trim(),
          },
        })
        await complete()
        return
      }

      const result = await globalSDK.client.auth
        .set({
          providerID: props.provider,
          auth: {
            type: "api",
            key: apiKey.trim(),
          },
        })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      dispatch({ type: "submit.finish" })

      if (!result.ok) {
        setFormStore("error", classifyApiKeyError(result.error))
        return
      }

      await complete()
    }

    return (
      <div class="flex flex-col gap-6">
        <Switch>
          <Match when={true}>
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.apiKey.description", { provider: provider().name })}
            </div>
          </Match>
        </Switch>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("provider.connect.apiKey.label", { provider: provider().name })}
            placeholder={language.t("provider.connect.apiKey.placeholder")}
            name="apiKey"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
            disabled={store.submitting}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary" disabled={store.submitting}>
            {store.submitting ? language.t("provider.connect.status.inProgress") : language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthCodeView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const code = formData.get("code") as string

      if (!code?.trim()) {
        setFormStore("error", language.t("provider.connect.oauth.code.required"))
        return
      }

      setFormStore("error", undefined)
      const result = await globalSDK.client.provider.oauth
        .callback({
          providerID: props.provider,
          method: store.methodIndex,
          code,
        })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      if (result.ok) {
        await complete()
        return
      }
      // 优先走 resolveError 语义分类，对语义错误给精确文案；否则降级为原始消息或兜底
      const oauthResolved = resolveError(result.error)
      if (oauthResolved.category !== "unknown") {
        setFormStore("error", language.t(oauthResolved.messageKey as any))
      } else {
        setFormStore("error", formatError(result.error, language.t("provider.connect.oauth.code.invalid")))
      }
    }

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider().name })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
            placeholder={language.t("provider.connect.oauth.code.placeholder")}
            name="code"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthAutoView() {
    const code = createMemo(() => {
      const instructions = store.authorization?.instructions
      if (instructions?.includes(":")) {
        return instructions.split(":")[1]?.trim()
      }
      return instructions
    })

    onMount(() => {
      void platform.openLink(store.authorization!.url)
      void (async () => {
        const result = await globalSDK.client.provider.oauth
          .callback({
            providerID: props.provider,
            method: store.methodIndex,
          })
          .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
          .catch((error) => ({ ok: false as const, error }))

        if (!alive.value) return
        if (!result.ok) {
          dispatch({ type: "auth.error", error: classifyOAuthError(result.error) })
          return
        }

        await complete()
      })()
    })

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.auto.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.auto.visit.link")}</Link>
          {language.t("provider.connect.oauth.auto.visit.suffix", { provider: provider().name })}
        </div>
        <Show when={!props.hideBackButton}>
          <TextField
            label={language.t("provider.connect.oauth.auto.confirmationCode")}
            class="font-mono"
            value={code()}
            readOnly
            copyable
          />
        </Show>
        <div class="text-14-regular text-text-base flex items-center gap-4">
          <Spinner />
          <span>{language.t("provider.connect.status.waiting")}</span>
        </div>
      </div>
    )
  }

  return (
    <Dialog
      title={
        props.hideBackButton ? <div /> : (
          <IconButton
            tabIndex={-1}
            icon="arrow-left"
            variant="ghost"
            onClick={goBack}
            aria-label={language.t("common.goBack")}
          />
        )
      }
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            <Switch>
              <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
                {language.t("provider.connect.title.anthropicProMax")}
              </Match>
              <Match when={true}>{language.t("provider.connect.title", { provider: provider().name })}</Match>
            </Switch>
          </div>
        </div>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <div onKeyDown={handleKey} tabIndex={0} autofocus={store.methodIndex === undefined ? true : undefined}>
            <Switch>
              <Match when={loading()}>
                <div class="py-6 flex items-center gap-3 text-14-regular text-text-base">
                  <Spinner />
                  <span>{language.t("provider.connect.status.inProgress")}</span>
                </div>
              </Match>
              <Match when={store.state === "error"}>
                <div class="flex flex-col gap-4">
                  <div class="flex items-center gap-3 text-14-regular text-text-danger">
                    <Icon name="circle-x" class="size-4 text-danger" />
                    <span>{language.t("provider.connect.status.failed", { error: store.error ?? language.t("common.requestFailed") })}</span>
                  </div>
                  <Show when={!props.hideBackButton}>
                    <Button class="w-auto" size="large" variant="secondary" onClick={goBack}>
                      {language.t("common.goBack")}
                    </Button>
                  </Show>
                </div>
              </Match>
              <Match when={store.state === "prompt"}>
                <OAuthPromptsView />
              </Match>
              <Match when={store.authorization && store.authorization.method === "code"}>
                <OAuthCodeView />
              </Match>
              <Match when={store.authorization && store.authorization.method === "auto"}>
                <OAuthAutoView />
              </Match>
              <Match when={method()?.type === "api"}>
                <ApiAuthView />
              </Match>
              <Match when={store.methodIndex === undefined}>
                <MethodSelection />
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
