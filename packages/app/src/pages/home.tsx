import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DateTime } from "luxon"

import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"

export default function Home() {
  const platform = usePlatform()
  const navigate = useNavigate()
  // 透传 ?prompt=... 到散对话路由,Plugins Hero「Try in chat」就能从 / 跳到具体散对话
  // 并自动把 slide 的 prompt 灌进 composer (session.tsx 已经消费这个 query)。
  const [searchParams] = useSearchParams<{ prompt?: string }>()

  const supportsScratch = createMemo(() => Boolean(platform.ensureScratchChatDir))

  // 不支持时 source signal 为 false，createResource 不调 fetcher；支持时显式 catch，
  // 避免 mkdir 失败（极小概率：磁盘满 / 权限）让用户卡在空白页
  const [scratchDir] = createResource(supportsScratch, () =>
    platform.ensureScratchChatDir!().catch((err: unknown) => {
      console.error("[home] ensureScratchChatDir failed:", err)
      return undefined
    }),
  )

  createEffect(() => {
    const dir = scratchDir()
    if (!dir) return
    const prompt = searchParams.prompt
    const query = prompt ? `?prompt=${encodeURIComponent(prompt)}` : ""
    navigate(`/${base64Encode(dir)}/session${query}`, { replace: true })
  })

  // 散对话不可用（web 端 / mkdir 失败）：fallback 到「打开项目」CTA + 最近项目列表
  const showFallback = createMemo(
    () => !supportsScratch() || (scratchDir.state === "ready" && scratchDir() === undefined),
  )

  return (
    <Show when={showFallback()} fallback={<div class="size-full" />}>
      <Fallback />
    </Show>
  )
}

function Fallback() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const navigate = useNavigate()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()

  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() =>
    sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5),
  )

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) openProject(directory)
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  return (
    <div class="mx-auto mt-30 w-full md:w-auto px-4 max-w-xl">
      <Show
        when={recent().length > 0}
        fallback={
          <div class="flex justify-center">
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        }
      >
        <div class="flex flex-col gap-4">
          <div class="flex gap-2 items-center justify-between pl-3">
            <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
            <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
          <ul class="flex flex-col gap-2">
            <For each={recent()}>
              {(project) => (
                <Button
                  size="large"
                  variant="ghost"
                  class="text-14-mono text-left justify-between px-3"
                  onClick={() => openProject(project.worktree)}
                >
                  {project.worktree.replace(homedir(), "~")}
                  <div class="text-14-regular text-text-weak">
                    {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                  </div>
                </Button>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  )
}
