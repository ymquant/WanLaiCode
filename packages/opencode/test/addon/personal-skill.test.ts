import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import { Addon } from "../../src/addon"
import { Skill } from "../../src/skill"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

function runWithServices<A>(directory: string, effect: Effect.Effect<A, unknown, Addon.Service | Skill.Service>) {
  return provideTestInstance({
    directory,
    fn: () =>
      Effect.runPromise(
        effect.pipe(Effect.provide(Layer.mergeAll(Skill.appLayer))),
      ),
  })
}

test("personal skills appear before install and become available after install", async () => {
  await using project = await tmpdir()
  const personalRoot = path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "personal")
  const skillDir = path.join(personalRoot, "skills", "demo-skill")

  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: demo-skill
description: |
  Personal skill created by skill-creator.
  Supports block scalar descriptions.
---

# Demo Skill
`,
  )

  try {
    await runWithServices(
      project.path,
      Effect.gen(function* () {
        const addon = yield* Addon.Service
        const skill = yield* Skill.Service

        const before = yield* addon.getSkillList()
        expect(before.find((item) => item.namespaced_name === "demo-skill")).toMatchObject({
          name: "demo-skill",
          description: "Personal skill created by skill-creator.\nSupports block scalar descriptions.\n",
          installed: false,
          enabled: false,
          addon_key: "personal-skills@personal",
        })
        expect(before.find((item) => item.namespaced_name === "demo-skill")?.content).toBeUndefined()
        expect((yield* addon.getSkillContent("personal-skills@personal", "demo-skill")).content).toContain("# Demo Skill")
        expect((yield* skill.available()).some((item) => item.name === "demo-skill")).toBe(false)

        yield* addon.setSkillInstalled("personal-skills@personal", "demo-skill", true)
        yield* skill.invalidate()

        const after = yield* addon.getSkillList()
        expect(after.find((item) => item.namespaced_name === "demo-skill")).toMatchObject({
          installed: true,
          enabled: true,
        })
        expect((yield* skill.available()).some((item) => item.name === "demo-skill")).toBe(true)

        yield* addon.setSkillEnabled("personal-skills@personal", "demo-skill", false)
        yield* skill.invalidate()

        const disabled = yield* addon.getSkillList()
        expect(disabled.find((item) => item.namespaced_name === "demo-skill")).toMatchObject({
          installed: true,
          enabled: false,
        })
        expect((yield* skill.available()).some((item) => item.name === "demo-skill")).toBe(false)

        yield* addon.setSkillEnabled("personal-skills@personal", "demo-skill", true)
        yield* skill.invalidate()

        const reenabled = yield* addon.getSkillList()
        expect(reenabled.find((item) => item.namespaced_name === "demo-skill")).toMatchObject({
          installed: true,
          enabled: true,
        })
        expect((yield* skill.available()).some((item) => item.name === "demo-skill")).toBe(true)

        yield* addon.setSkillInstalled("personal-skills@personal", "demo-skill", false)
        yield* skill.invalidate()

        const uninstalled = yield* addon.getSkillList()
        expect(uninstalled.find((item) => item.namespaced_name === "demo-skill")).toMatchObject({
          installed: false,
          enabled: false,
        })
        expect((yield* skill.available()).some((item) => item.name === "demo-skill")).toBe(false)
      }),
    )
  } finally {
    await rm(personalRoot, { recursive: true, force: true })
  }
})
