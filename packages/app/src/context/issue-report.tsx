import * as Sentry from "@sentry/solid"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import { DialogIssueReport, type IssueReportDialogOptions } from "@/components/dialog-issue-report"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import {
  createIssueReportSnapshot,
  installIssueReportGlobalListeners,
  normalizeCommunityPlatform,
  readAsDataUrl,
  setIssueReportSubmitter,
} from "@/utils/issue-report-snapshot"

type IssueReportContext = {
  open: (options?: IssueReportDialogOptions) => void
}

export const { use: useIssueReport, provider: RawIssueReportProvider } = createSimpleContext<
  IssueReportContext,
  { value: IssueReportContext }
>({
  name: "IssueReport",
  init: (props: { value: IssueReportContext }) => props.value,
})

export function IssueReportProvider(props: ParentProps) {
  const dialog = useDialog()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()

  const open = async (options?: IssueReportDialogOptions) => {
    // 在对话框渲染前预抓一张干净的窗口截图（否则截图会把「报告问题」弹窗一起截进去）。
    const preCapturedScreenshot = (await platform.captureWindowScreenshot?.().catch(() => null)) ?? undefined
    dialog.show(() => <DialogIssueReport {...options} preCapturedScreenshot={preCapturedScreenshot} />)
  }

  // /bug 问题报告对齐到社区投稿（type=bug）：服务端用当前 OAuth 会话转发到 /community/posts。
  // 诊断快照作为附件上传（社区帖子无 snapshot 字段且公开可见，避免混入正文）。
  setIssueReportSubmitter(async ({ payload, attachments }) => {
    const files: { data_url: string; mime?: string; filename?: string }[] = []
    const snapshotJson = JSON.stringify(payload.snapshot, null, 2)
    files.push({
      data_url: await readAsDataUrl(new Blob([snapshotJson], { type: "application/json" })),
      mime: "application/json",
      filename: "diagnostic-snapshot.json",
    })
    for (const file of attachments) {
      files.push({ data_url: await readAsDataUrl(file), mime: file.type || undefined, filename: file.name })
    }
    const metaLines = [
      payload.category ? `分类：${payload.category}` : undefined,
      payload.severity ? `严重程度：${payload.severity}` : undefined,
      payload.app_version ? `版本：${payload.app_version}` : undefined,
      payload.platform ? `端：${payload.platform}` : undefined,
      payload.os ? `系统：${payload.os}` : undefined,
      payload.sentry_event_id ? `Sentry：${payload.sentry_event_id}` : undefined,
    ].filter((line): line is string => Boolean(line))
    const content = [payload.description.trim(), metaLines.length ? `\n---\n${metaLines.join("\n")}` : ""]
      .join("")
      .trim()
    const result = await globalSDK.client.wanlaicodeUserCenter.community.post({
      wanlaiCodeUserCenterCommunityPostInput: {
        title: payload.title,
        content,
        platform: normalizeCommunityPlatform(payload.os, payload.platform),
        module: "desktop",
        attachments: files,
      },
    })
    if (result.error) {
      const err = result.error as { data?: { message?: string }; message?: string }
      throw new Error(err.data?.message ?? err.message ?? "问题报告提交失败")
    }
    return { skipped: false }
  })

  onMount(() => {
    const cleanup = installIssueReportGlobalListeners()
    onCleanup(cleanup)
  })

  createEffect(() => {
    if (!platform.issueReportHeartbeat) return
    const sendHeartbeat = () => {
      const snapshot = createIssueReportSnapshot({
        platform: platform.platform,
        os: platform.os,
        version: platform.version,
        sentryEnabled: Sentry.isEnabled(),
      })
      void platform.issueReportHeartbeat?.({
        page: snapshot.page,
        app: snapshot.app,
        runtime: snapshot.runtime,
        events: snapshot.events.slice(-20),
      })
    }
    sendHeartbeat()
    const timer = setInterval(sendHeartbeat, 5000)
    onCleanup(() => clearInterval(timer))
  })

  return <RawIssueReportProvider value={{ open }}>{props.children}</RawIssueReportProvider>
}
