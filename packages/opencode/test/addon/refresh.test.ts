import { expect, test, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdir, writeFile, rm } from "fs/promises"
import path from "path"
import { Addon } from "../../src/addon"
import { AddonMarketplace } from "../../src/addon/marketplace"
import { Config } from "../../src/config/config"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

function runWithServices<A>(
  directory: string,
  effect: Effect.Effect<A, unknown, AddonMarketplace.Service | Config.Service | Addon.Service>,
) {
  return provideTestInstance({
    directory,
    fn: () =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(AddonMarketplace.layer),
          Effect.provide(Layer.merge(Config.defaultLayer, Addon.defaultLayer)),
        ),
      ),
  })
}

test("invalidate makes getAvailableAddons rediscover plugins written out-of-band", async () => {
  await using project = await tmpdir()

  // Global.Path.data == <XDG_DATA_HOME>/wanlaicode(见 packages/core/src/global.ts);
  // 后端 state init 会自动加载 <data>/personal 下的 marketplace。
  const personalRoot = path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "personal")
  const marketplaceJson = path.join(personalRoot, ".agents", "plugins", "marketplace.json")

  // 写 personal marketplace 含给定插件列表 + 各自的 plugin.json。
  const writeManifest = async (names: string[]) => {
    await mkdir(path.join(personalRoot, ".agents", "plugins"), { recursive: true })
    await writeFile(
      marketplaceJson,
      JSON.stringify({
        name: "personal",
        plugins: names.map((n) => ({ name: n, source: `./${n}`, policy: { installation: "AVAILABLE" } })),
      }),
    )
    for (const n of names) {
      await mkdir(path.join(personalRoot, n, ".codex-plugin"), { recursive: true })
      await writeFile(
        path.join(personalRoot, n, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: n, version: "0.1.0" }),
      )
    }
  }

  await writeManifest(["plugin-a"])

  try {
    await runWithServices(
      project.path,
      Effect.gen(function* () {
        const addon = yield* Addon.Service

        // 预热缓存:看到 a,看不到 b
        const before = yield* addon.getAvailableAddons()
        expect(before.some((x) => x.name === "plugin-a")).toBe(true)
        expect(before.some((x) => x.name === "plugin-b")).toBe(false)

        // 模拟对话 plugin-creator 直接写盘新增 plugin-b
        yield* Effect.promise(() => writeManifest(["plugin-a", "plugin-b"]))

        // 缓存仍命中:看不到 b(这正是 bug 现象)
        const cached = yield* addon.getAvailableAddons()
        expect(cached.some((x) => x.name === "plugin-b")).toBe(false)

        // refresh 端点底层即此调用
        yield* addon.invalidate()

        // 失效后重扫:看到 b
        const after = yield* addon.getAvailableAddons()
        expect(after.some((x) => x.name === "plugin-b")).toBe(true)
      }),
    )
  } finally {
    // 自动加载的 personal marketplace 会残留并污染同进程其它用例,务必清理。
    await rm(personalRoot, { recursive: true, force: true })
  }
})
