import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { loadSkillsFromAddonRoot, loadSkillsFromDir } from "./skills-loader"

async function mkdirTemp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "addon-skills-"))
  return { path: dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

describe("skills-loader", () => {
  test("parses standard frontmatter", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "my-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: my-skill\ndescription: Does something useful\n---\n\n# My Skill\nContent here.\n`,
      )

      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe("my-skill")
      expect(skills[0]!.description).toBe("Does something useful")
      expect(skills[0]!.content).toContain("# My Skill")
      expect(skills[0]!.location).toContain("SKILL.md")
    } finally {
      await tmp.cleanup()
    }
  })

  test("parses YAML block scalar description (| literal)", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "block-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: block-skill\ndescription: |\n  Capture a website and create a video.\n  Use when a user provides a URL.\n---\n\nContent.\n`,
      )
      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.description).toBe(
        "Capture a website and create a video.\nUse when a user provides a URL.",
      )
    } finally {
      await tmp.cleanup()
    }
  })

  test("uses directory name as fallback name when frontmatter has no name", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "dir-name-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\ndescription: Description only\n---\n\nContent.\n`,
      )

      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe("dir-name-skill")
    } finally {
      await tmp.cleanup()
    }
  })

  test("skips skills with no description", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "no-desc")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: no-desc\n---\n\nContent without description.\n`)

      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(0)
    } finally {
      await tmp.cleanup()
    }
  })

  test("skips skills with no SKILL.md file", async () => {
    const tmp = await mkdirTemp()
    try {
      await fs.mkdir(path.join(tmp.path, "empty-dir"), { recursive: true })
      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(0)
    } finally {
      await tmp.cleanup()
    }
  })

  test("merges openai.yaml metadata", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "openai-skill")
      const agentsDir = path.join(skillDir, "agents")
      await fs.mkdir(agentsDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: openai-skill\n---\n\nContent.\n`,
      )
      await fs.writeFile(
        path.join(agentsDir, "openai.yaml"),
        `name: overridden-name\ndescription: Description from openai.yaml\ndisplay_name: OpenAI Skill Display\n`,
      )

      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.description).toBe("Description from openai.yaml")
    } finally {
      await tmp.cleanup()
    }
  })

  test("frontmatter description takes priority over openai.yaml", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "priority-skill")
      const agentsDir = path.join(skillDir, "agents")
      await fs.mkdir(agentsDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: priority-skill\ndescription: From frontmatter\n---\n\nContent.\n`,
      )
      await fs.writeFile(path.join(agentsDir, "openai.yaml"), `description: From openai.yaml\n`)

      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.description).toBe("From frontmatter")
    } finally {
      await tmp.cleanup()
    }
  })

  test("loadSkillsFromAddonRoot uses 'skills' dir by default", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "skills", "my-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: my-skill\ndescription: Root skill\n---\n\nContent.\n`,
      )

      const skills = await loadSkillsFromAddonRoot(tmp.path)
      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe("my-skill")
    } finally {
      await tmp.cleanup()
    }
  })

  test("loadSkillsFromAddonRoot respects custom skillsPath", async () => {
    const tmp = await mkdirTemp()
    try {
      const skillDir = path.join(tmp.path, "custom-skills", "tool-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: tool-skill\ndescription: Custom path skill\n---\n\nContent.\n`,
      )

      const skills = await loadSkillsFromAddonRoot(tmp.path, "custom-skills")
      expect(skills).toHaveLength(1)
      expect(skills[0]!.name).toBe("tool-skill")
    } finally {
      await tmp.cleanup()
    }
  })

  test("returns empty array when skills dir does not exist", async () => {
    const tmp = await mkdirTemp()
    try {
      const skills = await loadSkillsFromAddonRoot(tmp.path)
      expect(skills).toHaveLength(0)
    } finally {
      await tmp.cleanup()
    }
  })

  test("loads multiple skills from directory", async () => {
    const tmp = await mkdirTemp()
    try {
      for (const skillName of ["alpha", "beta", "gamma"]) {
        const skillDir = path.join(tmp.path, skillName)
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${skillName}\ndescription: Description for ${skillName}\n---\n\nContent.\n`,
        )
      }

      const skills = await loadSkillsFromDir(tmp.path)
      expect(skills).toHaveLength(3)
      const names = skills.map((s) => s.name).sort()
      expect(names).toEqual(["alpha", "beta", "gamma"])
    } finally {
      await tmp.cleanup()
    }
  })
})
