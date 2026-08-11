import type { FileContent } from "@opencode-ai/sdk/v2"

export function isAbsoluteLocalFilePath(value: string) {
  return /^(?:\/|[A-Za-z]:\/|\/\/)/.test(value.replace(/\\/g, "/"))
}

export function readFileContentWithLocalFallback(input: {
  path: string
  readWorkspace: () => Promise<FileContent | undefined>
  readLocal?: (path: string) => Promise<FileContent>
}) {
  return input.readWorkspace().catch((error) => {
    // 仅绝对路径允许进入桌面只读兜底，相对路径继续遵守当前工作区的服务端访问边界。
    if (!input.readLocal || !isAbsoluteLocalFilePath(input.path)) return Promise.reject(error)
    return input.readLocal(input.path)
  })
}
