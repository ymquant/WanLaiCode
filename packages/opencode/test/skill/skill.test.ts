import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))
const nonBuiltinSkills = (list: Skill.Info[]) => list.filter((item) => item.source !== "builtin")

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = (process.env.WANLAICODE_TEST_HOME ?? process.env.OPENCODE_TEST_HOME)
      process.env.WANLAICODE_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.WANLAICODE_TEST_HOME = prev
      }),
  )

describe("skill", () => {
  it.live("discovers skills from .wanlaicode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".wanlaicode", "skill", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          // 这些用例只验证测试现场创建的外部 skill；内置 skill 另有专门用例覆盖。
          const list = nonBuiltinSkills(yield* skill.all())
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".wanlaicode", "skill", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".wanlaicode", "skill", "dir-skill"))
            expect(dirs.length).toBe(1)
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .wanlaicode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".wanlaicode", "skill", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".wanlaicode", "skill", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = nonBuiltinSkills(yield* skill.all())
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".wanlaicode", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect(nonBuiltinSkills(yield* skill.all())).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .claude/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
              `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = nonBuiltinSkills(yield* skill.all())
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "claude-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.claude/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = nonBuiltinSkills(yield* skill.all())
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-test-skill")
            expect(list[0].description).toBe("A global skill from ~/.claude/skills for testing.")
            expect(list[0].location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect(nonBuiltinSkills(yield* skill.all())).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
              `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = nonBuiltinSkills(yield* skill.all())
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "agent-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.agents/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = nonBuiltinSkills(yield* skill.all())
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-agent-skill")
            expect(list[0].description).toBe("A global skill from ~/.agents/skills for testing.")
            expect(list[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers skills from both .claude/skills/ and .agents/skills/", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = nonBuiltinSkills(yield* skill.all())
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "claude-skill")).toBeDefined()
          expect(list.find((x) => x.name === "agent-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".wanlaicode", "skill", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .wanlaicode/skill directory.
---

# OpenCode Skill
`,
              ),
              Bun.write(
                path.join(dir, ".wanlaicode", "skills", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .wanlaicode/skills directory.
---

# OpenCode Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.dirs()).length).toBe(4)
        }),
      { git: true },
    ),
  )

  it.live("discovers builtin skills and tags source", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const builtinDir = path.join(dir, "builtin-skills", "demo-skill")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(builtinDir, "SKILL.md"),
            `---\nname: demo-skill\ndescription: A bundled builtin skill.\n---\n\n# Demo\n`,
          ),
        )
        const prev = process.env.WANLAICODE_BUILTIN_SKILLS_DIR
        process.env.WANLAICODE_BUILTIN_SKILLS_DIR = path.join(dir, "builtin-skills")
        try {
          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const item = list.find((x) => x.name === "demo-skill")
          expect(item).toBeDefined()
          expect(item!.source).toBe("builtin")
        } finally {
          process.env.WANLAICODE_BUILTIN_SKILLS_DIR = prev
        }
      }),
    ),
  )

  it.live("reads displayName and icon from agents/wanlaicode.yaml in builtin skill", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const builtinDir = path.join(dir, "builtin-skills", "icon-skill")
        const assetsDir = path.join(builtinDir, "assets")
        const agentsDir = path.join(builtinDir, "agents")
        yield* Effect.promise(() => fs.mkdir(assetsDir, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(agentsDir, { recursive: true }))

        const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>`
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(
              path.join(builtinDir, "SKILL.md"),
              `---\nname: icon-skill\ndescription: A skill with display name and icon.\n---\n\n# Icon Skill\n`,
            ),
            Bun.write(path.join(assetsDir, "icon-small.svg"), svgContent),
            Bun.write(
              path.join(agentsDir, "wanlaicode.yaml"),
              `interface:\n  display_name: "Icon Skill Display"\n  icon_small: ./assets/icon-small.svg\n`,
            ),
          ]),
        )

        const prev = process.env.WANLAICODE_BUILTIN_SKILLS_DIR
        process.env.WANLAICODE_BUILTIN_SKILLS_DIR = path.join(dir, "builtin-skills")
        try {
          const skill = yield* Skill.Service
          const list = yield* skill.all()
          const item = list.find((x) => x.name === "icon-skill")
          expect(item).toBeDefined()
          expect(item!.displayName).toBe("Icon Skill Display")
          expect(item!.icon).toBeDefined()
          expect(item!.icon!.startsWith("data:image/svg+xml;base64,")).toBe(true)
        } finally {
          process.env.WANLAICODE_BUILTIN_SKILLS_DIR = prev
        }
      }),
    ),
  )

  it.live("non-builtin skill overrides builtin with same name", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Place override-skill as a project (config) skill inside the instance dir
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".wanlaicode", "skill", "override-skill", "SKILL.md"),
            `---\nname: override-skill\ndescription: From project.\n---\n\n# P\n`,
          ),
        )
        // Place override-skill in the builtin dir
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "builtin-skills", "override-skill", "SKILL.md"),
            `---\nname: override-skill\ndescription: From builtin.\n---\n\n# B\n`,
          ),
        )
        const prev = process.env.WANLAICODE_BUILTIN_SKILLS_DIR
        process.env.WANLAICODE_BUILTIN_SKILLS_DIR = path.join(dir, "builtin-skills")
        try {
          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((x) => x.name === "override-skill")
          expect(item!.description).toBe("From project.")
          expect(item!.source).toBe("config")
        } finally {
          process.env.WANLAICODE_BUILTIN_SKILLS_DIR = prev
        }
      }),
    ),
  )
})
