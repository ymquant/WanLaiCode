import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { isValidProjectFolderName, sanitizeProjectFolderName } from "./blank-project"

export function DialogCreateBlankProject(props: {
  defaultName: string
  defaultParent: string
  onCreate: (input: { name: string; parent: string }) => Promise<void>
  onBrowseParent: (current: string) => Promise<string | null>
  checkNameTaken: (parent: string, name: string) => Promise<boolean>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.defaultName)
  const [parent, setParent] = createSignal(props.defaultParent)
  const [nameTaken, setNameTaken] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let nameEl: HTMLInputElement | undefined

  onMount(() => {
    requestAnimationFrame(() => {
      nameEl?.focus()
      nameEl?.select()
    })
  })

  createEffect(() => {
    const folderName = sanitizeProjectFolderName(name())
    const parentDir = parent().trim()
    if (!folderName || !parentDir || !isValidProjectFolderName(name())) {
      setNameTaken(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void props.checkNameTaken(parentDir, folderName).then((taken) => {
        if (!cancelled) setNameTaken(taken)
      })
    }, 200)
    onCleanup(() => {
      cancelled = true
      clearTimeout(timer)
    })
  })

  const nameFormatInvalid = () => !busy() && !isValidProjectFolderName(name())
  const nameDuplicate = () => !busy() && nameTaken() && isValidProjectFolderName(name()) && !!parent().trim()
  const nameShowTooltip = () => nameFormatInvalid() || nameDuplicate()

  const nameInvalidReason = () => {
    if (nameDuplicate()) return language.t("sidebar.blankProject.error.exists")
    if (!nameFormatInvalid()) return ""
    if (!name().trim()) return language.t("sidebar.blankProject.createDisabled.nameRequired")
    return language.t("sidebar.blankProject.createDisabled.nameInvalid")
  }

  const pathInvalid = () => !busy() && !parent().trim()

  const inputClass = (error: boolean) =>
    [
      "w-full h-9 px-3 text-14-regular text-text-strong rounded-lg transition-colors duration-200 focus:outline-none",
      error
        ? "bg-surface-raised-stronger-non-alpha border border-border-critical-selected focus:border-border-critical-selected"
        : "bg-surface-raised-stronger-non-alpha border border-border-weaker-base focus:border-border-weak-base",
    ].join(" ")

  const createDisabled = () =>
    busy() || !isValidProjectFolderName(name()) || !parent().trim() || nameTaken()

  const submit = async () => {
    if (createDisabled()) return
    const folderName = sanitizeProjectFolderName(name())
    const parentDir = parent().trim()
    setBusy(true)
    try {
      await props.onCreate({ name: folderName, parent: parentDir })
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      fit
      title={language.t("sidebar.blankProject.title")}
      class="codex-dialog w-full max-w-[480px] mx-auto !min-h-0 create-blank-project-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        class="flex flex-col gap-4 p-5 pt-3"
      >
        <div class="flex flex-col gap-1.5">
          <label class="text-13-medium text-text-weak">{language.t("sidebar.blankProject.nameLabel")}</label>
          <Tooltip placement="top" class="w-full" value={nameInvalidReason()} inactive={!nameShowTooltip()}>
            <input
              ref={nameEl}
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              disabled={busy()}
              class={inputClass(nameShowTooltip())}
            />
          </Tooltip>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-13-medium text-text-weak">{language.t("sidebar.blankProject.pathLabel")}</label>
          <div class="flex items-center gap-2">
            <Tooltip
              placement="top"
              class="min-w-0 flex-1"
              value={language.t("sidebar.blankProject.createDisabled.path")}
              inactive={!pathInvalid()}
            >
              <input
                type="text"
                value={parent()}
                onInput={(e) => setParent(e.currentTarget.value)}
                disabled={busy()}
                class={inputClass(pathInvalid())}
              />
            </Tooltip>
            <IconButton
              type="button"
              icon="folder"
              variant="secondary"
              size="small"
              class="size-9 shrink-0"
              disabled={busy()}
              onClick={() => {
                void props
                  .onBrowseParent(parent())
                  .then((picked) => {
                    if (picked) setParent(picked)
                  })
                  .catch(() => undefined)
              }}
              aria-label={language.t("sidebar.blankProject.browse")}
            />
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="large"
            disabled={createDisabled()}
            class="!rounded-full px-3"
          >
            {busy() ? language.t("common.loading") : language.t("sidebar.blankProject.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
