import QRCode from "qrcode"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, For, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { remoteControlStatusQuery } from "@/context/remote-control"
import { useUserCenterEvents } from "@/pages/users/shared"
import { DialogConfirm } from "./dialog-confirm"

type RemoteControlState = "auth_required" | "disconnected" | "connecting" | "connected" | "error"
type RemoteControlVisibleState = RemoteControlState | "remote_auth_required"
type RemoteControlAccountState = "loading" | "ready" | "auth_required" | "reauth_required" | "error"
type RemoteControlAccountStatus = {
  authenticated: boolean
  auth_type?: "oauth" | "api"
  // 兼容尚未升级的本地 sidecar；缺失时按普通未登录处理，保持 fail-closed。
  oauth_reauth_required?: boolean
}

export type RemoteControlPendingPairing = {
  pairing_id: string
  name: string
  platform?: string
  requested_at?: string
}

// 弹窗只跟踪当前配对 ID；其他请求留在队列中，避免秒级轮询把错误设备切进当前确认流程。
export function remoteControlPairingDialogView(input: {
  pairingID: string
  expiresIn: number
  pendingPairings: readonly RemoteControlPendingPairing[]
}) {
  const pending = input.pendingPairings.find((item) => item.pairing_id === input.pairingID)
  if (pending) return { kind: "pending" as const, pairing: pending }
  if (input.expiresIn > 0) return { kind: "qr" as const }
  return { kind: "expired" as const }
}

// 同一请求只自动提示一次；关闭后仍可通过“连接请求”按钮重新打开，且不会遮盖正在处理的弹窗。
export function nextRemoteControlPendingPairing(
  pendingPairings: readonly RemoteControlPendingPairing[],
  presentedPairingIDs: ReadonlySet<string>,
  activePairingID?: string,
  pairingDialogStackID?: string,
  activeDialogStackID?: string,
) {
  if (activePairingID) return
  // 旧弹窗的关闭动画结束前仍占据 Dialog 栈；此时推入下一条会取消旧清理定时器并遗留栈项。
  if (pairingDialogStackID && pairingDialogStackID === activeDialogStackID) return
  return pendingPairings.find((item) => !presentedPairingIDs.has(item.pairing_id))
}

// 异步审批完成时必须同时匹配业务 ID 和 Dialog 栈 ID，避免旧请求的回调误关后来打开的新弹窗。
export function remoteControlPairingDialogCanClose(input: {
  pairingID: string
  activePairingID: string
  pairingDialogStackID: string
  activeDialogStackID?: string
}) {
  return (
    input.pairingID === input.activePairingID &&
    input.pairingDialogStackID.length > 0 &&
    input.pairingDialogStackID === input.activeDialogStackID
  )
}

const RemoteControlPairingDialog: Component<{
  pairingID: string
  qr: () => string
  expiresIn: () => number
  pendingPairings: () => readonly RemoteControlPendingPairing[]
  busy: () => boolean
  onPendingShown: (pairingID: string) => void
  onApprove: (pairingID: string) => Promise<unknown>
  onReject: (pairingID: string) => Promise<unknown>
  onDecisionComplete: () => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const view = createMemo(() =>
    remoteControlPairingDialogView({
      pairingID: props.pairingID,
      expiresIn: props.expiresIn(),
      pendingPairings: props.pendingPairings(),
    }),
  )
  const pending = createMemo(() => {
    const current = view()
    if (current.kind !== "pending") return
    return current.pairing
  })

  createEffect(() => {
    const current = view()
    if (current.kind === "pending") {
      // 手机扫码后在同一个弹窗内切换到授权步骤，不能被每秒轮询重复创建弹窗。
      props.onPendingShown(current.pairing.pairing_id)
      return
    }
    if (current.kind === "qr") return
    // 配对过期、被手机取消或账号切换后立即关闭，避免留下失效二维码。
    dialog.close()
  })

  const decide = (run: () => Promise<unknown>) =>
    void run()
      .then(() => props.onDecisionComplete())
      .catch(() => undefined)

  return (
    <Dialog
      fit
      title={
        pending() ? language.t("settings.remote.pending.title") : language.t("settings.remote.pair.create")
      }
      class="mx-auto w-full max-w-[420px]"
    >
      <Show
        when={pending()}
        keyed
        fallback={
          <div class="flex flex-col items-center gap-4 px-6 pb-6">
            {/* 二维码保持固定尺寸，异步编码期间不会改变弹窗布局。 */}
            <div class="flex size-[232px] items-center justify-center overflow-hidden rounded-md border border-border-weak-base bg-white p-2">
              <Show
                when={props.qr()}
                keyed
                fallback={<span class="text-13-regular text-text-weak">{language.t("common.loading")}</span>}
              >
                {(qr) => <img class="size-full" src={qr} alt={language.t("settings.remote.pair.qrAlt")} />}
              </Show>
            </div>
            <div class="flex items-center gap-2 text-13-regular text-text-base">
              <span>{language.t("settings.remote.pair.waiting")}</span>
              <span class="font-mono tabular-nums text-text-strong">
                {Math.floor(props.expiresIn() / 60)}:{String(props.expiresIn() % 60).padStart(2, "0")}
              </span>
            </div>
          </div>
        }
      >
        {(pairing) => (
          <div class="flex flex-col gap-4 px-5 pb-5">
            {/* 授权前只展示手机声明的设备元数据，绝不暴露一次性 secret。 */}
            <div class="flex items-center gap-3 rounded-lg border border-border-weak-base bg-surface-base px-4 py-3">
              <Icon name="smartphone" size="small" />
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-14-medium text-text-strong">{pairing.name}</span>
                <Show when={pairing.platform}>
                  <span class="truncate text-12-regular text-text-weak">{pairing.platform}</span>
                </Show>
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <Button
                size="small"
                variant="ghost"
                disabled={props.busy()}
                onClick={() => decide(() => props.onReject(pairing.pairing_id))}
              >
                {language.t("settings.remote.pending.reject")}
              </Button>
              <Button
                size="small"
                variant="secondary"
                disabled={props.busy()}
                onClick={() => decide(() => props.onApprove(pairing.pairing_id))}
              >
                {language.t("settings.remote.pending.approve")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}

// 账号登录与远控连接是两套状态：手机远控必须使用万来 OAuth，API Key 不能代替账号身份。
export function remoteControlAccountReady(status?: RemoteControlAccountStatus) {
  return status?.authenticated === true && status.auth_type === "oauth"
}

// 首次账号请求失败属于状态未知，必须显示连接异常并继续重试，不能降级成“尚未登录”。
export function remoteControlAccountState(
  status: RemoteControlAccountStatus | undefined,
  loading: boolean,
  failed: boolean,
  authExpired = false,
): RemoteControlAccountState {
  // 撤权事件必须立即压过查询缓存；请求失败时也不能继续信任上一次成功的 OAuth 状态。
  if (authExpired || status?.oauth_reauth_required === true) return "reauth_required"
  if (loading && !status) return "loading"
  if (failed) return "error"
  if (remoteControlAccountReady(status)) return "ready"
  return "auth_required"
}

// 只有撤权事件之后到达的新成功响应可以解除本地边界，定时轮询失败或旧缓存都继续保持锁定。
export function nextRemoteControlAuthExpiredBoundary(input: {
  current: boolean
  boundaryUpdatedAt: number
  dataUpdatedAt: number
  failed: boolean
  status?: RemoteControlAccountStatus
}) {
  if (!input.current) return false
  if (input.failed || !input.status || input.dataUpdatedAt <= input.boundaryUpdatedAt) return true
  return input.status.oauth_reauth_required === true
}

// 网关已建立连接时以实际连接为权威；仅在未连接时用账号状态细分“未登录”和“需重新认证”。
export function remoteControlVisibleState(
  state: RemoteControlState | undefined,
  accountState: RemoteControlAccountState,
  gatewayLoading = false,
  gatewayFailed = false,
): RemoteControlVisibleState {
  // 明确的 OAuth 撤权必须压过连接缓存，避免 UI 显示已连接却仍允许用户误以为凭据有效。
  if (accountState === "reauth_required") return "remote_auth_required"
  if (state === "connected" || state === "connecting" || state === "error") return state
  // 账号接口可能先返回；网关首次状态未知期间继续禁用配对，不能短暂伪装成普通未连接。
  if (gatewayLoading && state === undefined) return "connecting"
  if (gatewayFailed && state === undefined) return "error"
  if (accountState === "loading") return "connecting"
  if (accountState === "error") return "error"
  if (accountState === "auth_required") return "auth_required"
  if (state === "auth_required") return "remote_auth_required" as const
  return state ?? "disconnected"
}

export const SettingsRemoteControl: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const [state, setState] = createStore({
    busy: false,
    qr: "",
    qrPairingID: "",
    pairingDialogID: "",
    pairingDialogStackID: "",
    now: Date.now(),
    // auth.expired 先建立本地认证边界，避免 refetch 完成前仍可用旧缓存创建配对。
    authExpired: false,
    authBoundaryUpdatedAt: 0,
  })
  const presentedPendingPairings = new Set<string>()

  // renderer 只轮询本地裁剪后的管理 DTO，不读取 OAuth 或后端 device_token。
  const status = useQuery(() => remoteControlStatusQuery(sdk.client))
  const account = useQuery(() => ({
    queryKey: ["remote-control", "account-status"],
    queryFn: async () => (await sdk.client.wanlaicodeUserCenter.status(undefined, { throwOnError: true })).data,
    retry: 3,
    refetchInterval: 5_000,
  }))
  const accountState = createMemo(() =>
    remoteControlAccountState(account.data, account.isLoading, account.isError, state.authExpired),
  )
  const accountReady = createMemo(() => accountState() === "ready")
  const visibleState = createMemo(() =>
    remoteControlVisibleState(status.data?.state, accountState(), status.isLoading, status.isError),
  )

  createEffect(() => {
    // dataUpdatedAt 覆盖手工刷新与 5 秒轮询；只有事件后的新成功响应才能解除 auth.expired 边界。
    const next = nextRemoteControlAuthExpiredBoundary({
      current: state.authExpired,
      boundaryUpdatedAt: state.authBoundaryUpdatedAt,
      dataUpdatedAt: account.dataUpdatedAt,
      failed: account.isError,
      status: account.data,
    })
    if (next !== state.authExpired) setState("authExpired", next)
  })

  // 登录、退出和账号过期后同时刷新两套状态，避免设置页保留打开瞬间的旧结论。
  useUserCenterEvents(sdk, {
    resources: ["status", "providers"],
    onChange: () => {
      void account.refetch()
      void status.refetch()
    },
    onAuthExpired: () => {
      // 事件先于 HTTP 查询完成，立即禁止配对并展示需要重新认证。
      setState({ authExpired: true, authBoundaryUpdatedAt: account.dataUpdatedAt })
      void account.refetch()
      void status.refetch()
    },
  })

  // 倒计时和后端状态轮询独立，网络短暂抖动时二维码仍能准确显示本地剩余时间。
  const clock = setInterval(() => setState("now", Date.now()), 1_000)
  onCleanup(() => clearInterval(clock))

  createEffect(() => {
    // QR 只编码后端一次性 pairing secret，不包含本地 sidecar 密码或长期设备凭证。
    const pairing = status.data?.pairing
    if (!pairing) {
      setState({ qr: "", qrPairingID: "" })
      return
    }
    void QRCode.toDataURL(pairing.qr, {
      width: 232,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    }).then((value) => {
      // 异步编码旧二维码晚到时不能覆盖刚创建的新配对。
      if (status.data?.pairing?.pairing_id !== pairing.pairing_id) return
      setState({ qr: value, qrPairingID: pairing.pairing_id })
    })
  })

  const expiresIn = (pairingID: string) => {
    const pairing = status.data?.pairing
    if (pairing?.pairing_id !== pairingID) return 0
    return Math.max(0, Math.ceil((Date.parse(pairing.expires_at) - state.now) / 1_000))
  }
  const pairingQr = (pairingID: string) => (state.qrPairingID === pairingID ? state.qr : "")
  const pendingPairings = () => status.data?.pending_pairings ?? []

  const connectionLabel = createMemo(() => {
    if (visibleState() === "connected") return language.t("settings.remote.status.connected")
    if (visibleState() === "connecting") return language.t("settings.remote.status.connecting")
    if (visibleState() === "auth_required") return language.t("settings.remote.status.authRequired")
    if (visibleState() === "remote_auth_required") return language.t("settings.remote.status.remoteAuthRequired")
    if (visibleState() === "error") return language.t("settings.remote.status.error")
    return language.t("settings.remote.status.disconnected")
  })

  async function action<T>(run: () => Promise<T>) {
    if (state.busy) return
    setState("busy", true)
    try {
      const result = await run()
      await status.refetch()
      return result
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
      throw error
    } finally {
      setState("busy", false)
    }
  }

  function openPairingDialog(pairingID: string) {
    if (!pairingID || state.pairingDialogID) return
    setState("pairingDialogID", pairingID)
    // push 保留旧 DialogSettings 入口；当前 SettingsPage 覆盖层下则直接表现为首层弹窗。
    dialog.push(
      () => (
        <RemoteControlPairingDialog
          pairingID={pairingID}
          qr={() => pairingQr(pairingID)}
          expiresIn={() => expiresIn(pairingID)}
          pendingPairings={pendingPairings}
          busy={() => state.busy}
          onPendingShown={(id) => presentedPendingPairings.add(id)}
          onApprove={(id) =>
            action(() => sdk.client.remoteControl.pairing.approve({ pairingID: id }, { throwOnError: true }))
          }
          onReject={(id) =>
            action(() => sdk.client.remoteControl.pairing.reject({ pairingID: id }, { throwOnError: true }))
          }
          onDecisionComplete={() => {
            // refetch 可能已让旧弹窗开始关闭；仅在它仍是当前活动弹窗时补充执行关闭。
            if (
              !remoteControlPairingDialogCanClose({
                pairingID,
                activePairingID: state.pairingDialogID,
                pairingDialogStackID: state.pairingDialogStackID,
                activeDialogStackID: dialog.active?.id,
              })
            )
              return
            dialog.close()
          }}
        />
      ),
      () => {
        if (state.pairingDialogID === pairingID) setState("pairingDialogID", "")
      },
    )
    // push 完成后记录稳定栈 ID，用于区分当前配对弹窗、关闭动画和后来打开的其他弹窗。
    setState("pairingDialogStackID", dialog.active?.id ?? "")
  }

  async function connectPhone() {
    // 已收到请求或已有有效二维码时只重开当前流程，避免重复创建服务端配对记录。
    const pending = pendingPairings()[0]
    if (pending) {
      openPairingDialog(pending.pairing_id)
      return
    }
    const current = status.data?.pairing
    if (current && expiresIn(current.pairing_id) > 0) {
      openPairingDialog(current.pairing_id)
      return
    }
    const result = await action(() => sdk.client.remoteControl.pairing.create({ throwOnError: true }))
    const pairingID = result?.data?.pairing_id ?? status.data?.pairing?.pairing_id
    if (pairingID) openPairingDialog(pairingID)
  }

  createEffect(() => {
    // 手机扫码后即使用户已关掉二维码，也要主动弹出一次授权请求；同一 ID 不因轮询重复打断用户。
    const pending = nextRemoteControlPendingPairing(
      pendingPairings(),
      presentedPendingPairings,
      state.pairingDialogID,
      state.pairingDialogStackID,
      dialog.active?.id,
    )
    if (pending) openPairingDialog(pending.pairing_id)
  })

  function remove(connection: NonNullable<typeof status.data>["connections"][number]) {
    // 移除会立刻撤销手机访问权，必须通过确认弹层后才调用本地管理接口。
    dialog.push(() => (
      <DialogConfirm
        title={language.t("settings.remote.remove.title", { name: connection.name })}
        description={language.t("settings.remote.remove.description")}
        confirmLabel={language.t("settings.remote.remove.action")}
        onConfirm={() =>
          // 确认弹窗只关心操作是否完成，不向其泄漏 SDK 响应对象。
          action(() =>
            sdk.client.remoteControl.connection.remove({ connectionID: connection.id }, { throwOnError: true }),
          ).then(() => undefined)
        }
      />
    ))
  }

  function lastConnected(value: string | undefined) {
    if (!value) return language.t("settings.remote.device.never")
    return new Intl.DateTimeFormat(language.locale(), { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    )
  }

  return (
    <div class="settings-scrollbar flex h-full flex-col overflow-y-auto bg-background-base px-4 pb-10 sm:px-10">
      <div
        class="sticky top-0 z-10"
        style={{ background: "linear-gradient(to bottom, var(--background-base) calc(100% - 24px), transparent)" }}
      >
        <div class="flex flex-col gap-1 pb-8 pt-6">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.remote.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.remote.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8">
        {/* 连接状态和配对入口保持在首屏，未登录时明确禁用创建操作。 */}
        <section class="overflow-hidden rounded-lg border border-border-weaker-base bg-surface-raised-stronger-non-alpha">
          <div class="flex flex-wrap items-center gap-4 px-4 py-4 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <span
                class="size-2 shrink-0 rounded-full"
                classList={{
                  "bg-icon-success-base": visibleState() === "connected",
                  "bg-icon-warning-base": visibleState() === "connecting" || visibleState() === "remote_auth_required",
                  "bg-icon-weak-base":
                    visibleState() !== "connected" &&
                    visibleState() !== "connecting" &&
                    visibleState() !== "remote_auth_required",
                }}
              />
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-14-medium text-text-strong">{connectionLabel()}</span>
                <span class="truncate text-12-regular text-text-weak">{status.data?.device_name}</span>
              </div>
            </div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.busy || !accountReady() || visibleState() === "connecting" || visibleState() === "error"}
              onClick={() => void connectPhone().catch(() => undefined)}
            >
              {state.busy
                ? language.t("common.loading")
                : pendingPairings().length > 0
                  ? language.t("settings.remote.pending.title")
                  : language.t("settings.remote.pair.create")}
            </Button>
          </div>
        </section>

        {/* 已绑定设备同时展示在线状态和最后连接时间，移除操作使用图标按钮并保留可访问名称。 */}
        <section class="flex flex-col gap-2">
          <h3 class="text-13-medium text-text-strong">{language.t("settings.remote.devices.title")}</h3>
          <Show
            when={(status.data?.connections.length ?? 0) > 0}
            fallback={
              <div class="border-y border-border-weaker-base py-8 text-13-regular text-text-weak">
                {language.t("settings.remote.devices.empty")}
              </div>
            }
          >
            <div class="divide-y divide-border-weaker-base border-y border-border-weaker-base">
              <For each={status.data?.connections}>
                {(connection) => (
                  <div class="flex items-center gap-3 py-4">
                    <span
                      class="size-2 shrink-0 rounded-full"
                      classList={{ "bg-icon-success-base": connection.online, "bg-icon-weak-base": !connection.online }}
                    />
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-14-medium text-text-strong">{connection.name}</span>
                      <span class="text-12-regular text-text-weak">
                        {connection.platform ? `${connection.platform} · ` : ""}
                        {connection.online
                          ? language.t("settings.remote.device.online")
                          : language.t("settings.remote.device.offline")}
                        {" · "}
                        {language.t("settings.remote.device.lastConnected", {
                          time: lastConnected(connection.last_connected_at),
                        })}
                      </span>
                    </div>
                    <Button
                      icon="trash"
                      size="small"
                      variant="ghost"
                      aria-label={language.t("settings.remote.remove.action")}
                      disabled={state.busy}
                      onClick={() => remove(connection)}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </div>
  )
}
