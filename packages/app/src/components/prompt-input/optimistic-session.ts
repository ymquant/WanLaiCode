import type { Session } from "@opencode-ai/sdk/v2/client"
import { Identifier } from "@/utils/id"

const TRANSPORT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "network error (no response)",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "client closed",
]

export function isTransportError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return false
    const message = error.message.toLowerCase()
    if (TRANSPORT_MESSAGES.some((item) => message.includes(item))) return true
  }
  if (typeof error === "string") {
    const message = error.toLowerCase()
    return TRANSPORT_MESSAGES.some((item) => message.includes(item))
  }
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>
    if ("error" in obj) return isTransportError(obj.error)
    if (typeof obj.message === "string") return isTransportError(obj.message)
  }
  return false
}

export function newSessionID() {
  return Identifier.descending("session")
}

export function createOptimisticSession(input: {
  id: string
  directory: string
  projectID?: string
  agent?: string
  model?: { modelID: string; providerID: string; variant?: string }
}): Session {
  const now = Date.now()
  return {
    id: input.id,
    slug: input.id.slice(4),
    projectID: input.projectID ?? "",
    directory: input.directory,
    title: `New session - ${new Date(now).toISOString()}`,
    agent: input.agent,
    model: input.model
      ? {
          id: input.model.modelID,
          providerID: input.model.providerID,
          variant: input.model.variant,
        }
      : undefined,
    version: "",
    time: { created: now, updated: now },
  }
}
