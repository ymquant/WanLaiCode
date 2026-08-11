import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { clearAuthContentEnv } from "../preload"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  beforeEach(() => {
    clearAuthContentEnv()
  })

  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )

  it.live("concurrent set calls preserve credentials for different keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service

        // 多个并发写入都会改写整份 auth.json；文件锁必须保证不同 provider 不会互相覆盖。
        yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            auth.set(`provider-${index}`, {
              type: "api",
              key: `sk-${index}`,
            }),
          ),
          { concurrency: "unbounded" },
        )

        const data = yield* auth.all()
        expect(Object.keys(data).filter((key) => key.startsWith("provider-"))).toHaveLength(8)
        for (let index = 0; index < 8; index++) {
          const entry = data[`provider-${index}`]
          expect(entry?.type).toBe("api")
          if (entry?.type === "api") expect(entry.key).toBe(`sk-${index}`)
        }
      }),
    ),
  )

  it.live("modify serializes concurrent read-modify-write updates", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("counter", {
          type: "api",
          key: "sk-counter",
          metadata: { revision: "0" },
        })

        // 每个 updater 都必须在锁内看到上一轮结果，否则并发递增会发生丢失更新。
        yield* Effect.all(
          Array.from({ length: 6 }, () =>
            auth.modify!("counter", (current) => {
              if (current?.type !== "api") return undefined
              return {
                ...current,
                metadata: {
                  ...current.metadata,
                  revision: String(Number(current.metadata?.revision ?? "0") + 1),
                },
              }
            }),
          ),
          { concurrency: "unbounded" },
        )

        const current = yield* auth.get("counter")
        expect(current?.type).toBe("api")
        if (current?.type === "api") expect(current.metadata?.revision).toBe("6")
      }),
    ),
  )

  it.live("modify CAS does not overwrite a newer login", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("wanlaicode", {
          type: "oauth",
          refresh: "refresh-old",
          access: "runtime-old",
          expires: 1,
        })
        yield* auth.set("wanlaicode", {
          type: "oauth",
          refresh: "refresh-new-login",
          access: "runtime-new-login",
          expires: 2,
        })

        // 旧刷新请求只允许替换自己读取过的 refresh token；新登录已落盘时必须拒绝写入。
        const result = yield* auth.modify!("wanlaicode", (current) => {
          if (current?.type !== "oauth" || current.refresh !== "refresh-old") return undefined
          return {
            ...current,
            refresh: "refresh-stale-result",
            access: "runtime-stale-result",
          }
        })

        expect(result).toBeUndefined()
        const current = yield* auth.get("wanlaicode")
        expect(current?.type).toBe("oauth")
        if (current?.type === "oauth") {
          expect(current.refresh).toBe("refresh-new-login")
          expect(current.access).toBe("runtime-new-login")
        }
      }),
    ),
  )
})
