import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.appLayer, node))

describe("addon skill namespacing", () => {
  it.live("addon skill gets <plugin>: prefix and coexists with user skill of same name", () =>
    Effect.gen(function* () {
      // create addon directory outside the project tmp dir
      const addonTmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: false })),
        (t) => Effect.promise(() => t[Symbol.asyncDispose]()),
      )

      // create addon structure:  <addonTmp>/my-market/my-plugin/local/.codex-plugin/plugin.json
      //                          <addonTmp>/my-market/my-plugin/local/skills/foo/SKILL.md
      const pluginRoot = path.join(addonTmp.path, "my-market", "my-plugin", "local")
      const codexPluginDir = path.join(pluginRoot, ".codex-plugin")
      const skillDir = path.join(pluginRoot, "skills", "foo")
      yield* Effect.promise(() =>
        Promise.all([
          fs.mkdir(codexPluginDir, { recursive: true }),
          fs.mkdir(skillDir, { recursive: true }),
        ]),
      )
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(
            path.join(codexPluginDir, "plugin.json"),
            JSON.stringify({ name: "my-plugin", version: "1.0.0", skills: "skills" }),
          ),
          Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---\nname: foo\ndescription: Addon foo skill\n---\n\n# Foo from addon\n`,
          ),
        ]),
      )

      // run in a project that has addon.paths pointing to addonTmp and a user skill named "foo"
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            // write a project-local user skill named "foo"
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".wanlaicode", "skill", "foo", "SKILL.md"),
                `---\nname: foo\ndescription: User foo skill\n---\n\n# Foo from user\n`,
              ),
            )
            // write wanlaicode.json with addon path
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, "wanlaicode.json"),
                JSON.stringify({
                  $schema: "https://opencode.ai/config.json",
                  addon: { enabled: true, paths: [addonTmp.path] },
                }),
              ),
            )

            const skillSvc = yield* Skill.Service
            const all = yield* skillSvc.all()

            const namespacedFoo = all.find((s) => s.name === "my-plugin:foo")
            const userFoo = all.find((s) => s.name === "foo")

            expect(namespacedFoo).toBeDefined()
            expect(namespacedFoo!.description).toBe("Addon foo skill")

            expect(userFoo).toBeDefined()
            expect(userFoo!.description).toBe("User foo skill")

            const available = yield* skillSvc.available()
            expect(available.find((s) => s.name === "my-plugin:foo")).toBeDefined()
            expect(available.find((s) => s.name === "foo")).toBeDefined()
          }),
        { git: true },
      )
    }),
  )

  it.live("disabled addon skills are not loaded", () =>
    Effect.gen(function* () {
      const addonTmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: false })),
        (t) => Effect.promise(() => t[Symbol.asyncDispose]()),
      )

      const pluginRoot = path.join(addonTmp.path, "my-market", "disabled-plugin", "local")
      const codexPluginDir = path.join(pluginRoot, ".codex-plugin")
      const skillDir = path.join(pluginRoot, "skills", "bar")
      yield* Effect.promise(() =>
        Promise.all([fs.mkdir(codexPluginDir, { recursive: true }), fs.mkdir(skillDir, { recursive: true })]),
      )
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(
            path.join(codexPluginDir, "plugin.json"),
            JSON.stringify({ name: "disabled-plugin", version: "1.0.0", skills: "skills" }),
          ),
          Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---\nname: bar\ndescription: Skill from disabled plugin\n---\n\nContent.\n`,
          ),
        ]),
      )

      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, "wanlaicode.json"),
                JSON.stringify({
                  $schema: "https://opencode.ai/config.json",
                  addon: { enabled: true, paths: [addonTmp.path] },
                  plugins: { "disabled-plugin@my-market": { enabled: false } },
                }),
              ),
            )

            const skillSvc = yield* Skill.Service
            const all = yield* skillSvc.all()
            expect(all.find((s) => s.name === "disabled-plugin:bar")).toBeUndefined()
          }),
        { git: true },
      )
    }),
  )
})
