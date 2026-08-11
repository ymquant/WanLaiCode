import { resolveError } from "@opencode-ai/core/error/resolve"
import type { ErrorAction } from "@opencode-ai/core/error/error-actions"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ErrorActionView } from "@/components/error-action-view"
import {
  fetchEntitlements,
  AuthStatusFallback,
  InlineErrorState,
  InlineState,
  SettingsRow,
  SettingsSection,
  maskSoftwareKey,
  sdkErrorMessage,
  getEntitlementsCache,
  unwrapSDK,
  unwrapSDKSafe,
  useUserCenterEvents,
} from "./shared"
import { canReadSoftware, selectActiveEntitlement, type SoftwareEntitlement, type UserCenterStatusProps } from "./types"

type KeyPanel = "none" | "use" | "codex"

function escapeTomlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function buildCodexConfigToml(baseUrl: string, tokenCommandPath: string) {
  return `model_provider = "wanlai"
model = "gpt-5.2-codex"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.wanlai]
name = "Wanlai"
base_url = "${escapeTomlString(baseUrl)}"
wire_api = "responses"

[model_providers.wanlai.auth]
command = "${escapeTomlString(tokenCommandPath)}"
refresh_interval_ms = 300000
timeout_ms = 5000`
}

function codexTokenCommandPath(authPath: string | undefined) {
  const tokenCommand = typeof navigator !== "undefined" && /Win/i.test(navigator.platform)
    ? "wanlai-codex-token.cmd"
    : "wanlai-codex-token.sh"
  return authPath ? authPath.replace(/auth\.json$/, tokenCommand) : `~/.codex/${tokenCommand}`
}

function AuthFallback(props: UserCenterStatusProps & { onErrorAction?: (action: ErrorAction) => void }) {
  const language = useLanguage()
  return <AuthStatusFallback {...props} title={language.t("users.tabs.keys")} onErrorAction={props.onErrorAction} />
}

export function ApiKeys(props: UserCenterStatusProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const [keyPanel, setKeyPanel] = createSignal<KeyPanel>("none")
  const [rawKey, setRawKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  // 用户中心内部错误行为路由：relogin → 打开登录窗；open_purchase → 切到购买 tab；show_quota → 切到额度 tab
  function handleErrorAction(action: ErrorAction) {
    if (action === "relogin") {
      platform.openLoginWindow?.()
      return
    }
    if (action === "open_purchase") {
      props.selectTab("purchase")
      return
    }
    if (action === "show_quota") {
      props.selectTab("quota")
      return
    }
  }

  const productCode = () => props.status()?.product_code ?? "wanlaicode"
  const loadEntitlements = (force = false) =>
    fetchEntitlements(() => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] }), { force })
  const [entitlements, { refetch }] = createResource(
    () => (canReadSoftware(props.status()) ? productCode() : undefined),
    () => fetchEntitlements(() => unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.entitlements(), { items: [] })),
  )
  const [codexIntegration, { refetch: refetchCodexIntegration }] = createResource(
    () => (canReadSoftware(props.status()) ? productCode() : undefined),
    () =>
      unwrapSDKSafe(globalSDK.client.wanlaicodeUserCenter.integrations.codex.status(), {
        installed: false,
        restorable: false,
        config_path: "",
        auth_path: "",
        provider_id: "wanlai" as const,
      }),
  )
  const entitlementData = createMemo(() => entitlements.latest ?? getEntitlementsCache())
  const entitlement = createMemo<SoftwareEntitlement | undefined>(() =>
    selectActiveEntitlement(entitlementData()?.items ?? [], productCode()),
  )
  const codexInstalled = createMemo(() => codexIntegration.latest?.installed ?? false)
  const codexRestorable = createMemo(() => codexIntegration.latest?.restorable ?? false)
  const keyPreview = createMemo(() => rawKey() || entitlement()?.api_key_preview || "")
  const hasKey = createMemo(() => !!keyPreview())
  const codexEnv = createMemo(
    () => `export OPENAI_API_KEY="${rawKey()}"\nexport OPENAI_BASE_URL="${props.status()?.codex_base_url ?? ""}"`,
  )
  const codexConfig = createMemo(() =>
    buildCodexConfigToml(
      props.status()?.codex_base_url ?? "",
      codexTokenCommandPath(codexIntegration.latest?.auth_path),
    ),
  )
  useUserCenterEvents(globalSDK, {
    resources: ["entitlements", "api_key", "codex_integration", "status"],
    onChange: (resources) => {
      if (!canReadSoftware(props.status())) return
      if (resources.includes("entitlements") || resources.includes("api_key") || resources.includes("status")) {
        void loadEntitlements(true).then(() => refetch())
      }
      if (resources.includes("codex_integration") || resources.includes("api_key") || resources.includes("status")) {
        void refetchCodexIntegration()
      }
    },
  })

  async function loadRawKey() {
    if (rawKey()) return rawKey()
    const result = await globalSDK.client.wanlaicodeUserCenter.apiKey
      .get({ product_code: productCode() })
      .then(unwrapSDK)
    setRawKey(result.raw_key ?? "")
    return result.raw_key ?? ""
  }

  async function loadRawKeyOrToast() {
    try {
      const key = await loadRawKey()
      if (key) return key
      showToast({ title: language.t("users.notice.noKey") })
      return ""
    } catch (err) {
      const r = resolveError(err)
      showToast({ title: language.t(r.messageKey as any), description: r.reason ? undefined : r.rawMessage })
      return ""
    }
  }

  async function copyText(value: string, title: string) {
    await navigator.clipboard?.writeText(value)
    showToast({ title })
  }

  async function copySoftwareKey() {
    const key = await loadRawKeyOrToast()
    if (!key) return
    await copyText(key, language.t("users.notice.keyCopied"))
  }

  async function createSoftwareKey() {
    if (busy()) return
    if (props.status()?.auth_type !== "oauth") {
      showToast({ title: language.t("users.notice.oauthRequiredForRotate") })
      return
    }
    setBusy(true)
    await globalSDK.client.wanlaicodeUserCenter.apiKey
      .create({ product_code: productCode(), replace_existing: false })
      .then(unwrapSDK)
      .then(async (result) => {
        setRawKey(result.raw_key ?? "")
        setKeyPanel("none")
        await refetch()
        showToast({ title: language.t("users.notice.keyGenerated") })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setBusy(false))
  }

  async function rotateSoftwareKey() {
    if (busy()) return
    if (props.status()?.auth_type !== "oauth") {
      showToast({ title: language.t("users.notice.oauthRequiredForRotate") })
      return
    }
    setBusy(true)
    await globalSDK.client.wanlaicodeUserCenter.apiKey
      .create({ product_code: productCode(), replace_existing: true })
      .then(unwrapSDK)
      .then(async (result) => {
        setRawKey(result.raw_key ?? "")
        setKeyPanel("none")
        await refetch()
        if (codexInstalled()) {
          await globalSDK.client.wanlaicodeUserCenter.integrations.codex
            .import({ product_code: productCode() })
            .then(unwrapSDK)
          await refetchCodexIntegration()
        }
        showToast({ title: language.t("users.notice.keyRotated") })
      })
      .catch((err: unknown) => {
        const r = resolveError(err)
        showToast({ title: language.t(r.messageKey as any), description: r.reason ? undefined : r.rawMessage })
      })
      .finally(() => setBusy(false))
  }

  async function importToCodex() {
    if (busy() || codexInstalled()) return
    if (!props.status()) {
      showToast({ title: language.t("users.notice.noKey") })
      return
    }
    setBusy(true)
    await globalSDK.client.wanlaicodeUserCenter.integrations.codex
      .import({ product_code: productCode() })
      .then(unwrapSDK)
      .then(async () => {
        setKeyPanel("codex")
        await refetchCodexIntegration()
        showToast({ title: language.t("users.notice.codexImportInstalled") })
      })
      .catch((err: unknown) => {
        const r = resolveError(err)
        showToast({ title: language.t(r.messageKey as any), description: r.reason ? undefined : r.rawMessage })
      })
      .finally(() => setBusy(false))
  }

  async function restoreOfficialCodex() {
    if (busy()) return
    setBusy(true)
    await globalSDK.client.wanlaicodeUserCenter.integrations.codex
      .restore()
      .then(unwrapSDK)
      .then(async () => {
        setKeyPanel("none")
        await refetchCodexIntegration()
        showToast({ title: language.t("users.notice.codexRestored") })
      })
      .catch((err: unknown) => {
        const r = resolveError(err)
        showToast({ title: language.t(r.messageKey as any), description: r.reason ? undefined : r.rawMessage })
      })
      .finally(() => setBusy(false))
  }

  return (
    <section class="grid gap-7">
      <Show when={canReadSoftware(props.status())} fallback={<AuthFallback {...props} onErrorAction={handleErrorAction} />}>
        <SettingsSection title={language.t("users.tabs.keys")}>
          {/* entitlement 加载失败：ErrorActionView 提供行为按钮（relogin/open_purchase 等） */}
          {/* 传 __errorObj（含 reason 字段的原始 Error）供 resolveError 做语义分类，__error 字符串作兜底 */}
          <Show when={entitlementData()?.__error}>
            {(error) => <ErrorActionView error={entitlementData()?.__errorObj ?? error()} onAction={handleErrorAction} />}
          </Show>
          {/* codex 集成状态加载失败：仅文案改善，无行为按钮 */}
          <Show when={codexIntegration.latest?.__error}>{(error) => <InlineErrorState message={error()} />}</Show>
          <SettingsRow
            title={entitlement()?.product_name || language.t("users.keys.productNameFallback")}
            description={entitlement()?.plan_name || language.t("users.keys.planNameFallback")}
          >
            <div class="flex items-center gap-2">
              <span class="text-13-mono text-text-interactive-base">
                {keyPreview() ? maskSoftwareKey(keyPreview()) : language.t("users.keys.noKey")}
              </span>
              <Show
                when={hasKey()}
                fallback={
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    icon="plus"
                    disabled={busy() || props.status()?.auth_type !== "oauth"}
                    onClick={createSoftwareKey}
                  >
                    {busy() ? language.t("common.loading") : language.t("users.actions.generateKey")}
                  </Button>
                }
              >
                <Button type="button" size="small" variant="ghost" icon="copy" onClick={copySoftwareKey}>
                  {language.t("users.actions.copyKey")}
                </Button>
              </Show>
            </div>
          </SettingsRow>
          <SettingsRow
            title={language.t("users.keys.useKey.title")}
            description={language.t("users.keys.useKey.description")}
          >
            <Button
              type="button"
              size="small"
              variant="ghost"
              icon="terminal"
              onClick={async () => {
                if (!(await loadRawKeyOrToast())) return
                setKeyPanel(keyPanel() === "use" ? "none" : "use")
              }}
            >
              {keyPanel() === "use" ? language.t("users.actions.collapse") : language.t("users.actions.view")}
            </Button>
          </SettingsRow>
          <SettingsRow
            title={language.t("users.keys.importCodex.title")}
            description={language.t("users.keys.importCodex.description")}
          >
            <Button
              type="button"
              size="small"
              variant="ghost"
              icon="share"
              disabled={busy() || codexInstalled()}
              onClick={importToCodex}
            >
              {codexInstalled() ? language.t("users.actions.installed") : language.t("users.actions.import")}
            </Button>
          </SettingsRow>
          <Show when={codexInstalled() || codexRestorable()}>
            <SettingsRow
              title={language.t("users.keys.restoreCodex.title")}
              description={language.t("users.keys.restoreCodex.description")}
            >
              <Button
                type="button"
                size="small"
                variant="ghost"
                icon="reset"
                disabled={busy()}
                onClick={restoreOfficialCodex}
              >
                {busy() ? language.t("common.loading") : language.t("users.actions.restoreOfficial")}
              </Button>
            </SettingsRow>
          </Show>
          <SettingsRow
            title={language.t("users.keys.rotateKey.title")}
            description={
              props.status()?.auth_type === "api"
                ? language.t("users.keys.rotateKey.oauthDescription")
                : language.t("users.keys.rotateKey.description")
            }
          >
            <Button
              type="button"
              size="small"
              variant="ghost"
              icon="reset"
              disabled={busy()}
              onClick={rotateSoftwareKey}
            >
              {busy() ? language.t("common.loading") : language.t("users.actions.rotate")}
            </Button>
          </SettingsRow>
        </SettingsSection>

        <Show when={keyPanel() === "use"}>
          <SettingsSection title={language.t("users.keys.config.title")}>
            <SettingsRow
              title={language.t("users.keys.env.title")}
              description={language.t("users.keys.env.description")}
              align="start"
            >
              <Button
                type="button"
                size="small"
                variant="ghost"
                icon="copy"
                onClick={() => copyText(codexEnv(), language.t("users.notice.envCopied"))}
              >
                {language.t("users.actions.copy")}
              </Button>
            </SettingsRow>
            <div class="border-b border-border-weaker-base px-3 pb-3">
              <pre class="overflow-x-auto whitespace-pre-wrap rounded-md border border-border-weak-base bg-background-base p-3 text-12-mono text-text-strong">
                {codexEnv()}
              </pre>
            </div>
            <SettingsRow
              title={language.t("users.keys.codexConfig.title")}
              description={language.t("users.keys.codexConfig.description")}
              align="start"
            >
              <Button
                type="button"
                size="small"
                variant="ghost"
                icon="copy"
                onClick={() => copyText(codexConfig(), language.t("users.notice.codexConfigCopied"))}
              >
                {language.t("users.actions.copy")}
              </Button>
            </SettingsRow>
            <div class="px-3 pb-3">
              <pre class="overflow-x-auto whitespace-pre-wrap rounded-md border border-border-weak-base bg-background-base p-3 text-12-mono text-text-strong">
                {codexConfig()}
              </pre>
            </div>
          </SettingsSection>
        </Show>

        <Show when={keyPanel() === "codex"}>
          <SettingsSection title={language.t("users.keys.codexImport.title")}>
            <InlineState
              icon="circle-check"
              title={language.t("users.keys.codexImport.installed.title")}
              description={language.t("users.keys.codexImport.installed.description")}
            />
          </SettingsSection>
        </Show>
      </Show>
    </section>
  )
}
