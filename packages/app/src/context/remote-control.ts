import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export const REMOTE_CONTROL_STATUS_QUERY_KEY = ["remote-control", "status"] as const
export const REMOTE_CONTROL_STATUS_REFETCH_INTERVAL_MS = 1_000

export type RemoteControlPhonePresence = "hidden" | "online" | "offline"

// 主工具栏只聚合已绑定手机的 presence；网关 connected 仅代表桌面连上 relay，不能代替手机在线状态。
export function remoteControlPhonePresence(connections?: readonly { online: boolean }[]): RemoteControlPhonePresence {
  if (!connections?.length) return "hidden"
  return connections.some((connection) => connection.online) ? "online" : "offline"
}

// 设置页与主工具栏共用同一个 Query，确保轮询频率、缓存和设备在线结论始终一致。
export function remoteControlStatusQuery(client: OpencodeClient) {
  return {
    queryKey: REMOTE_CONTROL_STATUS_QUERY_KEY,
    queryFn: async () => (await client.remoteControl.status({ throwOnError: true })).data,
    refetchInterval: REMOTE_CONTROL_STATUS_REFETCH_INTERVAL_MS,
  }
}
