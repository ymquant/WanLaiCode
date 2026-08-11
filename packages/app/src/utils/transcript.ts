import type { AssistantMessage, Part, Provider, UserMessage } from "@opencode-ai/sdk/v2"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type TranscriptSession = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

function titlecase(value: string) {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function modelName(providers: Provider[] | undefined, providerID: string, modelID: string) {
  const provider = providers?.find((item) => item.id === providerID)
  return provider?.models[modelID]?.name ?? modelID
}

function assistantHeader(msg: AssistantMessage, options: TranscriptOptions) {
  if (!options.assistantMetadata) return "## Assistant\n\n"
  const duration =
    msg.time.completed && msg.time.created ? `${((msg.time.completed - msg.time.created) / 1000).toFixed(1)}s` : ""
  return `## Assistant (${titlecase(msg.agent)} · ${modelName(options.providers, msg.providerID, msg.modelID)}${
    duration ? ` · ${duration}` : ""
  })\n\n`
}

function formatPart(part: Part, options: TranscriptOptions) {
  if (part.type === "text" && !part.synthetic) return `${part.text}\n\n`
  if (part.type === "reasoning") return options.thinking ? `_Thinking:_\n\n${part.text}\n\n` : ""
  if (part.type === "file") return part.filename ? `**File:** ${part.filename}\n\n` : ""
  if (part.type !== "tool") return ""

  let result = `**Tool: ${part.tool}**\n`
  if (options.toolDetails && part.state.input) {
    result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
  }
  if (options.toolDetails && part.state.status === "completed" && part.state.output) {
    result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
  }
  if (options.toolDetails && part.state.status === "error" && part.state.error) {
    result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
  }
  return `${result}\n`
}

export function formatTranscript(session: TranscriptSession, messages: MessageWithParts[], options: TranscriptOptions) {
  return [
    `# ${session.title}`,
    "",
    `**Session ID:** ${session.id}`,
    `**Created:** ${new Date(session.time.created).toLocaleString()}`,
    `**Updated:** ${new Date(session.time.updated).toLocaleString()}`,
    "",
    "---",
    "",
    ...messages.flatMap((message) => [
      message.info.role === "user" ? "## User\n\n" : assistantHeader(message.info, options),
      ...message.parts.map((part) => formatPart(part, options)),
      "---",
      "",
    ]),
  ].join("\n")
}
