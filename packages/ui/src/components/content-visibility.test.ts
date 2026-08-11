import { describe, expect, test } from "bun:test"

// content-visibility: auto 不配 contain-intrinsic-size，离屏元素高度会按 0 计算。
// 用户向上滚动阅读时，上方元素逐个进入视口恢复真实高度，上方总高度持续增加，
// 视口相对内容不断下滑 —— 表现为「乱跳」。
//
// 覆盖范围仅 packages/ui 与 packages/app 的 src（桌面端聊天消息流由这两个包构成），
// 且只认 content-visibility: auto。以下不在覆盖内，改这些地方时需人工留意：
//   - packages/web 是另一套独立的分享页渲染，不依赖 @opencode-ai/ui
//   - packages/enterprise 复用 SessionTurn，但自身的 tsx/css 未纳入扫描
//   - ui 的 tailwind bundle 以整个 packages/ 为 source，别的包写 [content-visibility:auto]
//     任意值类同样会产出真实 CSS，扫不到
//   - content-visibility: hidden（恒定跳过，更需要尺寸提示）
// TSX 里存在内联 style 与 Tailwind 任意值两种写法，仅扫 CSS 会漏，故一并扫 ts/tsx。
// 虚拟化在内外两层各有一处：外层 wrapper 在 timeline-turn-anchor.tsx 用内联 style，
// 内层 [data-component="session-turn"] 在 message-part.css 用选择器。两处必须同时豁免
// 「最新一轮」—— 回合结束时 data-active 翻成 false，浏览器此刻没有该属性下的
// last remembered size，只能取估值，一轮真实高度可达数千 px，会当场塌陷把视口顶走。
// 曾只改了外层、漏掉内层，导致回合结束仍然跳。
describe("latest turn virtualization exemption", () => {
  test("both layers exempt the latest turn", async () => {
    const css = await Bun.file(new URL("./message-part.css", import.meta.url)).text()
    const turn = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const anchor = await Bun.file(
      new URL("../../../app/src/pages/session/timeline-turn-anchor.tsx", import.meta.url),
    ).text()

    // 内层：选择器必须同时排除 active 与 latest
    expect(css).toContain(
      '[data-component="session-turn"]:not([data-active="true"]):not([data-latest="true"])',
    )
    // 内层依赖这个标记，必须真的渲染出来
    expect(turn).toContain('data-latest={props.isLatestUserTurn ? "true" : undefined}')
    // 外层
    expect(anchor).toContain('"content-visibility": props.active || props.latest ? undefined : "auto"')
  })
})

// 声明写法容错：属性名与值之间可以有任意空白（含换行），值也可能是 auto 之外的关键字。
const CSS_DECLARATION = /content-visibility\s*:\s*auto/gi
// TSX 里有三种写法：formatted "content-visibility": …、contentVisibility: …、
// Tailwind 任意值 [content-visibility:…]，以及 setProperty("content-visibility", …)。
const TSX_DECLARATION = /["'[]content-visibility["']?\s*[:,]|contentVisibility\s*[:=]/

// 注释里出现同名字串不算声明，先整体剥掉再扫，避免误报/漏报都依赖注释的位置。
const stripCssComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/\S/g, " "))
const stripJsComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/\S/g, " "))

// 取声明所在的那一层规则块。CSS 嵌套下不能简单用最近的 { 和 }：
// 声明之前可能已经闭合过若干子规则，向前扫描时要把它们跳过。
const enclosingBlock = (text: string, at: number) => {
  let depth = 0
  let start = -1
  for (let i = at; i >= 0; i--) {
    const ch = text[i]
    if (ch === "}") depth++
    else if (ch === "{") {
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
  }
  if (start === -1) return undefined

  // 只保留本层的声明：嵌套子规则里的 contain-intrinsic-size 属于子元素，
  // 不能算作本层的配对。
  let own = ""
  depth = 0
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{") {
      depth++
      continue
    }
    if (ch === "}") {
      if (depth === 0) break
      depth--
      continue
    }
    if (depth === 0) own += ch
  }
  return own
}

// 配对声明在 CSS 里是 contain-intrinsic-size，在 JS 内联 style 里可能写成
// containIntrinsicSize；大小写也不该影响判定。
const hasPairing = (text: string) => /contain-intrinsic-size|containIntrinsicSize/i.test(text)

// 返回违规声明所在的行号（1 起）。抽成纯函数是为了能用合成输入验证解析边界本身 ——
// 扫描器若发生假阴性，仓库扫描仍会全绿，缺陷会被静默放过。
export const cssOffenderLines = (text: string) => {
  const source = stripCssComments(text)
  return [...source.matchAll(CSS_DECLARATION)].flatMap((match) => {
    const block = enclosingBlock(source, match.index)
    // 找不到所属规则块（顶层声明、括号不配对）时按违规处理：回退成整个文件会让
    // 文件里别处的 contain-intrinsic-size 把它掩盖掉。
    if (block && hasPairing(block)) return []
    return [source.slice(0, match.index).split("\n").length]
  })
}

export const tsxOffenderLines = (text: string) => {
  const lines = stripJsComments(text).split("\n")
  return lines.flatMap((line, i) => {
    if (!TSX_DECLARATION.test(line)) return []
    // 同一元素的配对声明必然出现在附近；按行窗口判定即可。
    const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n")
    if (hasPairing(window)) return []
    return [i + 1]
  })
}

describe("content-visibility", () => {
  const packages = ["ui", "app"]
  const roots = packages.map((name) => Bun.fileURLToPath(new URL(`../../../${name}/src/`, import.meta.url)))

  // 两个包合计 600+ 个文件。逐个 await 读取时，Windows runner 的单次 IO 开销累积起来
  // 会撞上 5s 默认超时（本地 ~130ms，CI linux 已到 4s）。并行读取把总耗时压回一次 IO 量级。
  const collect = async (extensions: string[]) => {
    const paths: string[] = []
    for (const root of roots) {
      for (const extension of extensions) {
        for (const relative of new Bun.Glob(`**/*.${extension}`).scanSync(root)) {
          if (relative.includes(".test.")) continue
          paths.push(`${root}${relative}`)
        }
      }
    }
    return Promise.all(paths.map(async (file) => ({ file, text: await Bun.file(file).text() })))
  }

  // 并行后仍显式放宽超时：这两条是全量磁盘扫描，耗时随仓库规模和 runner 负载增长，
  // 不该因为机器慢就红。合成用例（下面 describe）才是判定逻辑的回归保护。
  const SCAN_TIMEOUT_MS = 30_000

  test("every content-visibility: auto in CSS declares contain-intrinsic-size", async () => {
    const files = await collect(["css"])
    expect(files.length).toBeGreaterThan(0)

    const offenders = files.flatMap(({ file, text }) => cssOffenderLines(text).map((line) => `${file}:${line}`))

    expect(offenders).toEqual([])
  }, SCAN_TIMEOUT_MS)

  test("every content-visibility in TS/TSX pairs with contain-intrinsic-size", async () => {
    // 内联 style 与 setProperty 两种写法常落在 .ts 里，只扫 .tsx 会漏。
    const files = await collect(["tsx", "ts"])
    expect(files.length).toBeGreaterThan(0)

    const offenders = files.flatMap(({ file, text }) => tsxOffenderLines(text).map((line) => `${file}:${line}`))

    expect(offenders).toEqual([])
  }, SCAN_TIMEOUT_MS)
})

// 扫描器自身的解析边界。没有这些用例时，扫描器一旦发生假阴性，上面两个仓库扫描
// 仍会全绿，缺陷被静默放过 —— 守卫失效比没有守卫更危险。
describe("content-visibility scanner", () => {
  const css = (text: string) => cssOffenderLines(text)

  test("flags declarations regardless of whitespace", () => {
    expect(css(".a { content-visibility:auto; }")).toEqual([1])
    expect(css(".a {\n  content-visibility  :\n  auto;\n}")).toEqual([2])
  })

  test("is case-insensitive on both the declaration and its pairing", () => {
    expect(css(".a { CONTENT-VISIBILITY: AUTO; }")).toEqual([1])
    expect(css(".a { content-visibility: auto; CONTAIN-INTRINSIC-SIZE: auto 1px; }")).toEqual([])
  })

  test("does not let a nested rule's pairing cover the parent", () => {
    // 子规则里的 contain-intrinsic-size 属于子元素，不能算父规则配对上了。
    expect(css(".a { &:hover { contain-intrinsic-size: auto 10px; } content-visibility: auto; }")).toEqual([1])
    // 反过来，父层配对、子层声明也要各算各的。
    expect(css(".a { contain-intrinsic-size: auto 10px; &:hover { content-visibility: auto; } }")).toEqual([1])
  })

  test("looks inside at-rules", () => {
    expect(css("@media (min-width: 100px) {\n  .a {\n    content-visibility: auto;\n  }\n}")).toEqual([3])
    expect(
      css("@media (min-width: 100px) {\n  .a {\n    content-visibility: auto;\n    contain-intrinsic-size: auto 1px;\n  }\n}"),
    ).toEqual([])
  })

  test("treats a declaration with no enclosing rule as an offender", () => {
    // 顶层或括号不配对时不能回退到整个文件，否则别处的配对会把它掩盖掉。
    expect(css("content-visibility: auto;\n.a { contain-intrinsic-size: auto 1px; }")).toEqual([1])
  })

  test("ignores comments without hiding real declarations behind them", () => {
    expect(css("/* content-visibility: auto */\n.a { content-visibility: auto; }")).toEqual([2])
    expect(css("/* content-visibility: auto */\n.a { content-visibility: auto; contain-intrinsic-size: auto 1px; }")).toEqual(
      [],
    )
  })

  test("accepts a correctly paired declaration", () => {
    expect(css(".a {\n  content-visibility: auto;\n  contain-intrinsic-size: auto 200px;\n}")).toEqual([])
  })

  test("handles three levels of nesting", () => {
    expect(css(".a { .b { .c { content-visibility: auto; } } }")).toEqual([1])
    expect(css(".a { .b { .c { content-visibility: auto; contain-intrinsic-size: auto 1px; } } }")).toEqual([])
  })

  const tsx = (text: string) => tsxOffenderLines(text)

  test("covers the three TS/TSX spellings", () => {
    expect(tsx('style={{ "content-visibility": "auto" }}')).toEqual([1])
    expect(tsx('el.style.contentVisibility = "auto"')).toEqual([1])
    expect(tsx('el.style.setProperty("content-visibility", "auto")')).toEqual([1])
    expect(tsx('class="[content-visibility:auto]"')).toEqual([1])
  })

  test("accepts either spelling of the pairing", () => {
    expect(tsx('style={{ "content-visibility": "auto", "contain-intrinsic-size": "auto 1px" }}')).toEqual([])
    expect(tsx('el.style.contentVisibility = "auto"\nel.style.containIntrinsicSize = "auto 1px"')).toEqual([])
  })

  test("ignores commented-out declarations", () => {
    expect(tsx('// style={{ "content-visibility": "auto" }}')).toEqual([])
    expect(tsx('/* style={{ "content-visibility": "auto" }} */')).toEqual([])
  })
})
