import { skillDisplayName } from "@opencode-ai/ui/skill-chip"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createSignal } from "solid-js"

export type SkillPreviewInfo = {
  name: string
  displayName: string
  path: string
}

export type SkillFilePreviewRequest = SkillPreviewInfo & {
  id: number
}

const registry = new Map<string, SkillPreviewInfo>()
const [skillFilePreviewRequest, setSkillFilePreviewRequest] = createSignal<SkillFilePreviewRequest>()
let nextSkillFilePreviewRequestID = 0
const BUILTIN_SKILL_PREFIX = "builtin:"

export function resolveSkillPreviewPath(input: { path: string; name?: string; home?: string }) {
  if (!input.path.startsWith(BUILTIN_SKILL_PREFIX)) return input.path

  const name = (input.name?.trim() || input.path.slice(BUILTIN_SKILL_PREFIX.length).trim()).replace(/^\/+|\/+$/g, "")
  if (name.toLowerCase() !== "imagegen") return input.path
  const home = input.home?.replace(/\/+$/, "")
  if (!name || !home) return input.path

  // 内置 imagegen 的运行时 location 可能是 builtin:imagegen;预览时要落到本机 Codex
  // 系统 skill 的真实 SKILL.md,这样右侧能显示内容和存放目录。
  return `${home}/.codex/skills/.system/imagegen/SKILL.md`
}

function skillNameFromPath(path: string) {
  const filename = getFilename(path)
  if (filename !== "SKILL.md") return filename
  return getFilename(getDirectory(path) || path)
}

export function normalizeSkillPreview(input: { name?: string; displayName?: string; path: string }): SkillPreviewInfo {
  const name = input.name?.trim() || input.displayName?.trim() || skillNameFromPath(input.path)
  return {
    name,
    displayName: input.displayName?.trim() || skillDisplayName(name),
    path: input.path,
  }
}

export function registerSkillPreview(input: { name?: string; displayName?: string; path: string; aliases?: string[] }) {
  const info = normalizeSkillPreview(input)
  registry.set(info.path, info)
  for (const alias of input.aliases ?? []) {
    if (alias) registry.set(alias, info)
  }
  return info
}

export function getSkillPreview(path: string | undefined) {
  if (!path) return undefined
  return registry.get(path)
}

export function requestSkillFilePreview(input: SkillPreviewInfo) {
  setSkillFilePreviewRequest({
    ...input,
    id: nextSkillFilePreviewRequestID++,
  })
}

export function useSkillFilePreviewRequest() {
  return skillFilePreviewRequest
}
