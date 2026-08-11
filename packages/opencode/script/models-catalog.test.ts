import { describe, expect, test } from "bun:test"

import {
  classifyStaleness,
  MIN_PROVIDERS,
  parseCatalog,
  REFRESH_HINT,
  resolveReleaseChannel,
  serializeCatalog,
  staleness,
  STALE_FAIL_DAYS,
  STALE_WARN_DAYS,
} from "./models-catalog"

function fakeCatalog(count: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const map: Record<string, unknown> = { anthropic: { id: "anthropic" }, openai: { id: "openai" }, ...extra }
  for (let i = 0; map && Object.keys(map).length < count; i++) map[`filler-${i}`] = { id: `filler-${i}` }
  return map
}

describe("parseCatalog 放行合法目录", () => {
  test("provider 数达标且含必备 provider", () => {
    const raw = JSON.stringify(fakeCatalog(MIN_PROVIDERS))
    expect(Object.keys(parseCatalog(raw, "test")).length).toBe(MIN_PROVIDERS)
  })
})

describe("parseCatalog 拦截坏数据", () => {
  test("整页 HTML 错误页（models.dev 对未知路径返回 200+HTML，只判状态码拦不住）", () => {
    expect(() => parseCatalog("<!doctype html><html>...", "test")).toThrow(/不是合法 JSON/)
  })

  test("被网络截断的残缺 JSON", () => {
    const raw = JSON.stringify(fakeCatalog(MIN_PROVIDERS)).slice(0, 500)
    expect(() => parseCatalog(raw, "test")).toThrow(/不是合法 JSON/)
  })

  // typeof [] === "object"，不显式排除会被当成合法 provider map 放行
  test("顶层是数组", () => {
    expect(() => parseCatalog(JSON.stringify([1, 2, 3]), "test")).toThrow(/顶层不是对象/)
  })

  test("顶层是 null", () => {
    expect(() => parseCatalog("null", "test")).toThrow(/顶层不是对象/)
  })

  test("provider 数量不足（语法合法但内容残缺）", () => {
    expect(() => parseCatalog(JSON.stringify(fakeCatalog(10)), "test")).toThrow(/少于阈值/)
  })

  test("缺少必备 provider（数量仍达标，隔离出这一个条件）", () => {
    const map = fakeCatalog(MIN_PROVIDERS + 1)
    delete map.anthropic
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(MIN_PROVIDERS)
    expect(() => parseCatalog(JSON.stringify(map), "test")).toThrow(/缺少必备 provider/)
  })

  test("报错带上数据来源，便于分辨是哪一路出问题", () => {
    expect(() => parseCatalog("{}", "src/provider/models-pinned.json")).toThrow(/models-pinned\.json/)
  })
})

describe("serializeCatalog", () => {
  const map = { zeta: { a: 1 }, alpha: { b: 2 }, mid: { c: 3 } }

  test("顶层 key 按字典序排序（保证刷新 diff 稳定）", () => {
    const lines = serializeCatalog(map).trim().split("\n")
    expect(lines[1]).toContain('"alpha"')
    expect(lines[2]).toContain('"mid"')
    expect(lines[3]).toContain('"zeta"')
  })

  test("每个 provider 独占一行（diff 精确到 provider 而非整体重写）", () => {
    // 首尾两行是大括号，中间每行一个 provider
    expect(serializeCatalog(map).trim().split("\n").length).toBe(Object.keys(map).length + 2)
  })

  test("往返一致：序列化结果能被 JSON.parse 还原", () => {
    expect(JSON.parse(serializeCatalog(map))).toEqual(map)
  })

  test("key 含特殊字符时仍是合法 JSON", () => {
    const tricky = { 'a"b': { x: 1 }, "c\\d": { y: 2 }, "e\nf": { z: 3 } }
    expect(JSON.parse(serializeCatalog(tricky))).toEqual(tricky)
  })
})

describe("resolveReleaseChannel", () => {
  // 这组用例固化一个真实踩过的坑：publish.yml 的 B-pure 设计会在 canary 发版时
  // 把 WANLAICODE_CHANNEL 改写成 "prod"，直接读它会让 canary 被模型目录的
  // 90 天硬失败误伤。上一版正是因为手工验证时直接设 CHANNEL=canary、绕过了
  // workflow 真实的 env 传递链，才没测出来。
  test("canary 发版：CHANNEL 被 B-pure 改写成 prod，仍应识别为 canary", () => {
    expect(resolveReleaseChannel({ WANLAICODE_CHANNEL: "prod", WANLAICODE_DISPATCH_CHANNEL: "canary" })).toBe("canary")
  })

  test("正式发版：两者都是 prod", () => {
    expect(resolveReleaseChannel({ WANLAICODE_CHANNEL: "prod", WANLAICODE_DISPATCH_CHANNEL: "prod" })).toBe("prod")
  })

  test("beta 发版", () => {
    expect(resolveReleaseChannel({ WANLAICODE_CHANNEL: "beta", WANLAICODE_DISPATCH_CHANNEL: "beta" })).toBe("beta")
  })

  // publish-subbrand.yml 不传 DISPATCH，且固定走 prod —— 子品牌发布是正式发版，该拦
  test("未传 DISPATCH 时回落 WANLAICODE_CHANNEL", () => {
    expect(resolveReleaseChannel({ WANLAICODE_CHANNEL: "prod" })).toBe("prod")
  })

  test("再回落上游的 OPENCODE_CHANNEL", () => {
    expect(resolveReleaseChannel({ OPENCODE_CHANNEL: "dev" })).toBe("dev")
  })

  test("都没有时返回 undefined（本地开发，不触发硬失败）", () => {
    expect(resolveReleaseChannel({})).toBeUndefined()
  })
})

describe("staleness", () => {
  const now = Date.parse("2026-07-29T00:00:00Z")

  test("正常时间戳算出天数", () => {
    const r = staleness("2026-07-19T00:00:00Z", now)
    expect(r).toEqual({ known: true, days: 10 })
  })

  // 关键：Date.parse 失败得到 NaN，而 NaN >= 阈值恒为 false。
  // 若直接拿去比较，元数据一坏陈旧检查就恰好失效，比没有检查更危险。
  test("非法时间戳返回 known:false 而不是当成未过期", () => {
    const r = staleness("not-a-date", now)
    expect(r.known).toBe(false)
  })

  test.each([undefined, null, "", "   ", 12345, {}])("非字符串/空值 %p 返回 known:false", (v) => {
    expect(staleness(v, now).known).toBe(false)
  })

  test("未来时间戳得到负天数（不会被误判为陈旧）", () => {
    const r = staleness("2026-08-29T00:00:00Z", now)
    expect(r.known && r.days < 0).toBe(true)
  })
})

// 构建期（generate.ts）与转正期（check-models-stale.ts）必须共用同一套阈值判定，
// 否则 canary 构建时放行的目录到了 promote 又换一把尺子（或反过来）。
describe("classifyStaleness 三档判定", () => {
  const now = Date.parse("2026-07-29T00:00:00Z")
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString()

  test("新鲜目录归 ok", () => {
    expect(classifyStaleness(daysAgo(1), now).level).toBe("ok")
  })

  test.each([STALE_WARN_DAYS, STALE_WARN_DAYS + 1, STALE_FAIL_DAYS - 1])("%p 天归 warn", (n) => {
    expect(classifyStaleness(daysAgo(n), now).level).toBe("warn")
  })

  test.each([STALE_FAIL_DAYS, STALE_FAIL_DAYS + 1])("%p 天归 fail", (n) => {
    expect(classifyStaleness(daysAgo(n), now).level).toBe("fail")
  })

  test("边界含等号：恰好 WARN/FAIL 天数就要升档", () => {
    expect(classifyStaleness(daysAgo(STALE_WARN_DAYS - 1), now).level).toBe("ok")
    expect(classifyStaleness(daysAgo(STALE_FAIL_DAYS - 1), now).level).toBe("warn")
  })

  // 无法判断时既不能当"没过期"放行，也不该拿一个连日期都读不出来的元数据硬拦发版。
  test.each([undefined, "not-a-date", "", 12345])("无法判断的 fetchedAt %p 归 warn 并带原因", (v) => {
    const r = classifyStaleness(v, now)
    expect(r.level).toBe("warn")
    expect(r.reason).toBeTruthy()
  })
})

describe("REFRESH_HINT 自救指引", () => {
  // 办公室直连与内网代理都到不了 models.dev，只说"跑刷新脚本"会让操作者原地复现同一故障；
  // 命令必须是从仓库根可执行的路径（仓库根另有一个不相关的 script/ 目录）。
  test("给出从仓库根可执行的完整路径", () => {
    expect(REFRESH_HINT).toContain("bun packages/opencode/script/refresh-models-pinned.ts")
    expect(REFRESH_HINT).not.toMatch(/(^|\s)bun script\/refresh-models-pinned\.ts/)
  })

  test("给出离线取数通路与一个已知可出网的机器", () => {
    expect(REFRESH_HINT).toContain("--from")
    expect(REFRESH_HINT).toContain("curl")
    expect(REFRESH_HINT).toContain("生产服务器")
  })
})
