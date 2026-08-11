import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useQueryClient } from "@tanstack/solid-query"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { completeWanlaiCodeLogin } from "./wanlaicode-login-complete"

export function DialogLoginPassword(props: { onSuccess?: () => void }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const [form, setForm] = createStore({
    email: "",
    password: "",
    emailError: "",
    passwordError: "",
    error: "",
    submitting: false,
  })

  function complete() {
    const openMainWindow = window.api?.openMainWindow
    return completeWanlaiCodeLogin({
      dispose: () => globalSDK.client.global.dispose(),
      invalidateBootstrap: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
      invalidateProviders: () =>
        queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === "providers" }),
      openMainWindow,
    })
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (form.submitting) return
    const emailError = form.email.trim() ? "" : language.t("login.password.email.required")
    const passwordError = form.password.trim() ? "" : language.t("login.password.password.required")
    setForm({ emailError, passwordError, error: "" })
    if (emailError || passwordError) return

    setForm("submitting", true)
    const result = await globalSDK.client.wanlaicodeUserCenter.login({
      email: form.email.trim(),
      password: form.password,
    }).catch((error) => ({ error, data: undefined }))
    setForm("submitting", false)
    if (result.error) {
      setForm("error", formatServerError(result.error, language.t, language.t("login.password.error.failed")))
      return
    }
    // 登录成功后先关闭弹窗反馈，再等待 provider 缓存刷新完毕后进入主窗口。
    props.onSuccess?.()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: "WanlaiCode" }),
      description: language.t("provider.connect.toast.connected.description", { provider: "WanlaiCode" }),
    })
    dialog.close()
    await complete()
  }

  return (
    <Dialog title={<div />}>
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id="wanlaicode" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">{language.t("login.password.title")}</div>
        </div>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <div class="text-14-regular text-text-base">{language.t("login.password.description")}</div>
          <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
            <TextField
              autofocus
              type="email"
              name="email"
              label={language.t("login.password.email.label")}
              placeholder={language.t("login.password.email.placeholder")}
              value={form.email}
              onChange={(value) => setForm({ email: value, emailError: "", error: "" })}
              validationState={form.emailError ? "invalid" : undefined}
              error={form.emailError}
              disabled={form.submitting}
            />
            <TextField
              type="password"
              name="password"
              label={language.t("login.password.password.label")}
              placeholder={language.t("login.password.password.placeholder")}
              value={form.password}
              onChange={(value) => setForm({ password: value, passwordError: "", error: "" })}
              validationState={form.passwordError ? "invalid" : undefined}
              error={form.passwordError}
              disabled={form.submitting}
            />
            <Show when={form.error}>
              <div class="flex items-center gap-3 text-14-regular text-text-danger">
                <Icon name="circle-x" class="size-4 text-danger" />
                <span>{form.error}</span>
              </div>
            </Show>
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={form.submitting}>
              {form.submitting ? language.t("provider.connect.status.inProgress") : language.t("common.continue")}
            </Button>
          </form>
        </div>
      </div>
    </Dialog>
  )
}
