import { readFile, readdir } from "fs/promises"
import path from "path"

export interface CodexSkill {
  name: string
  displayName?: string
  shortDescription?: string
  longDescription?: string
  description: string
  content: string
  location: string
  dependencies?: string[]
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/s)
  if (!match) return { data: {}, content: raw }

  const yamlText = match[1] ?? ""
  const content = match[2] ?? ""
  const data: Record<string, unknown> = {}

  const lines = yamlText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    if (!key) continue
    const value = line.slice(colonIdx + 1).trim()

    // YAML 块标量：`key: |`(字面，保留换行) 或 `key: >`(折叠，换行变空格)，可带 chomping(+/-)。
    // 值取后续比当前行更深缩进的块。frontmatter 的多行 description 常用 `|`。
    const block = value.match(/^([|>])[+-]?$/)
    if (block) {
      const baseIndent = line.match(/^\s*/)![0].length
      const collected: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!
        if (next.trim() !== "" && next.match(/^\s*/)![0].length <= baseIndent) break
        collected.push(next)
        i++
      }
      const indents = collected.filter((l) => l.trim() !== "").map((l) => l.match(/^\s*/)![0].length)
      const min = indents.length ? Math.min(...indents) : 0
      const dedented = collected.map((l) => l.slice(min))
      while (dedented.length && dedented[dedented.length - 1]!.trim() === "") dedented.pop()
      data[key] =
        block[1] === "|"
          ? dedented.join("\n")
          : dedented.map((l) => l.trim()).filter(Boolean).join(" ")
      continue
    }

    if (!value) continue
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    } else {
      data[key] = value.replace(/^['"]|['"]$/g, "")
    }
  }

  return { data, content: content.trimStart() }
}

interface OpenAIYaml {
  name?: string
  description?: string
  display_name?: string
}

async function tryReadOpenAIYaml(skillDir: string): Promise<OpenAIYaml> {
  // 优先读 wanlaicode 自有的 agents/wanlaicode.yaml;兼容外部 codex 插件的 openai.yaml。
  const candidates = [
    path.join(skillDir, "agents", "wanlaicode.yaml"),
    path.join(skillDir, "wanlaicode.yaml"),
    path.join(skillDir, "agents", "openai.yaml"),
    path.join(skillDir, "openai.yaml"),
  ]
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf-8")
      const result: OpenAIYaml = {}
      for (const line of text.split(/\r?\n/)) {
        const colonIdx = line.indexOf(":")
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim() as keyof OpenAIYaml
        if (!["name", "description", "display_name"].includes(key)) continue
        const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "")
        if (value) result[key] = value
      }
      return result
    } catch {
      // file not found, try next
    }
  }
  return {}
}

export async function loadSkillsFromDir(skillsDir: string): Promise<CodexSkill[]> {
  let entries: { name: string; path: string }[] = []
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(skillsDir, e.name) }))
  } catch {
    return []
  }

  const results: CodexSkill[] = []

  await Promise.all(
    entries.map(async (entry) => {
      const skillFile = path.join(entry.path, "SKILL.md")
      let raw: string
      try {
        raw = await readFile(skillFile, "utf-8")
      } catch {
        return
      }

      const { data, content } = parseFrontmatter(raw)
      const openai = await tryReadOpenAIYaml(entry.path)

      const name = (data["name"] as string | undefined) || openai.name || entry.name
      const description =
        (data["description"] as string | undefined) ||
        openai.description ||
        (data["shortDescription"] as string | undefined) ||
        (data["longDescription"] as string | undefined)

      if (!description) return

      const skill: CodexSkill = {
        name,
        content,
        location: skillFile,
        description,
      }

      if (data["displayName"] || openai.display_name) skill.displayName = (data["displayName"] as string | undefined) ?? openai.display_name
      if (data["shortDescription"]) skill.shortDescription = data["shortDescription"] as string
      if (data["longDescription"]) skill.longDescription = data["longDescription"] as string
      if (Array.isArray(data["dependencies"])) skill.dependencies = data["dependencies"] as string[]

      results.push(skill)
    }),
  )

  return results
}

export async function loadSkillsFromAddonRoot(root: string, skillsPath?: string): Promise<CodexSkill[]> {
  const dir = path.join(root, skillsPath ?? "skills")
  return loadSkillsFromDir(dir)
}
