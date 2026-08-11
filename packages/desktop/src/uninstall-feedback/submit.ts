import { resolveUninstallFeedbackEndpoint } from "./endpoint"
import { buildUninstallFeedbackHeaders } from "./headers"
import { writeUninstallFeedbackFallback } from "./fallback"
import { parseUninstallFeedbackResponse } from "./response"

export type SubmitInput = {
  content: string
  contact?: string
  images: { name: string; type: string; bytes: Uint8Array }[]
  meta: { client: string; clientVersion: string; os: string; arch: string }
}

export type SubmitDeps = {
  fetch: typeof fetch
  apiBase: string
  fallbackDir: string
  stamp: string
}

export async function submitUninstallFeedback(
  input: SubmitInput,
  deps: SubmitDeps,
): Promise<{ ok: boolean; id?: string; fellBack: boolean }> {
  // 兜底写盘也可能失败(磁盘满/权限)。submit 必须是 total 函数：无论如何都返回结果、绝不抛，
  // 否则主进程 handler 会卡在 await 上、既不退出 0 也不退出 2，NSIS ExecWait 死等 → 卡住卸载。
  const safeFallback = async (): Promise<boolean> => {
    try {
      await writeUninstallFeedbackFallback(
        deps.fallbackDir,
        { content: input.content, contact: input.contact, imageNames: input.images.map((i) => i.name) },
        deps.stamp,
      )
      return true
    } catch {
      return false
    }
  }

  try {
    const form = new FormData()
    form.append("content", input.content)
    if (input.contact) form.append("contact", input.contact)
    for (const img of input.images) {
      form.append("images", new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.type }), img.name)
    }

    const res = await deps.fetch(resolveUninstallFeedbackEndpoint(deps.apiBase), {
      method: "POST",
      headers: buildUninstallFeedbackHeaders(input.meta),
      body: form,
    })

    const body = await res.json().catch(() => undefined)
    const parsed = parseUninstallFeedbackResponse(res.status, body)
    if (parsed.ok) return { ok: true, id: parsed.id, fellBack: false }

    // 上报失败：先写本地兜底(数据不丢)，但如实返回 ok:false，让渲染层提供重试/继续。
    return { ok: false, fellBack: await safeFallback() }
  } catch {
    return { ok: false, fellBack: await safeFallback() }
  }
}
