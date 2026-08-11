import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

// 已知限制：本地兜底只持久化 imageNames(文件名)，不含图片二进制。上报失败时截图内容会丢失。
// 取舍：兜底文件落在 userData，base64 嵌图会让单条反馈膨胀到数十 MB；文字反馈才是核心信号，
// 图片仅辅助。若后端强依赖图片，再改为单独落盘图片或 base64 内联。
export type FeedbackPayload = { content: string; contact?: string; imageNames: string[] }

export async function writeUninstallFeedbackFallback(
  dir: string,
  payload: FeedbackPayload,
  stamp: string,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, `uninstall-feedback-${stamp}.json`)
  await writeFile(file, JSON.stringify({ ...payload, savedAt: stamp }, null, 2), "utf8")
  return file
}
