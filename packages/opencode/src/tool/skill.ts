import path from "path"
import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import { MessageV2 } from "@/session/message-v2"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

const ambiguousImagegenFollowupPattern =
  /^(?:[?？!.。…]+|啥|什么|什么情况|啥情况|怎么回事|什么意思|啥意思|呢|然后呢|继续呢|再呢|why|what|huh|ok|好的|好|嗯|啊|哦)$/i

const latestUserText = (ctx: Tool.Context) =>
  ctx.messages
    .findLast((message) => message.info.role === "user")
    ?.parts.flatMap((part) => {
      const text = MessageV2.visibleUserTextPart(part)
      return text ? [text] : []
    })
    .join("\n")
    .trim()

const ambiguousImagegenFollowup = (ctx: Tool.Context) => {
  const text = latestUserText(ctx)
  if (!text) return false
  if (ambiguousImagegenFollowupPattern.test(text)) return true
  if (text.length > 12) return false
  return /^[\p{P}\p{S}\s]+$/u.test(text)
}

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill.get(params.name)
          if (!info) {
            const all = yield* skill.all()
            const available = all.map((item) => item.name).join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }

          // imagegen 是普通模型生图的内置说明，但短追问不能被上一轮生图上下文误吸进去。
          if (info.name === "imagegen" && ambiguousImagegenFollowup(ctx)) {
            throw new Error("The latest user message is a clarification/follow-up, not an image generation request.")
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const builtin = Skill.isBuiltinLocation(info.location)
          const dir = builtin ? info.location : path.dirname(info.location)
          const base = builtin ? info.location : pathToFileURL(dir).href
          const limit = 10
          const files = builtin
            ? ""
            : yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
                Stream.filter((file) => !file.includes("SKILL.md")),
                Stream.map((file) => path.resolve(dir, file)),
                Stream.take(limit),
                Stream.runCollect,
                Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
              )
          const imagegenNextStep =
            info.name === "imagegen"
              ? [
                  "",
                  "Next step required for imagegen:",
                  "If the latest user message is a real image generation or image edit request, call the image_generation tool now with a concrete prompt. Loading this skill alone did not create an image.",
                  "If the latest user message is only punctuation or a clarification such as ?, 什么意思, 啥情况, or 怎么回事, do not call image_generation; answer in normal chat.",
                ].join("\n")
              : undefined

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              imagegenNextStep,
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files,
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
