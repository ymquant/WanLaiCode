import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises"
import path from "path"
import { Addon } from "../../src/addon"
import { AddonMarketplace } from "../../src/addon/marketplace"
import { Config } from "../../src/config/config"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

async function writeMarketplace(root: string, name = "fixture-market") {
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true })
  await writeFile(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name,
      plugins: [
        {
          name: "hello",
          source: "./hello",
        },
      ],
    }),
  )
  await mkdir(path.join(root, "hello", ".codex-plugin"), { recursive: true })
  await writeFile(
    path.join(root, "hello", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", version: "0.1.0" }),
  )
}

function runMarketplace<A>(
  directory: string,
  effect: Effect.Effect<A, unknown, AddonMarketplace.Service | Config.Service | Addon.Service>,
  layer: Layer.Layer<AddonMarketplace.Service> = AddonMarketplace.layer,
) {
  return provideTestInstance({
    directory,
    fn: () =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(layer),
          Effect.provide(Layer.merge(Config.defaultLayer, Addon.defaultLayer)),
        ),
      ),
  })
}

test("add installs a local marketplace, writes config, and remove deletes both", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({ init: (dir) => writeMarketplace(dir) })

  await runMarketplace(
    project.path,
    AddonMarketplace.Service.use((svc) =>
      Effect.gen(function* () {
        const added = yield* svc.add(source.path, {})
        expect(added.name).toBe("fixture-market")
        const cfg = yield* Config.Service
        expect((yield* cfg.getGlobal()).marketplaces?.["fixture-market"]?.source_type).toBe("local")
        yield* svc.remove("fixture-market")
      }),
    ),
  )

  const config = JSON.parse(await readFile(path.join(process.env.XDG_CONFIG_HOME!, "wanlaicode", "wanlaicode.jsonc"), "utf8"))
  expect(config.marketplaces?.["fixture-market"]).toBeUndefined()
  await expect(stat(path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "marketplaces", "fixture-market"))).rejects.toThrow()
})

test("add rolls back the original marketplace when replacing fails", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({ init: (dir) => writeMarketplace(dir, "rollback-market") })
  let installedRenames = 0

  await runMarketplace(
    project.path,
    AddonMarketplace.Service.use((svc) =>
      Effect.gen(function* () {
        yield* svc.add(source.path, {})
        const root = path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "marketplaces", "rollback-market")
        yield* Effect.promise(() => writeFile(path.join(root, "keep.txt"), "original"))
        const exit = yield* Effect.exit(svc.add(source.path, {}))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Effect.promise(() => readFile(path.join(root, "keep.txt"), "utf8"))).toBe("original")
      }),
    ),
    AddonMarketplace.layerWithDeps({
      rename: async (from, to) => {
        const fromPath = String(from)
        const toPath = String(to)
        if (
          fromPath.includes(`${path.sep}.staging${path.sep}`) &&
          toPath.endsWith(`${path.sep}rollback-market`) &&
          installedRenames++ > 0
        ) {
          throw new Error("rename failed after backup")
        }
        return rename(from, to)
      },
    }),
  )
})

test("add rolls back the original marketplace when config write fails", async () => {
  await using project = await tmpdir()
  await using source = await tmpdir({ init: (dir) => writeMarketplace(dir, "config-rollback-market") })
  let configWrites = 0

  await runMarketplace(
    project.path,
    AddonMarketplace.Service.use((svc) =>
      Effect.gen(function* () {
        yield* svc.add(source.path, {})
        const root = path.join(process.env.XDG_DATA_HOME!, "wanlaicode", "marketplaces", "config-rollback-market")
        yield* Effect.promise(() => writeFile(path.join(root, "keep.txt"), "original"))
        const exit = yield* Effect.exit(svc.add(source.path, {}))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Effect.promise(() => readFile(path.join(root, "keep.txt"), "utf8"))).toBe("original")
      }),
    ),
    AddonMarketplace.layerWithDeps({
      updateGlobal: async (patch) => {
        if (configWrites++ > 0) throw new Error("config write failed")
        await Effect.runPromise(
          Config.Service.use((svc) => svc.updateGlobal(patch)).pipe(Effect.provide(Config.defaultLayer)),
        )
      },
    }),
  )
})
