import type { Part } from "@opencode-ai/sdk/v2/client"

const liveTextPart = (part: Part) =>
  (part.type === "text" || part.type === "reasoning") && typeof part.time?.end !== "number"

const preserveLivePrefix = (incoming: string | undefined, current: string | undefined) => {
  if (incoming === undefined || !current) return incoming
  if (incoming.length >= current.length) return incoming
  return current.startsWith(incoming) ? current : incoming
}

export function mergeLivePartSnapshot(current: Part | undefined, incoming: Part) {
  if (!current || current.type !== incoming.type) return incoming

  if (incoming.type === "text" && current.type === "text") {
    // 同一 item 的拉取快照可能早于本地流事件；缺失 phase 只代表旧快照尚未知晓，不能擦掉已收到的官方阶段。
    const merged = {
      ...incoming,
      phase: incoming.phase ?? current.phase,
    } satisfies Part
    if (!liveTextPart(incoming)) return merged
    return {
      ...merged,
      text: preserveLivePrefix(incoming.text, current.text) ?? incoming.text,
    } satisfies Part
  }

  if (incoming.type === "reasoning" && current.type === "reasoning") {
    // 拉取完成快照可能与本地 delta 交错到达；只有「整个完成快照为空」时保留已累计摘要，非空完成值仍可合法改写。
    if (
      typeof incoming.time?.end === "number" &&
      !incoming.text &&
      !incoming.originalText &&
      (!!current.text || !!current.originalText)
    ) {
      return {
        ...incoming,
        text: current.text,
        originalText: current.originalText,
      } satisfies Part
    }
  }

  if (!liveTextPart(incoming)) return incoming

  if (incoming.type === "reasoning" && current.type === "reasoning") {
    return {
      ...incoming,
      text: preserveLivePrefix(incoming.text, current.text) ?? incoming.text,
      originalText: preserveLivePrefix(incoming.originalText, current.originalText) ?? incoming.originalText,
    } satisfies Part
  }

  return incoming
}

export function mergeLivePartSnapshots(current: Part[] | undefined, incoming: Part[]) {
  if (!current?.length) return incoming
  return incoming.map((part) => mergeLivePartSnapshot(current.find((item) => item.id === part.id), part))
}
