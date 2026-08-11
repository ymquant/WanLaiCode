import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

describe("builtin imagegen skill", () => {
  it.live("tags imagegen as builtin for system skills list", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const imagegen = (yield* skill.all()).find((item) => item.name === "imagegen")

          // 插件页“系统”分组只展示 source 为 builtin 的技能。
          expect(imagegen?.source).toBe("builtin")
          expect(imagegen?.displayName).toBe("Image Gen")
          expect(imagegen?.location).toBe("builtin:imagegen")
        }),
      { git: true },
    ),
  )
})
