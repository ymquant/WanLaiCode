import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { GitCommitIcon } from "@/components/git-commit-icon"
import { envBranchIconProps } from "@/components/session-details-card-git-ops"

export type PushMode = "push" | "commit-and-push"

export interface DialogPushProps {
  /** 是否有未提交内容；用来决定 commit-and-push 是否可选 */
  hasUncommitted?: () => boolean
  onContinue: (mode: PushMode) => void
}

interface Option {
  mode: PushMode
  label: string
  icon: () => unknown
}

export function DialogPush(props: DialogPushProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const sync = useSync()

  // 默认选「提交并推送」（如果有未提交），否则选「推送」
  const defaultMode: PushMode = props.hasUncommitted?.() ? "commit-and-push" : "push"
  const [selected, setSelected] = createSignal<PushMode>(defaultMode)

  const branchName = () => sync.data.vcs?.branch ?? sync.data.vcs?.default_branch ?? "main"

  const options: Option[] = [
    {
      mode: "push",
      label: language.t("dialog.push.option.push"),
      icon: () => <Icon name="arrow-up" size="small" class="text-icon-base" />,
    },
    {
      mode: "commit-and-push",
      label: language.t("dialog.push.option.commitAndPush"),
      // git commit 节点图标
      icon: () => <GitCommitIcon class="size-4 shrink-0 text-icon-base" />,
    },
  ]

  const handleContinue = () => {
    const mode = selected()
    dialog.close()
    props.onContinue(mode)
  }

  return (
    <Dialog
      fit
      class="codex-dialog codex-dialog-narrow w-full mx-auto !min-h-0"
      title={
        <div class="flex flex-col items-start" style={{ gap: "14px" }}>
          {/* cloud-upload 图标，带圆角方形浅外框 36×36，radius 10 */}
          <div
            class="flex items-center justify-center"
            style={{
              width: "36px",
              height: "36px",
              "border-radius": "10px",
              "background-color": "rgb(255,255,255)",
              border: "1px solid rgb(232,233,236)",
              "box-shadow": "0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <Icon name="cloud-upload" size="small" class="text-icon-base" />
          </div>
          <span
            style={{
              "font-size": "22px",
              "font-weight": "600",
              color: "rgb(25,28,31)",
              "line-height": "28px",
              "letter-spacing": "-0.01em",
            }}
          >
            {language.t("dialog.push.title")}
          </span>
        </div>
      }
    >
      <div class="codex-dialog-narrow" style={{ padding: "0 24px 20px" }}>
        {/* 分支行 */}
        <div class="flex items-center justify-between" style={{ "margin-top": "6px", "min-height": "24px" }}>
          <span class="flex items-center gap-1.5" style={{ "font-size": "14px", color: "rgb(107,111,118)" }}>
            <Icon {...envBranchIconProps} />
            <span>{language.t("dialog.push.row.branch")}</span>
          </span>
          <span style={{ "font-size": "14px", "font-weight": "500", color: "rgb(25,28,31)" }}>{branchName()}</span>
        </div>

        {/* 描述 */}
        <p style={{ "margin-top": "8px", "font-size": "14px", color: "rgb(107,111,118)", "line-height": "20px" }}>
          {language.t("dialog.push.description")}
        </p>

        {/* 后续步骤 */}
        <div style={{ "margin-top": "20px", "font-size": "14px", "font-weight": "600", color: "rgb(25,28,31)" }}>
          {language.t("dialog.push.steps")}
        </div>

        {/* 选项容器：1px 浅边框 + 12px 圆角，内含两条 segmented item，中间 1px 分隔线 */}
        <div
          class="flex flex-col overflow-hidden"
          style={{
            "margin-top": "8px",
            "border-radius": "12px",
            border: "1px solid rgb(232,233,236)",
            "background-color": "rgb(255,255,255)",
          }}
        >
          <For each={options}>
            {(opt, idx) => (
              <button
                type="button"
                class="flex items-center gap-3 text-left transition-colors"
                style={{
                  padding: "12px 14px",
                  "background-color": "transparent",
                  "border-top": idx() === 0 ? "none" : "1px solid rgb(238,239,242)",
                }}
                onmouseover={(e) => (e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.025)")}
                onmouseout={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                onClick={() => setSelected(opt.mode)}
              >
                <span class="shrink-0 flex items-center justify-center" style={{ width: "20px" }}>
                  {opt.icon() as never}
                </span>
                <span class="flex-1" style={{ "font-size": "14px", color: "rgb(25,28,31)" }}>
                  {opt.label}
                </span>
                <Show when={selected() === opt.mode}>
                  <Icon name="check" size="small" class="text-icon-base shrink-0" />
                </Show>
              </button>
            )}
          </For>
        </div>

        {/* 继续按钮 */}
        <div class="flex justify-end" style={{ "margin-top": "14px" }}>
          <Button
            type="button"
            variant="primary"
            class="!border-transparent !shadow-none"
            style={{
              "background-color": "rgb(25,28,31)",
              color: "rgb(255,255,255)",
              padding: "6px 22px",
              "border-radius": "999px",
              "font-size": "14px",
              "font-weight": "500",
              "line-height": "20px",
              height: "auto",
              "min-height": "0",
            }}
            onClick={handleContinue}
          >
            {language.t("dialog.push.action.continue")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
