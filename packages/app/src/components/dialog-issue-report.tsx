import * as Sentry from "@sentry/solid"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  createIssueReportSnapshot,
  issueReportAttachmentFilename,
  recordIssueAction,
  recordIssueEvent,
  sanitizeIssueError,
  stableHash,
  submitIssueReport,
  summarizeIssueAttachment,
  type IssueReportPayload,
} from "@/utils/issue-report-snapshot"

export type IssueReportDialogOptions = {
  title?: string
  description?: string
  category?: IssueReportCategory
  severity?: IssueReportSeverity
  error?: unknown
  context?: Record<string, unknown>
  // 在对话框打开前抓取的窗口截图（不含本对话框）。主进程截图会把弹窗一起截进去，
  // 因此改为在打开前预抓一张干净的传进来复用。
  preCapturedScreenshot?: File
}

const categories = ["bug", "crash", "hang", "attachment", "auth", "project-menu", "image-preview", "ui", "other"] as const
const severities = ["normal", "high", "critical", "low"] as const
type IssueReportCategory = (typeof categories)[number]
type IssueReportSeverity = (typeof severities)[number]
const maxAttachments = 3
const maxAttachmentBytes = 2 * 1024 * 1024
const maxImageSide = 1600

function errorMessage(error: unknown) {
  if (!error) return ""
  if (error instanceof Error) return error.message
  return String(error)
}

function errorStack(error: unknown) {
  if (!error) return undefined
  if (error instanceof Error) return error.stack
  return undefined
}

async function normalizeIssueAttachment(file: File, kind = "attachment") {
  const summary = summarizeIssueAttachment(file)
  if (!file.type.startsWith("image/")) return { rejected: { ...summary, reason: "not_image" } }
  if (file.size <= maxAttachmentBytes) {
    return {
      file: new File([file], issueReportAttachmentFilename(file, kind), { type: file.type || "application/octet-stream" }),
      original: summary,
    }
  }
  const compressed = await compressImage(file, kind).catch(() => undefined)
  if (compressed && compressed.size <= maxAttachmentBytes) {
    return {
      file: compressed,
      original: summary,
      compressed: summarizeIssueAttachment(compressed),
    }
  }
  return { rejected: { ...summary, reason: "too_large" } }
}

async function compressImage(file: File, kind: string) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return undefined
  const image = await createImageBitmap(file)
  const scale = Math.min(1, maxImageSide / Math.max(image.width, image.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82))
  if (!blob) return undefined
  return new File([blob], issueReportAttachmentFilename(file, kind, "jpg"), { type: "image/jpeg" })
}

export const DialogIssueReport: Component<IssueReportDialogOptions> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [title, setTitle] = createSignal(props.title ?? language.t("issueReport.defaultTitle"))
  const [description, setDescription] = createSignal(props.description ?? errorMessage(props.error))
  const [category, setCategory] = createSignal<IssueReportCategory>(props.category ?? (props.error ? "crash" : "bug"))
  const [severity, setSeverity] = createSignal<IssueReportSeverity>(props.severity ?? (props.error ? "high" : "normal"))
  const [includeScreenshot, setIncludeScreenshot] = createSignal(Boolean(props.preCapturedScreenshot))
  const [attachments, setAttachments] = createSignal<File[]>([])
  const [submitting, setSubmitting] = createSignal(false)
  const [submitted, setSubmitted] = createSignal<{ sentryEventId?: string; officialSkipped?: boolean }>()
  const [submitError, setSubmitError] = createSignal<string>()

  const [desktopDiagnostics] = createResource(
    () => true,
    () => platform.issueReportDiagnostics?.().catch((err) => ({ diagnostics_error: errorMessage(err) })) ?? {},
    { initialValue: {} as Record<string, unknown> },
  )

  const snapshot = createMemo(() =>
    createIssueReportSnapshot(
      {
        platform: platform.platform,
        os: platform.os,
        version: platform.version,
        sentryEnabled: Sentry.isEnabled(),
        context: {
          ...props.context,
          screenshot: props.preCapturedScreenshot
            ? {
                captured: true,
                attached_on_submit: includeScreenshot(),
                size: props.preCapturedScreenshot.size,
                type: props.preCapturedScreenshot.type,
              }
            : { captured: false },
        },
      },
      desktopDiagnostics.latest,
    ),
  )

  const snapshotText = createMemo(() => JSON.stringify(snapshot(), null, 2))
  const canSubmit = createMemo(() => title().trim().length > 0 && description().trim().length > 0 && !submitting())
  const categoryLabel = (item: IssueReportCategory) =>
    language.t(`issueReport.category.${item}` as Parameters<typeof language.t>[0])
  const severityLabel = (item: IssueReportSeverity) =>
    language.t(`issueReport.severity.${item}` as Parameters<typeof language.t>[0])

  const onFiles = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    const normalized = await Promise.all(files.slice(0, maxAttachments).map((file) => normalizeIssueAttachment(file)))
    const accepted = normalized.flatMap((result) => (result.file ? [result.file] : []))
    const rejected = normalized.flatMap((result) => (result.rejected ? [result.rejected] : []))
    setAttachments(accepted)
    recordIssueAction("issueReport.attachments.selected", {
      accepted: accepted.map(summarizeIssueAttachment),
      rejected,
      dropped_due_to_count: Math.max(0, files.length - maxAttachments),
    })
    if (rejected.length > 0 || files.length > maxAttachments) {
      showToast({
        title: language.t("issueReport.toast.attachmentsLimited.title"),
        description: language.t("issueReport.toast.attachmentsLimited.description"),
      })
    }
  }

  async function screenshotAttachment() {
    if (!includeScreenshot()) return []
    // 优先用打开前预抓的干净截图；缺失时（非桌面等）退回实时截图。
    const file = props.preCapturedScreenshot ?? (await platform.captureWindowScreenshot?.().catch(() => null))
    if (!file) return []
    const normalized = await normalizeIssueAttachment(file, "screenshot")
    if (normalized.file) return [normalized.file]
    recordIssueAction("issueReport.screenshot.rejected", { rejected: normalized.rejected })
    return []
  }

  async function submit() {
    if (!canSubmit()) return
    setSubmitting(true)
    setSubmitError(undefined)
    recordIssueAction("issueReport.submit", {
      category: category(),
      severity: severity(),
      attachments: attachments().map(summarizeIssueAttachment),
      include_screenshot: includeScreenshot(),
    })

    try {
      const error = sanitizeIssueError(props.error)
      if (props.error) {
        recordIssueEvent({
          type: "error",
          name: "issueReport.openedWithError",
          message: errorMessage(props.error),
          stack: errorStack(props.error),
        })
      }
      const sentryEventId = Sentry.isEnabled()
        ? Sentry.captureException(error, {
            tags: {
              issue_category: category(),
              issue_severity: severity(),
            },
            extra: {
              title_hash: stableHash(title()),
              description_length: description().length,
            },
          })
        : undefined
      const payload: IssueReportPayload = {
        title: title().trim(),
        description: description().trim(),
        category: category(),
        severity: severity(),
        sentry_event_id: sentryEventId,
        app_version: platform.version,
        platform: platform.platform,
        os: platform.os,
        snapshot: snapshot(),
      }
      const official = await submitIssueReport({
        payload,
        attachments: [...(await screenshotAttachment()), ...attachments()].slice(0, maxAttachments),
      })
      setSubmitted({ sentryEventId, officialSkipped: official.skipped })
      if (official.skipped) {
        showToast({
          variant: "error",
          icon: "circle-x",
          title: language.t("issueReport.toast.skipped.title"),
          description: language.t("issueReport.toast.sent.sentryOnly"),
        })
      } else {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("issueReport.toast.sent.title"),
          description: language.t("issueReport.toast.sent.description"),
        })
        // 发送成功后自动关闭对话框；未发送/失败时保留以便查看原因。
        dialog.close()
      }
    } catch (err) {
      const message = errorMessage(err)
      setSubmitError(message)
      recordIssueEvent({ type: "network", name: "issueReport.submit.failed", message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      title={language.t("issueReport.dialog.title")}
      description={language.t("issueReport.dialog.description")}
      size="large"
      class="[&_[data-slot=dialog-body]]:min-h-0"
    >
      <div class="flex h-full min-h-0 flex-col">
        <div class="flex-1 min-h-0 overflow-auto px-5 pb-4">
          <div class="flex flex-col gap-4">
            <div class="grid gap-3 md:grid-cols-2">
              <label class="flex flex-col gap-1 text-13-regular text-text-weak">
                {language.t("issueReport.field.category")}
                <select
                  class="h-9 rounded-lg border border-border-weak-base bg-surface-base px-3 text-14-regular text-text-base"
                  value={category()}
                  onChange={(event) => setCategory(event.currentTarget.value as IssueReportCategory)}
                >
                  <For each={categories}>
                    {(item) => <option value={item}>{categoryLabel(item)}</option>}
                  </For>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-13-regular text-text-weak">
                {language.t("issueReport.field.severity")}
                <select
                  class="h-9 rounded-lg border border-border-weak-base bg-surface-base px-3 text-14-regular text-text-base"
                  value={severity()}
                  onChange={(event) => setSeverity(event.currentTarget.value as IssueReportSeverity)}
                >
                  <For each={severities}>
                    {(item) => <option value={item}>{severityLabel(item)}</option>}
                  </For>
                </select>
              </label>
            </div>

            <TextField label={language.t("issueReport.field.title")} value={title()} onChange={setTitle} />
            <TextField
              multiline
              label={language.t("issueReport.field.description")}
              value={description()}
              onChange={setDescription}
              class="min-h-[120px]"
            />

            <div class="rounded-lg border border-border-weak-base bg-surface-base px-3 py-2">
              <label class="flex items-center gap-2 text-14-regular text-text-base">
                <input
                  type="checkbox"
                  checked={includeScreenshot()}
                  onChange={(event) => setIncludeScreenshot(event.currentTarget.checked)}
                />
                {language.t("issueReport.field.includeScreenshot")}
              </label>
              <p class="mt-1 text-12-regular text-text-weak">{language.t("issueReport.field.includeScreenshotHint")}</p>
            </div>

            <label class="flex flex-col gap-1 text-13-regular text-text-weak">
              {language.t("issueReport.field.attachments")}
              <input type="file" accept="image/*" multiple onChange={onFiles} />
            </label>
            <Show when={attachments().length > 0}>
              <div class="flex flex-wrap gap-2 text-12-regular text-text-weak">
                <For each={attachments()}>{(file) => <span class="rounded-md bg-surface-raised-base px-2 py-1">{file.name}</span>}</For>
              </div>
            </Show>

            <details class="rounded-lg border border-border-weak-base bg-surface-base">
              <summary class="cursor-pointer px-3 py-2 text-13-regular text-text-base">{language.t("issueReport.snapshot.summary")}</summary>
              <pre class="max-h-48 overflow-auto whitespace-pre-wrap px-3 pb-3 text-11-regular text-text-weak">{snapshotText()}</pre>
            </details>

            <Show when={submitted()}>
              {(result) => (
                <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2 text-13-regular text-text-base">
                  <Show when={!result().officialSkipped}>
                    <div>{language.t("issueReport.result.sent")}</div>
                  </Show>
                  <Show when={result().sentryEventId}>
                    {(id) => <div class="mt-1 text-text-weak">Sentry: {id()}</div>}
                  </Show>
                  <Show when={result().officialSkipped}>
                    <div class="mt-1 text-text-warning-base">{language.t("issueReport.result.officialSkipped")}</div>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={submitError()}>
              {(message) => <div class="rounded-lg bg-surface-danger-base px-3 py-2 text-13-regular text-text-danger-base">{message()}</div>}
            </Show>
          </div>
        </div>

        <div class="flex shrink-0 justify-end gap-2 border-t border-border-weak-base bg-surface-raised-stronger-non-alpha px-5 py-3">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={!canSubmit()} onClick={submit}>
            {submitting() ? language.t("issueReport.action.sending") : language.t("issueReport.action.send")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
