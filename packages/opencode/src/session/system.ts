import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

// 任务被本机缺失的依赖/CLI 挡住时，引导模型主动提出代为安装，而不是只报告问题然后等待。
export const PROMPT_MISSING_DEPS =
  "If a task is blocked because a required local dependency or CLI is missing from the user's machine (e.g. Node.js, npm, or a tool-specific CLI), do not just report the problem and stop. Tell the user exactly what is missing, ask whether they would like you to install it for them, and run the installation once they agree."

export function provider(model: Provider.Model) {
  return [...basePrompt(model), PROMPT_MISSING_DEPS]
}

function basePrompt(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

// BCP47 标签 → 英文语言名（如 zh-Hans → "Chinese, Simplified"）
export function languageName(tag: string) {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag
}

// 根据 BCP47 标签生成"默认用该语言思考+回复，对话显式指定则跟随用户"的系统指令
// 语言指令「用目标语言本身书写」比英文更能把模型的思考(reasoning)语言带过去。
// 能可靠书写的语种给母语指令；其余回退到点名 reasoning 的强化英文。键用 BCP47 小写（全量 + 主语言前缀）。
const NATIVE_LANGUAGE_DIRECTIVES: Record<string, string> = {
  zh: "请始终用简体中文进行思考（包括你的内部推理过程）和回复，除非用户在对话中改用或明确要求其他语言。",
  "zh-hans": "请始终用简体中文进行思考（包括你的内部推理过程）和回复，除非用户在对话中改用或明确要求其他语言。",
  "zh-hant": "請始終以繁體中文進行思考（包含你的內部推理過程）與回覆，除非使用者在對話中改用或明確要求其他語言。",
  ja: "常に日本語で思考（内部の推論を含む）し、回答してください。ユーザーが別の言語で書く、または明示的に要求する場合を除きます。",
  ko: "항상 한국어로 사고(내부 추론 포함)하고 답변하세요. 사용자가 다른 언어로 쓰거나 명시적으로 요청하는 경우는 예외입니다.",
  de: "Denke (einschließlich deiner internen Überlegungen) und antworte immer auf Deutsch, sofern der Nutzer nicht in einer anderen Sprache schreibt oder ausdrücklich eine andere verlangt.",
  es: "Piensa (incluido tu razonamiento interno) y responde siempre en español, a menos que el usuario escriba o solicite explícitamente otro idioma.",
  fr: "Réfléchis (y compris ton raisonnement interne) et réponds toujours en français, sauf si l'utilisateur écrit ou demande explicitement une autre langue.",
  ru: "Всегда думай (включая внутренние рассуждения) и отвечай на русском языке, если пользователь не пишет или явно не просит на другом языке.",
  pt: "Pense (incluindo seu raciocínio interno) e responda sempre em português, a menos que o usuário escreva ou solicite explicitamente outro idioma.",
  "pt-br": "Pense (incluindo seu raciocínio interno) e responda sempre em português, a menos que o usuário escreva ou solicite explicitamente outro idioma.",
}

export function language(tag: string) {
  const key = tag.toLowerCase()
  const native = NATIVE_LANGUAGE_DIRECTIVES[key] ?? NATIVE_LANGUAGE_DIRECTIVES[key.split("-")[0]]
  if (native) return native
  const name = languageName(tag)
  return `IMPORTANT: Always think (including your internal reasoning / chain of thought) and respond in ${name}. Do not default to English. If the user writes in, or explicitly asks for, a different language, follow the user's lead instead.`
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
