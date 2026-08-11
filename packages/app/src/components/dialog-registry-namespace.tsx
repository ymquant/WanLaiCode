import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogFileInput } from "@/components/dialog-file-input"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

function registryError(error: unknown) {
  if (error && typeof error === "object" && "error" in error && typeof error.error === "string") return error.error
  if (error instanceof Error) return error.message
  return String(error)
}

function DialogRegistryNamespace(props: { onCreated: (namespace: string) => void }) {
  const sdk = useGlobalSDK()
  const language = useLanguage()

  return (
    <DialogFileInput
      title={language.t("plugins.namespace.dialog.title")}
      description={
        <div class="flex flex-col gap-1">
          <p>{language.t("plugins.namespace.dialog.description")}</p>
          <p>{language.t("plugins.namespace.dialog.immutable")}</p>
        </div>
      }
      placeholder={language.t("plugins.namespace.dialog.placeholder")}
      action={language.t("plugins.namespace.dialog.action")}
      errorFallback={language.t("plugins.namespace.dialog.failed")}
      transform={(value) => value.toLowerCase()}
      validate={(value) => {
        if (/\s/.test(value)) return language.t("plugins.namespace.dialog.noSpaces")
        return undefined
      }}
      onSubmit={async (name) => {
        const result = await sdk.client.registry.createNamespace({
          registryNamespaceRequest: { name },
        })
        if (result.error) throw new Error(registryError(result.error))
        const namespace = result.data?.namespace ?? name
        showToast({
          variant: "success",
          title: language.t("plugins.namespace.created"),
          description: namespace,
        })
        props.onCreated(namespace)
      }}
    />
  )
}

export function useRegistryNamespaceGate() {
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const language = useLanguage()

  return async () => {
    const me = await sdk.client.registry.me()
    if (me.error) throw new Error(formatServerError(me.error, language.t, language.t("common.requestFailed")))
    if (me.data?.namespace) return me.data.namespace

    return new Promise<string | undefined>((resolve) => {
      let settled = false
      const finish = (namespace: string | undefined) => {
        if (settled) return
        settled = true
        resolve(namespace)
      }
      dialog.show(
        () => <DialogRegistryNamespace onCreated={(namespace) => finish(namespace)} />,
        () => finish(undefined),
      )
    })
  }
}
