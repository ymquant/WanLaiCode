import type { LanguageModelV3 } from "@ai-sdk/provider"
import { generateText, jsonSchema, tool, type ModelMessage } from "ai"
import { Effect, Exit, Cause } from "effect"

// 可复用的 AI 意图分类工具。
//
// 为什么不用 `generateObject`：wanlaicode 走 @ai-sdk/openai-compatible，其
// supportsStructuredOutputs 默认 false，schema 会被降级成 response_format:json_object，
// 很多 relay/模型直接 400 或返回不合规 JSON，导致 generateObject 抛错（“AI 分类暂时不可用”）。
// 这里改用 generateText + 宽松 JSON 解析，兼容所有 chat 模型，不依赖结构化输出。

export type IntentClassification<Action extends string> = {
  action: Action
  confidence: number
  reason?: string
  data: Record<string, unknown>
}

export type ClassifyIntentInput<Action extends string> = {
  // 候选模型，按顺序尝试，第一个成功即返回。默认应传当前会话选中的模型在最前。
  candidates: readonly LanguageModelV3[]
  // 允许的 action 标签集合（如 ["generate","edit","none"]）。
  actions: readonly Action[]
  // 可选的路由工具。存在时先让模型用 tool-call 做选择，失败再退回纯文本 JSON。
  tools?: readonly {
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }[]
  system: string
  user: string
  timeoutMs?: number
  maxOutputTokens?: number
  maxRetries?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// 从模型文本输出里宽松提取第一个**可解析**的 JSON 对象。容忍 ```json 包裹、前后多余文本、
// 甚至正文里出现的字面 {大括号}（首个候选解析失败会从下一个 { 继续尝试）。
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  for (let start = body.indexOf("{"); start !== -1; start = body.indexOf("{", start + 1)) {
    const candidate = matchBalancedObject(body, start)
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 这个候选不是合法 JSON，继续从下一个 { 尝试
    }
  }
  return undefined
}

// 从 start 处的 { 起做括号配对（忽略字符串内的括号），返回完整对象子串；不配对返回 undefined。
function matchBalancedObject(body: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  return undefined
}

export function normalizeClassification<Action extends string>(
  raw: Record<string, unknown> | undefined,
  actions: readonly Action[],
): IntentClassification<Action> | undefined {
  if (!raw) return undefined
  const action =
    typeof raw.action === "string"
      ? (raw.action.trim().toLowerCase() as Action)
      : raw.route === "chat" && actions.includes("none" as Action)
        ? ("none" as Action)
        : raw.route === "tool" && actions.includes("generate" as Action)
          ? ("generate" as Action)
        : undefined
  if (!action || !actions.includes(action)) return undefined
  const confidenceRaw = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : undefined
  return { action, confidence, reason, data: raw }
}

// 按候选顺序尝试用 generateText 分类，第一个产出可解析 JSON 的即返回。
// 全部失败则 Effect.fail，调用方据此回落到普通聊天。
export function classifyIntent<Action extends string>(input: ClassifyIntentInput<Action>) {
  const messages: ModelMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ]
  const runOne = (model: LanguageModelV3, withTools: boolean) =>
    Effect.tryPromise({
      try: (signal) => {
        const routeTools =
          withTools && input.tools?.length
            ? Object.fromEntries(
                input.tools.map((item) => [
                  item.name,
                  tool({
                    description: item.description,
                    inputSchema: jsonSchema(item.inputSchema),
                    async execute(args: unknown) {
                      return args
                    },
                  }),
                ]),
              )
            : undefined

        return generateText({
          model,
          temperature: 0,
          maxOutputTokens: input.maxOutputTokens ?? 200,
          maxRetries: input.maxRetries,
          abortSignal: signal,
          messages,
          ...(routeTools ? { tools: routeTools, toolChoice: "auto" as const } : {}),
        }).then((output) => {
          const toolCall = output.toolCalls.find((item) =>
            input.tools?.some((candidate) => candidate.name === item.toolName),
          )
          const toolInput = isRecord(toolCall?.input) ? toolCall.input : undefined
          return {
            text: output.text,
            raw: toolCall
              ? {
                  ...(toolInput ?? {}),
                  route: "tool",
                  tool: toolCall.toolName,
                  confidence: toolInput?.confidence ?? 0.9,
                }
              : undefined,
          }
        })
      },
      catch: (cause) => cause,
    })

  return Effect.gen(function* () {
    let lastCause: unknown = "No usable model produced a parseable intent classification"
    for (const model of input.candidates) {
      for (const withTools of input.tools?.length ? [true, false] : [false]) {
        const attempt = yield* runOne(model, withTools).pipe(Effect.timeout(input.timeoutMs ?? 8000), Effect.exit)
        if (Exit.isSuccess(attempt)) {
          const parsed = normalizeClassification(attempt.value.raw ?? extractJsonObject(attempt.value.text), input.actions)
          if (parsed) return parsed
          lastCause = `Model output was not parseable intent JSON: ${attempt.value.text.slice(0, 200)}`
          continue
        }
        lastCause = Cause.squash(attempt.cause)
      }
    }
    return yield* Effect.fail(lastCause)
  })
}
