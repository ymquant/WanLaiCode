import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Index, onMount, Show, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import type { McpManagementSaveInput } from "@opencode-ai/sdk/v2"
import { DialogConfirm } from "@/components/dialog-confirm"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { MCP_DRAFT_ERROR_KEYS, saveMcpDraft } from "./mcp-editor-actions"
import {
  createEditorDrafts,
  detailToDraft,
  isMcpFieldValidationVisible,
  validateMcpDraft,
  type McpDraft,
  type McpDraftType,
} from "./mcp-editor-form"
import { ManagePageHeader } from "./plugins-manage-header"
import { visibleManageTabs, type ManageTab, type ManageTabCounts } from "./plugins-manage-model"

const RETURN_URL = "/plugins/manage?tab=mcps"
const NO_DRAG = { "-webkit-app-region": "no-drag" } as Record<string, string>

export default function McpEditor() {
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams<{ name?: string }>()
  const sdk = useGlobalSDK()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const creating = () => params.name === undefined
  const decodedName = () => (params.name ? decodeURIComponent(params.name) : undefined)
  const initial = createEditorDrafts()
  const [local, setLocal] = createStore(initial.local)
  const [remote, setRemote] = createStore(initial.remote)
  const [activeType, setActiveType] = createSignal<McpDraftType>("local")
  const [touchedFields, setTouchedFields] = createSignal<Set<string>>(new Set())
  const [validateAll, setValidateAll] = createSignal(false)
  const activeDraft = createMemo<McpDraft>(() => (activeType() === "local" ? local : remote))
  const errors = createMemo(() => validateMcpDraft(activeDraft()))
  const initialSignatures = {
    local: JSON.stringify(initial.local),
    remote: JSON.stringify(initial.remote),
  }

  const detail = createQuery(() => ({
    queryKey: ["mcp", "management", "detail", decodedName()],
    enabled: !creating(),
    queryFn: async () => {
      const name = decodedName()
      if (!name) return undefined
      const response = await sdk.client.mcp.management.get({ name })
      if (response.error) throw response.error
      return response.data
    },
    refetchOnMount: "always",
  }))

  const installed = createQuery(() => ({
    queryKey: ["addon", "list", "global"],
    queryFn: async () => (await sdk.client.addon.list()).data ?? [],
    refetchOnMount: "always",
  }))

  const available = createQuery(() => ({
    queryKey: ["addon", "available", "global", language.locale()],
    queryFn: async () => (await sdk.client.addon.available({ locale: language.locale() })).data ?? [],
    refetchOnMount: "always",
  }))

  const skills = createQuery(() => ({
    queryKey: ["addon", "skills", "global"],
    queryFn: async () => (await sdk.client.addon.skills()).data ?? [],
    refetchOnMount: "always",
  }))

  const managedMcps = createQuery(() => ({
    queryKey: ["mcp", "management", "global"],
    queryFn: async () => {
      const response = await sdk.client.mcp.management.list()
      if (response.error) throw response.error
      return response.data ?? []
    },
    refetchOnMount: "always",
  }))

  const [headerSearch, setHeaderSearch] = createSignal("")
  const headerCounts = createMemo<ManageTabCounts>(() => {
    const installedItems = installed.data ?? []
    const installedKeys = new Set(installedItems.map((item) => item.key))
    return {
      plugins: installedItems.length,
      apps: (available.data ?? [])
        .filter((item) => installedKeys.has(item.key) && item.installed && !item.disabled)
        .reduce((total, item) => total + (item.manifest_apps?.length ?? 0), 0),
      mcps: managedMcps.data?.length ?? 0,
      skills: (skills.data ?? []).filter((item) => item.installed ?? true).length,
      marketplace: 0,
    }
  })
  const visibleHeaderTabs = createMemo(() => visibleManageTabs(headerCounts()))
  const selectHeaderTab = (tab: ManageTab) => navigate(`/plugins/manage?tab=${tab}`)

  let loadedName: string | undefined
  createEffect(() => {
    const item = detail.data
    if (!item || loadedName === item.name) return
    loadedName = item.name
    const draft = detailToDraft(item)
    setLocal("name", item.name)
    setRemote("name", item.name)
    if (draft.type === "local") setLocal(reconcile(draft))
    if (draft.type === "remote") setRemote(reconcile(draft))
    setActiveType(draft.type)
  })

  let reportedDetailError: unknown
  createEffect(() => {
    if (!detail.error || detail.error === reportedDetailError) return
    reportedDetailError = detail.error
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(detail.error, language.t, language.t("common.requestFailed")),
    })
  })

  const editable = () => creating() || detail.data?.editable === true
  const markFieldTouched = (path: string) => setTouchedFields((fields) => new Set(fields).add(path))
  const handleInput = (event: InputEvent) => {
    if (!(event.target instanceof HTMLElement)) return
    const path = event.target.dataset.mcpField
    if (path) markFieldTouched(path)
  }
  const fieldError = (path: string) => {
    if (!isMcpFieldValidationVisible(path, touchedFields(), validateAll())) return undefined
    const code = errors()[path]
    return code ? language.t(MCP_DRAFT_ERROR_KEYS[code]) : undefined
  }
  const setName = (value: string) => {
    setLocal("name", value)
    setRemote("name", value)
  }
  const invalidateMcpQueries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mcp", "management", "global"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp", "status", "global"] }),
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === "mcp" }),
    ])

  const saveMutation = useMutation(() => ({
    mutationFn: async (input: McpManagementSaveInput) => {
      const response = await sdk.client.mcp.management.save({ mcpManagementSaveInput: input })
      if (response.error) throw response.error
      return response.data
    },
    onSuccess: async () => {
      await invalidateMcpQueries()
      showToast({ variant: "success", title: language.t("mcp.editor.save.success") })
      navigate(RETURN_URL, { replace: true })
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("mcp.editor.save.failed"),
        description: formatServerError(error, language.t, language.t("common.requestFailed")),
      }),
  }))

  const isDirty = createMemo(() => {
    const draft = activeDraft()
    if (creating()) return JSON.stringify(draft) !== initialSignatures[draft.type]
    const item = detail.data
    if (!item) return false
    return JSON.stringify(draft) !== JSON.stringify(detailToDraft(item))
  })
  const saveDisabled = createMemo(
    () => saveMutation.isPending || Object.keys(errors()).length > 0 || (!creating() && !isDirty()),
  )

  const removeMutation = useMutation(() => ({
    mutationFn: async () => {
      const name = decodedName()
      if (!name) return
      const response = await sdk.client.mcp.management.remove({ name })
      if (response.error) throw response.error
    },
    onSuccess: async () => {
      await invalidateMcpQueries()
      showToast({ variant: "success", title: language.t("mcp.editor.delete.success") })
      navigate(RETURN_URL, { replace: true })
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("mcp.editor.delete.failed"),
        description: formatServerError(error, language.t, language.t("common.requestFailed")),
      }),
  }))

  const submit = () => {
    setValidateAll(true)
    void saveMcpDraft(activeDraft(), creating() ? undefined : detail.data?.name, (input) =>
      saveMutation.mutateAsync(input),
    ).catch(() => undefined)
  }

  const confirmRemove = () => {
    const name = decodedName()
    if (!name) return
    dialog.show(() => (
      <DialogConfirm
        title={language.t("mcp.editor.delete.title")}
        description={language.t("mcp.editor.delete.confirm", { name })}
        confirmLabel={language.t("mcp.editor.action.delete")}
        onConfirm={() => removeMutation.mutateAsync()}
      />
    ))
  }

  let scrollContainer!: HTMLDivElement
  onMount(() => {
    scrollContainer.scrollTop = 0
  })

  return (
    <div
      data-page="mcp-editor"
      data-editor-mode={creating() ? "create" : "edit"}
      class="size-full flex flex-col min-h-0 bg-background-base"
    >
      <main
        ref={scrollContainer}
        class="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
        onInput={handleInput}
      >
        <div class="mx-auto w-full max-w-[1040px] px-5 pb-8 pt-[85px]">
          <ManagePageHeader
            language={language}
            counts={headerCounts}
            visibleTabs={visibleHeaderTabs}
            tab={() => "mcps"}
            selectTab={selectHeaderTab}
            search={headerSearch}
            setSearch={setHeaderSearch}
            placeholder={language.t("plugins.manage.mcp.search")}
          />

          <div class="mt-[52px]">
            <button
              type="button"
              class="inline-flex h-9 items-center gap-1.5 px-2.5 text-[18px] leading-6 text-text-weak transition-colors hover:text-text-strong"
              style={NO_DRAG}
              onClick={() => navigate(RETURN_URL)}
            >
              <Icon name="arrow-left" size="small" />
              {language.t("mcp.editor.action.back")}
            </button>
          </div>

          <div class="mt-[27px] flex items-start justify-between gap-4">
            <div>
              <h1 class="text-[28px] font-normal leading-[1.2] tracking-tight text-text-strong">
                {creating()
                  ? language.t("mcp.editor.title.create")
                  : language.t("mcp.editor.title.update", { name: activeDraft().name })}
              </h1>
              <Show when={creating()}>
                <div class="mt-2 flex items-center gap-1 text-[18px] leading-6 text-text-weak">
                  <span>{language.t("mcp.editor.docs")}</span>
                  <Icon name="globe" size="small" />
                </div>
              </Show>
            </div>
            <Show when={!creating() && editable()}>
              <Button
                type="button"
                variant="ghost"
                size="large"
                disabled={removeMutation.isPending}
                onClick={confirmRemove}
                data-mcp-action="uninstall"
                class="shrink-0 !bg-surface-critical-weak !text-text-on-critical-base hover:!bg-surface-critical-weak"
              >
                <Icon name="trash-codex" size="normal" />
                {language.t("plugins.detail.uninstall")}
              </Button>
            </Show>
          </div>

          <div
            class="flex flex-col gap-2"
            classList={{ "mt-[29px]": creating(), "mt-[26px]": !creating() }}
          >
            <Show when={!creating()}>
              <div class="text-[17px] leading-6 text-text-weak">{language.t("mcp.editor.editDescription")}</div>
            </Show>

            <Show when={creating()}>
              <Card>
                <FieldPanel>
                  <TextField
                    autofocus
                    label={language.t("mcp.editor.field.name")}
                    placeholder="my-mcp-server"
                    value={activeDraft().name}
                    disabled={!editable()}
                    data-mcp-field="name"
                    onChange={setName}
                    validationState={fieldError("name") ? "invalid" : undefined}
                    error={fieldError("name")}
                  />
                </FieldPanel>
                <div class="flex min-h-[68px] items-center justify-between gap-6 px-4 py-3">
                  <div class="text-14-medium text-text-strong">{language.t("mcp.editor.field.type")}</div>
                  <div class="flex items-center gap-1">
                    <TypeButton
                      active={activeType() === "local"}
                      disabled={!editable()}
                      label={language.t("mcp.editor.type.stdio")}
                      onClick={() => setActiveType("local")}
                    />
                    <TypeButton
                      active={activeType() === "remote"}
                      disabled={!editable()}
                      label={language.t("mcp.editor.type.http")}
                      onClick={() => setActiveType("remote")}
                    />
                  </div>
                </div>
              </Card>
            </Show>

            <Show when={activeType() === "local"}>
              <LocalForm
                draft={local}
                disabled={!editable()}
                error={fieldError}
                setDraft={setLocal}
              />
            </Show>
            <Show when={activeType() === "remote"}>
              <RemoteForm
                draft={remote}
                disabled={!editable()}
                error={fieldError}
                setDraft={setRemote}
              />
            </Show>

            <Show when={editable()}>
              <div class="flex justify-end">
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  disabled={saveDisabled()}
                  onClick={submit}
                  data-mcp-action="save"
                >
                  {saveMutation.isPending ? language.t("common.saving") : language.t("mcp.editor.action.save")}
                </Button>
              </div>
            </Show>
          </div>
        </div>
      </main>
    </div>
  )
}

function Card(props: { children: JSX.Element; id?: string }) {
  return (
    <section
      id={props.id}
      class="flex flex-col overflow-hidden rounded-[20px] border border-border-weaker-base bg-background-stronger [&>div:not(:last-child)]:relative [&>div:not(:last-child)]:after:pointer-events-none [&>div:not(:last-child)]:after:absolute [&>div:not(:last-child)]:after:inset-x-5 [&>div:not(:last-child)]:after:bottom-0 [&>div:not(:last-child)]:after:h-[0.5px] [&>div:not(:last-child)]:after:bg-border-weaker-base [&>div:not(:last-child)]:after:content-['']"
    >
      {props.children}
    </section>
  )
}

function FieldPanel(props: { children: JSX.Element; class?: string; id?: string; "data-mcp-panel"?: string }) {
  return (
    <div
      id={props.id}
      data-mcp-panel={props["data-mcp-panel"]}
      class={`flex flex-col ${props.class ?? "gap-[10px]"} rounded-[12px] bg-input-base px-4 py-[10px]`}
    >
      {props.children}
    </div>
  )
}

function TypeButton(props: { active: boolean; disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      class="h-9 rounded-[12px] px-3 text-[18px] leading-6 transition-colors disabled:opacity-60"
      classList={{
        "bg-surface-base text-text-strong": props.active,
        "text-text-weak hover:bg-surface-base": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

function SectionTitle(props: { children: JSX.Element }) {
  return <h2 class="text-[18px] font-medium leading-[27px] text-text-strong">{props.children}</h2>
}

function AddRowButton(props: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      data-mcp-add-row
      class="h-9 w-full justify-center rounded-[10px] border border-dashed border-transparent !bg-surface-base !text-text-weak hover:!bg-surface-base-hover"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name="plus-small" size="small" />
      {props.label}
    </Button>
  )
}

function LocalForm(props: {
  draft: ReturnType<typeof createEditorDrafts>["local"]
  disabled: boolean
  error: (path: string) => string | undefined
  setDraft: ReturnType<typeof createStore<ReturnType<typeof createEditorDrafts>["local"]>>[1]
}) {
  const language = useLanguage()
  return (
    <Card>
      <FieldPanel>
        <TextField
          label={language.t("mcp.editor.field.command")}
          placeholder="npx"
          value={props.draft.command}
          disabled={props.disabled}
          data-mcp-field="command"
          onChange={(value) => props.setDraft("command", value)}
          validationState={props.error("command") ? "invalid" : undefined}
          error={props.error("command")}
        />
      </FieldPanel>

      <FieldPanel class="gap-4">
        <SectionTitle>{language.t("mcp.editor.field.arguments")}</SectionTitle>
        <div class="flex flex-col gap-[10px]">
          <Index each={props.draft.args}>
            {(argument, index) => (
              <div class="flex items-start gap-[10px]">
                <TextField
                  label={language.t("mcp.editor.field.arguments")}
                  hideLabel
                  value={argument()}
                  disabled={props.disabled}
                  onChange={(value) => props.setDraft("args", index, value)}
                  class="flex-1"
                  data-mcp-single-row-field
                />
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  data-mcp-row-delete
                  disabled={props.disabled}
                  onClick={() => props.setDraft("args", (items) => items.filter((_, i) => i !== index))}
                  aria-label={language.t("mcp.editor.action.removeRow")}
                />
              </div>
            )}
          </Index>
        </div>
        <AddRowButton
          label={language.t("mcp.editor.action.addArgument")}
          disabled={props.disabled}
          onClick={() => props.setDraft("args", (items) => [...items, ""])}
        />
      </FieldPanel>

      <FieldPanel class="gap-4">
        <SectionTitle>{language.t("mcp.editor.field.environment")}</SectionTitle>
        <div class="flex flex-col gap-[10px]">
          <For each={props.draft.environment}>
            {(entry, index) => (
              <div class="grid grid-cols-[1fr_1fr_auto] items-start gap-[10px]">
                <TextField
                  label={language.t("mcp.editor.field.key")}
                  hideLabel
                  placeholder={language.t("mcp.editor.field.key")}
                  value={entry.key}
                  disabled={props.disabled}
                  data-mcp-field={`environment.${index()}.key`}
                  data-mcp-compact-field
                  onChange={(value) => props.setDraft("environment", index(), "key", value)}
                  validationState={props.error(`environment.${index()}.key`) ? "invalid" : undefined}
                  error={props.error(`environment.${index()}.key`)}
                />
                <TextField
                  label={language.t("mcp.editor.field.value")}
                  hideLabel
                  placeholder={language.t("mcp.editor.field.value")}
                  value={entry.value}
                  disabled={props.disabled}
                  data-mcp-field={`environment.${index()}.value`}
                  data-mcp-compact-field
                  onChange={(value) => props.setDraft("environment", index(), "value", value)}
                  validationState={props.error(`environment.${index()}.value`) ? "invalid" : undefined}
                  error={props.error(`environment.${index()}.value`)}
                />
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  data-mcp-row-delete
                  disabled={props.disabled}
                  onClick={() => props.setDraft("environment", (items) => items.filter((_, i) => i !== index()))}
                  aria-label={language.t("mcp.editor.action.removeRow")}
                />
              </div>
            )}
          </For>
        </div>
        <AddRowButton
          label={language.t("mcp.editor.action.addEnvironment")}
          disabled={props.disabled}
          onClick={() => props.setDraft("environment", (items) => [...items, { key: "", value: "" }])}
        />
      </FieldPanel>

      <FieldPanel class="gap-4">
        <SectionTitle>{language.t("mcp.editor.field.inheritedEnvironment")}</SectionTitle>
        <div class="flex flex-col gap-[10px]">
          <Index each={props.draft.inherited_environment}>
            {(env, index) => (
              <div class="flex items-start gap-[10px]">
                <TextField
                  label={language.t("mcp.editor.field.envName")}
                  hideLabel
                  placeholder="GITHUB_TOKEN"
                  value={env()}
                  disabled={props.disabled}
                  data-mcp-field={`inherited_environment.${index}`}
                  data-mcp-single-row-field
                  onChange={(value) => props.setDraft("inherited_environment", index, value)}
                  validationState={props.error(`inherited_environment.${index}`) ? "invalid" : undefined}
                  error={props.error(`inherited_environment.${index}`)}
                  class="flex-1"
                />
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  data-mcp-row-delete
                  disabled={props.disabled}
                  onClick={() =>
                    props.setDraft("inherited_environment", (items) => items.filter((_, i) => i !== index))
                  }
                  aria-label={language.t("mcp.editor.action.removeRow")}
                />
              </div>
            )}
          </Index>
        </div>
        <AddRowButton
          label={language.t("mcp.editor.action.addInheritedEnvironment")}
          disabled={props.disabled}
          onClick={() => props.setDraft("inherited_environment", (items) => [...items, ""])}
        />
      </FieldPanel>

      <FieldPanel>
        <TextField
          label={language.t("mcp.editor.field.cwd")}
          placeholder="~/code"
          value={props.draft.cwd}
          disabled={props.disabled}
          onChange={(value) => props.setDraft("cwd", value)}
        />
      </FieldPanel>
    </Card>
  )
}

function RemoteForm(props: {
  draft: ReturnType<typeof createEditorDrafts>["remote"]
  disabled: boolean
  error: (path: string) => string | undefined
  setDraft: ReturnType<typeof createStore<ReturnType<typeof createEditorDrafts>["remote"]>>[1]
}) {
  const language = useLanguage()
  return (
    <Card>
      <FieldPanel data-mcp-panel="url">
        <TextField
          label={language.t("mcp.editor.field.url")}
          placeholder="https://mcp.example.com/mcp"
          value={props.draft.url}
          disabled={props.disabled}
          data-mcp-field="url"
          onChange={(value) => props.setDraft("url", value)}
          validationState={props.error("url") ? "invalid" : undefined}
          error={props.error("url")}
        />
      </FieldPanel>

      <FieldPanel data-mcp-panel="bearer">
        <div class="flex min-h-[27px] items-center gap-2">
          <label class="text-[18px] font-normal leading-[27px] text-text-strong">
            {language.t("mcp.editor.field.bearerEnv")}
          </label>
          <Show when={props.draft.bearer_token_configured && !props.draft.bearer_token_env}>
            <span class="rounded-full bg-surface-base px-2 py-0.5 text-11-medium text-text-weak">
              {language.t("mcp.editor.secret.configured")}
            </span>
          </Show>
        </div>
        <TextField
          label={language.t("mcp.editor.field.bearerEnv")}
          hideLabel
          placeholder="MCP_BEARER_TOKEN"
          value={props.draft.bearer_token_env}
          disabled={props.disabled}
          data-mcp-field="bearer_token_env"
          onChange={(value) => props.setDraft("bearer_token_env", value)}
          validationState={props.error("bearer_token_env") ? "invalid" : undefined}
          error={props.error("bearer_token_env")}
        />
      </FieldPanel>

      <FieldPanel class="gap-4">
        <PairSection
          title={language.t("mcp.editor.field.headers")}
          addLabel={language.t("mcp.editor.action.addHeader")}
          rows={props.draft.headers}
          disabled={props.disabled}
          error={props.error}
          field="headers"
          onAdd={() => props.setDraft("headers", (items) => [...items, { key: "", value: "" }])}
          onKey={(index, value) => props.setDraft("headers", index, "key", value)}
          onValue={(index, value) => props.setDraft("headers", index, "value", value)}
          onRemove={(index) => props.setDraft("headers", (items) => items.filter((_, i) => i !== index))}
        />
      </FieldPanel>

      <FieldPanel class="gap-4">
        <PairSection
          title={language.t("mcp.editor.field.environmentHeaders")}
          addLabel={language.t("mcp.editor.action.addEnvironmentHeader")}
          rows={props.draft.environment_headers.map((entry) => ({ key: entry.key, value: entry.env }))}
          disabled={props.disabled}
          error={props.error}
          field="environment_headers"
          valueLabel={language.t("mcp.editor.field.envName")}
          onAdd={() =>
            props.setDraft("environment_headers", (items) => [...items, { key: "", env: "" }])
          }
          onKey={(index, value) => props.setDraft("environment_headers", index, "key", value)}
          onValue={(index, value) => props.setDraft("environment_headers", index, "env", value)}
          onRemove={(index) =>
            props.setDraft("environment_headers", (items) => items.filter((_, i) => i !== index))
          }
        />
      </FieldPanel>

      <FieldPanel class="gap-4" id="oauth-advanced">
        <div class="flex items-center justify-between gap-4">
          <div>
            <SectionTitle>{language.t("mcp.editor.field.oauth")}</SectionTitle>
            <div class="text-12-regular text-text-weak">{language.t("mcp.editor.field.oauthAdvanced")}</div>
          </div>
          <Switch
            class="switch-pill"
            checked={props.draft.oauth.enabled}
            disabled={props.disabled}
            onChange={(enabled) => props.setDraft("oauth", "enabled", enabled)}
            aria-label={language.t("mcp.editor.field.oauth")}
          />
        </div>
        <div class="grid grid-cols-1 gap-4">
          <TextField
            label={language.t("mcp.editor.field.clientId")}
            value={props.draft.oauth.client_id}
            disabled={props.disabled || !props.draft.oauth.enabled}
            onChange={(value) => props.setDraft("oauth", "client_id", value)}
          />
          <div>
            <div class="flex items-center gap-2 mb-1.5">
              <label class="text-12-medium text-text-weak">{language.t("mcp.editor.field.clientSecretEnv")}</label>
              <Show when={props.draft.oauth.client_secret_configured && !props.draft.oauth.client_secret_env}>
                <span class="px-2 py-0.5 rounded-full bg-surface-base text-11-medium text-text-weak">
                  {language.t("mcp.editor.secret.configured")}
                </span>
              </Show>
            </div>
            <TextField
              label={language.t("mcp.editor.field.clientSecretEnv")}
              hideLabel
              placeholder="MCP_CLIENT_SECRET"
              value={props.draft.oauth.client_secret_env}
              disabled={props.disabled || !props.draft.oauth.enabled}
              data-mcp-field="oauth.client_secret_env"
              onChange={(value) => props.setDraft("oauth", "client_secret_env", value)}
              validationState={props.error("oauth.client_secret_env") ? "invalid" : undefined}
              error={props.error("oauth.client_secret_env")}
            />
          </div>
          <TextField
            label={language.t("mcp.editor.field.scope")}
            value={props.draft.oauth.scope}
            disabled={props.disabled || !props.draft.oauth.enabled}
            onChange={(value) => props.setDraft("oauth", "scope", value)}
          />
          <TextField
            label={language.t("mcp.editor.field.redirectUri")}
            placeholder="http://127.0.0.1:19876/mcp/oauth/callback"
            value={props.draft.oauth.redirect_uri}
            disabled={props.disabled || !props.draft.oauth.enabled}
            data-mcp-field="oauth.redirect_uri"
            onChange={(value) => props.setDraft("oauth", "redirect_uri", value)}
            validationState={props.error("oauth.redirect_uri") ? "invalid" : undefined}
            error={props.error("oauth.redirect_uri")}
          />
        </div>
      </FieldPanel>
    </Card>
  )
}

function PairSection(props: {
  title: string
  addLabel: string
  rows: Array<{ key: string; value: string }>
  field: "headers" | "environment_headers"
  valueLabel?: string
  disabled: boolean
  error: (path: string) => string | undefined
  onAdd: () => void
  onKey: (index: number, value: string) => void
  onValue: (index: number, value: string) => void
  onRemove: (index: number) => void
}) {
  const language = useLanguage()
  return (
    <>
      <SectionTitle>{props.title}</SectionTitle>
      <div class="flex flex-col gap-[10px]">
        <Index each={props.rows}>
          {(entry, index) => (
            <div class="grid grid-cols-[1fr_1fr_auto] items-start gap-[10px]">
              <TextField
                label={language.t("mcp.editor.field.key")}
                hideLabel
                placeholder={language.t("mcp.editor.field.key")}
                value={entry().key}
                disabled={props.disabled}
                data-mcp-field={`${props.field}.${index}.key`}
                data-mcp-compact-field
                onChange={(value) => props.onKey(index, value)}
                validationState={props.error(`${props.field}.${index}.key`) ? "invalid" : undefined}
                error={props.error(`${props.field}.${index}.key`)}
              />
              <TextField
                label={props.valueLabel ?? language.t("mcp.editor.field.value")}
                hideLabel
                placeholder={props.valueLabel ?? language.t("mcp.editor.field.value")}
                value={entry().value}
                disabled={props.disabled}
                data-mcp-field={`${props.field}.${index}.${props.field === "headers" ? "value" : "env"}`}
                data-mcp-compact-field
                onChange={(value) => props.onValue(index, value)}
                validationState={
                  props.error(`${props.field}.${index}.${props.field === "headers" ? "value" : "env"}`)
                    ? "invalid"
                    : undefined
                }
                error={props.error(
                  `${props.field}.${index}.${props.field === "headers" ? "value" : "env"}`,
                )}
              />
              <IconButton
                type="button"
                icon="trash"
                variant="ghost"
                data-mcp-row-delete
                disabled={props.disabled}
                onClick={() => props.onRemove(index)}
                aria-label={language.t("mcp.editor.action.removeRow")}
              />
            </div>
          )}
        </Index>
      </div>
      <AddRowButton label={props.addLabel} disabled={props.disabled} onClick={props.onAdd} />
    </>
  )
}
