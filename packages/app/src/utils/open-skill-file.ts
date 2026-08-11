// 在目录级 DataProvider 和会话级文件预览面板之间转发 skill 文件打开请求。
export const OPEN_SKILL_FILE_EVENT = "wanlaicode:open-skill-file"

export type OpenSkillFileEventDetail = {
  absolutePath: string
  name?: string
  displayName?: string
}

export function dispatchOpenSkillFile(input: string | OpenSkillFileEventDetail) {
  const detail = typeof input === "string" ? { absolutePath: input } : input
  if (!detail.absolutePath.trim()) return

  window.dispatchEvent(
    new CustomEvent<OpenSkillFileEventDetail>(OPEN_SKILL_FILE_EVENT, {
      detail,
    }),
  )
}
