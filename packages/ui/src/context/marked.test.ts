import { describe, expect, test } from "bun:test"
import { marked } from "marked"
import hljs from "highlight.js"
import { bundledLanguages } from "shiki"
import {
  codeBlockLanguage,
  convertLatexDelimiters,
  createMarked,
  escapeCurrencyDollars,
  exceedsHighlightLimits,
  highlightCode,
  highlightCodeBlocks,
  isHttpMarkdownHref,
  isLocalMarkdownHref,
  localMarkdownHrefDisplay,
  MarkedProvider,
} from "./marked"

const shikiOnlyLanguage = Object.keys(bundledLanguages).find((lang) => !hljs.getLanguage(lang))

function initializeMarkedParser() {
  try {
    MarkedProvider({ children: undefined })
  } catch (error) {
    if (!(error instanceof ReferenceError) || error.message !== "React is not defined") throw error
  }
}

async function parseLink(markdown: string) {
  initializeMarkedParser()
  return marked.parse(markdown)
}

async function parseMarkdown(markdown: string) {
  return createMarked().parse(markdown)
}

describe("convertLatexDelimiters", () => {
  test("converts inline \\(...\\) to $...$", () => {
    expect(convertLatexDelimiters("欧拉恒等式 \\(e^{i\\pi} + 1 = 0\\)。")).toBe("欧拉恒等式 $e^{i\\pi} + 1 = 0$。")
  })

  test("converts block \\[...\\] to $$...$$", () => {
    expect(convertLatexDelimiters("\\[\\sum_{i=1}^{n} i\\]")).toBe("$$\\sum_{i=1}^{n} i$$")
  })

  test("leaves existing $...$ untouched", () => {
    expect(convertLatexDelimiters("$a^2 + b^2 = c^2$")).toBe("$a^2 + b^2 = c^2$")
  })

  test("skips fenced code blocks", () => {
    const input = "```js\nconst re = /\\(\\d+\\)/\n```"
    expect(convertLatexDelimiters(input)).toBe(input)
  })

  test("skips inline code", () => {
    const input = "正则 `\\(\\d+\\)` 匹配括号"
    expect(convertLatexDelimiters(input)).toBe(input)
  })

  test("converts delimiters outside code while preserving code inside same text", () => {
    const input = "公式 \\(x^2\\) 和代码 `\\(y\\)`"
    expect(convertLatexDelimiters(input)).toBe("公式 $x^2$ 和代码 `\\(y\\)`")
  })
})

describe("escapeCurrencyDollars", () => {
  test("escapes currency $amount followed by space/CJK/punct", () => {
    expect(escapeCurrencyDollars("花了 $5 买了 $10")).toBe("花了 \\$5 买了 \\$10")
    expect(escapeCurrencyDollars("价格 $1,000.50 元")).toBe("价格 \\$1,000.50 元")
    expect(escapeCurrencyDollars("成本 $5万")).toBe("成本 \\$5万")
  })

  test("leaves digit-led math untouched ($5x$, $2^n$)", () => {
    expect(escapeCurrencyDollars("变量 $5x$")).toBe("变量 $5x$")
    expect(escapeCurrencyDollars("指数 $2^n$")).toBe("指数 $2^n$")
  })

  test("does not touch $ followed by non-digit (normal math)", () => {
    expect(escapeCurrencyDollars("$a^2 + b^2 = c^2$")).toBe("$a^2 + b^2 = c^2$")
    expect(escapeCurrencyDollars("解 $x = 5$")).toBe("解 $x = 5$")
  })

  test("skips inside code", () => {
    expect(escapeCurrencyDollars("价格 `$5`")).toBe("价格 `$5`")
  })

  test("does not corrupt $$ block math that starts with a digit", () => {
    expect(escapeCurrencyDollars("$$5 = 2 + 3$$")).toBe("$$5 = 2 + 3$$")
    expect(escapeCurrencyDollars("$$3.14$$")).toBe("$$3.14$$")
  })

  test("does not touch a closing $ that precedes a digit ($x$5)", () => {
    expect(escapeCurrencyDollars("变量 $x$5个")).toBe("变量 $x$5个")
  })

  test("escapes currency after opening punctuation", () => {
    expect(escapeCurrencyDollars("(报价 $5)")).toBe("(报价 \\$5)")
  })
})

describe("markdown link href classification (integration)", () => {
  test("keeps HTTP and HTTPS hrefs as external links", async () => {
    await expect(parseLink("[http](http://example.com/page)")).resolves.toContain(
      '<a href="http://example.com/page" class="external-link" target="_blank" rel="noopener noreferrer">http</a>',
    )
    await expect(parseLink("[https](https://example.com/page)")).resolves.toContain(
      '<a href="https://example.com/page" class="external-link" target="_blank" rel="noopener noreferrer">https</a>',
    )
  })

  test("classifies Windows drive hrefs as file links", async () => {
    const html = await parseLink("[print_japan.py](C:/Users/developer/Documents/print_japan.py)")

    expect(html).toContain('class="markdown-pending-file-link"')
    expect(html).toContain('data-href="C:/Users/developer/Documents/print_japan.py"')
    expect(html).not.toContain('class="external-link"')
  })

  test("classifies backslash Windows hrefs as file links", async () => {
    const html = await parseLink("[print_japan.py](C:\\Users\\Admin\\Documents\\print_japan.py)")

    expect(html).toContain('class="markdown-pending-file-link"')
    expect(html).toContain('data-href="C:\\Users\\Admin\\Documents\\print_japan.py"')
    expect(html).not.toContain('class="external-link"')
  })

  test("classifies file URL hrefs as file links", async () => {
    const html = await parseLink("[print_japan.py](file:///C:/Users/developer/Documents/print_japan.py)")
    expect(html).toContain('data-href="C:/Users/developer/Documents/print_japan.py"')
    expect(html).not.toContain('/C:/Users/developer/Documents/print_japan.py')
    expect(html).toContain('class="markdown-pending-file-link"')
    expect(html).not.toMatch(/<a[^>]* href=/)
    expect(html).not.toContain('class="external-link"')
  })

  test("keeps Unix file URL hrefs rooted", async () => {
    const linux = await parseLink("[report.pdf](file:///home/developer/docs/report.pdf)")
    const mac = await parseLink("[main.ts](file:///Users/developer/Projects/app/main.ts)")

    expect(linux).toContain('data-href="/home/developer/docs/report.pdf"')
    expect(linux).not.toMatch(/<a[^>]* href=/)
    expect(mac).toContain('data-href="/Users/developer/Projects/app/main.ts"')
    expect(mac).not.toMatch(/<a[^>]* href=/)
  })
})

describe("markdown link href classification", () => {
  test("treats http links as external links", () => {
    expect(isHttpMarkdownHref("https://example.com/a.py")).toBe(true)
    expect(isHttpMarkdownHref("http://example.com/page")).toBe(true)
    expect(isLocalMarkdownHref("https://example.com/a.py")).toBe(false)
    expect(isLocalMarkdownHref("http://example.com/page")).toBe(false)
  })

  test("treats Windows absolute paths as local file hrefs", () => {
    expect(isHttpMarkdownHref("C:/Users/developer/Documents/print_japan.py")).toBe(false)
    expect(isLocalMarkdownHref("C:/Users/developer/Documents/print_japan.py")).toBe(true)
    expect(isLocalMarkdownHref("C:\\Users\\Admin\\Documents\\print_japan.py")).toBe(true)
    expect(isLocalMarkdownHref("D:\\Projects\\src\\main.ts")).toBe(true)
  })

  test("treats file URLs as local file hrefs", () => {
    expect(isHttpMarkdownHref("file:///C:/Users/developer/Documents/print_japan.py")).toBe(false)
    expect(isLocalMarkdownHref("file:///C:/Users/developer/Documents/print_japan.py")).toBe(true)
    expect(isHttpMarkdownHref("file:///etc/hosts")).toBe(false)
    expect(isLocalMarkdownHref("file:///etc/hosts")).toBe(true)
  })

  test("formats file URLs for local display without adding Windows slash", () => {
    expect(localMarkdownHrefDisplay("file:///C:/Users/developer/Documents/print_japan.py")).toBe(
      "C:/Users/developer/Documents/print_japan.py",
    )
    expect(localMarkdownHrefDisplay("file:///home/developer/docs/report.pdf")).toBe("/home/developer/docs/report.pdf")
    expect(localMarkdownHrefDisplay("file:///Users/developer/Projects/app/main.ts")).toBe(
      "/Users/developer/Projects/app/main.ts",
    )
  })

  test("treats absolute unix paths as local file hrefs", () => {
    expect(isHttpMarkdownHref("/home/developer/docs/report.pdf")).toBe(false)
    expect(isLocalMarkdownHref("/home/developer/docs/report.pdf")).toBe(true)
    expect(isHttpMarkdownHref("/etc/nginx/nginx.conf")).toBe(false)
    expect(isLocalMarkdownHref("/etc/nginx/nginx.conf")).toBe(true)
  })

  test("treats relative paths and anchors as neither http nor local", () => {
    expect(isHttpMarkdownHref("./relative/path")).toBe(false)
    expect(isLocalMarkdownHref("./relative/path")).toBe(false)
    expect(isHttpMarkdownHref("#section")).toBe(false)
    expect(isLocalMarkdownHref("#section")).toBe(false)
    expect(isHttpMarkdownHref("mailto:test@test.com")).toBe(false)
    expect(isLocalMarkdownHref("mailto:test@test.com")).toBe(false)
  })

  test("does not treat protocol-relative URLs as local file hrefs", () => {
    expect(isLocalMarkdownHref("//example.com/a.py")).toBe(false)
    expect(isLocalMarkdownHref("//cdn.example.com/assets/x")).toBe(false)
  })

  test("treats root-relative paths as local file hrefs (Unix-style absolute path tradeoff)", () => {
    expect(isLocalMarkdownHref("/docs/page")).toBe(true)
    expect(isLocalMarkdownHref("/api/foo")).toBe(true)
    expect(isLocalMarkdownHref("/home/developer/docs/report.pdf")).toBe(true)
  })
})

describe("codeBlockLanguage", () => {
  test("maps common aliases to canonical languages", () => {
    expect(codeBlockLanguage("ts")).toEqual({ requested: "ts", normalized: "typescript" })
    expect(codeBlockLanguage("python3")).toEqual({ requested: "python3", normalized: "python" })
    expect(codeBlockLanguage("shell")).toEqual({ requested: "shell", normalized: "bash" })
    expect(codeBlockLanguage("golang")).toEqual({ requested: "golang", normalized: "go" })
    expect(codeBlockLanguage("text")).toEqual({ requested: "text", normalized: "plaintext" })
    expect(codeBlockLanguage("yml")).toEqual({ requested: "yml", normalized: "yaml" })
    expect(codeBlockLanguage("docker")).toEqual({ requested: "docker", normalized: "dockerfile" })
  })

  test("does not mis-normalize canonical or unrelated languages", () => {
    expect(codeBlockLanguage("javascript")).toEqual({ requested: "javascript", normalized: "javascript" })
    expect(codeBlockLanguage("typescript")).toEqual({ requested: "typescript", normalized: "typescript" })
    expect(codeBlockLanguage("rust")).toEqual({ requested: "rust", normalized: "rust" })
    expect(codeBlockLanguage("not-a-real-language")).toEqual({
      requested: "not-a-real-language",
      normalized: "not-a-real-language",
    })
  })

  test("defaults missing language to plaintext", () => {
    expect(codeBlockLanguage()).toEqual({ requested: "plaintext", normalized: "plaintext" })
    expect(codeBlockLanguage("   ")).toEqual({ requested: "plaintext", normalized: "plaintext" })
  })

  test("uses only the first token from fenced info strings", () => {
    expect(codeBlockLanguage("ts title=foo")).toEqual({ requested: "ts", normalized: "typescript" })
    expect(codeBlockLanguage("python3,linenos")).toEqual({ requested: "python3", normalized: "python" })
  })
})

describe("exceedsHighlightLimits", () => {
  test("flags code exceeding total byte limit", () => {
    expect(exceedsHighlightLimits("a".repeat(512 * 1024 + 1))).toBe(true)
  })

  test("flags code exceeding line count limit", () => {
    expect(exceedsHighlightLimits(`${"x\n".repeat(10_000)}x`)).toBe(true)
  })

  test("flags code with a line exceeding per-line byte limit", () => {
    expect(exceedsHighlightLimits("a".repeat(4 * 1024 + 1))).toBe(true)
  })

  test("allows normal-sized code", () => {
    expect(exceedsHighlightLimits("const x = 1")).toBe(false)
    expect(exceedsHighlightLimits(Array.from({ length: 10_000 }, () => "x").join("\n"))).toBe(false)
    expect(exceedsHighlightLimits("a".repeat(4 * 1024))).toBe(false)

    const line = "a".repeat(1024)
    const codeNearTotalLimit = Array.from({ length: 500 }, () => line).join("\n")
    expect(exceedsHighlightLimits(codeNearTotalLimit)).toBe(false)
  })
})

describe("highlightCode behavior", () => {
  test("highlights hljs-supported languages with token classes", async () => {
    const html = await highlightCode("const keyword = 1", "javascript")

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="javascript"')
    expect(html).toMatch(/hljs-keyword/)
    expect(html).toContain("const")
  })

  test("alias normalization highlights with canonical grammar but keeps requested language", async () => {
    const aliased = await highlightCode("const keyword: number = 1", "ts")
    const canonical = await highlightCode("const keyword: number = 1", "typescript")

    expect(aliased).toContain('data-language="ts"')
    expect(canonical).toContain('data-language="typescript"')
    expect(aliased).toMatch(/hljs-keyword/)
    expect(canonical).toMatch(/hljs-keyword/)
    // Same tokenized body after the data-language attribute
    expect(aliased.replace('data-language="ts"', "")).toBe(canonical.replace('data-language="typescript"', ""))
  })

  test("falls back to shiki for bundled languages hljs does not support", async () => {
    if (!shikiOnlyLanguage) throw new Error("expected at least one shiki-only bundled language")

    const html = await highlightCode("fn main() {}", shikiOnlyLanguage)

    expect(html).toContain(`data-language="${shikiOnlyLanguage}"`)
    expect(html).not.toContain('class="hljs"')
    expect(html).toMatch(/class="[^"]*shiki/)
    expect(html).toContain("main")
  })

  test("downgrades oversized blocks to plaintext without syntax token classes", async () => {
    const oversizedLine = await highlightCode(`const keyword = 1\n${"a".repeat(4 * 1024 + 1)}`, "javascript")
    const oversizedLines = await highlightCode(`${"const keyword = 1\n".repeat(10_001)}`, "javascript")

    for (const html of [oversizedLine, oversizedLines]) {
      expect(html).toContain('class="hljs"')
      expect(html).toContain('data-language="javascript"')
      expect(html).not.toMatch(/hljs-keyword/)
      expect(html).toContain("const keyword = 1")
    }
  })

  test("downgrades unknown languages to plaintext without crashing", async () => {
    const html = await highlightCode("const keyword = 1", "not-a-real-language")

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="not-a-real-language"')
    expect(html).not.toMatch(/hljs-keyword/)
    expect(html).toContain("const keyword = 1")
  })
})

describe("highlightCodeBlocks native secondary highlighting", () => {
  test("re-highlights native parser code blocks", async () => {
    const html = await highlightCodeBlocks('<pre><code class="language-javascript">const keyword = 1</code></pre>')

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="javascript"')
    expect(html).toMatch(/hljs-keyword/)
  })

  test("decodes html entities before highlighting native parser code blocks", async () => {
    const html = await highlightCodeBlocks('<pre><code class="language-javascript">const x = 1 &lt; 2</code></pre>')

    expect(html).toContain('class="hljs"')
    expect(html).toContain("&lt;")
    expect(html).not.toContain("&amp;lt;")
  })

  test("applies alias, shiki fallback, and plaintext downgrade on native parser output", async () => {
    if (!shikiOnlyLanguage) throw new Error("expected at least one shiki-only bundled language")

    const aliased = await highlightCodeBlocks('<pre><code class="language-ts">const keyword = 1</code></pre>')
    expect(aliased).toContain('data-language="ts"')
    expect(aliased).toMatch(/hljs-keyword/)

    const shiki = await highlightCodeBlocks(
      `<pre><code class="language-${shikiOnlyLanguage}">fn main() {}</code></pre>`,
    )
    expect(shiki).toContain(`data-language="${shikiOnlyLanguage}"`)
    expect(shiki).not.toContain('class="hljs"')

    const unknown = await highlightCodeBlocks(
      '<pre><code class="language-not-a-real-language">const keyword = 1</code></pre>',
    )
    expect(unknown).toContain('data-language="not-a-real-language"')
    expect(unknown).not.toMatch(/hljs-keyword/)

    const oversized = await highlightCodeBlocks(
      `<pre><code class="language-javascript">${"a".repeat(4 * 1024 + 1)}</code></pre>`,
    )
    expect(oversized).toContain('data-language="javascript"')
    expect(oversized).not.toMatch(/hljs-keyword/)
  })

  test("leaves non-code html untouched", async () => {
    const input = '<p>hello</p><pre><code class="language-javascript">const x = 1</code></pre>'
    const html = await highlightCodeBlocks(input)

    expect(html).toContain("<p>hello</p>")
    expect(html).toContain('class="hljs"')
  })
})

describe("markdown code highlighting (js parser behavior)", () => {
  test("highlights fenced code blocks via hljs", async () => {
    const html = await parseMarkdown("```javascript\nconst keyword = 1\n```")

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="javascript"')
    expect(html).toMatch(/hljs-keyword/)
  })

  test("preserves requested alias and highlights with normalized grammar", async () => {
    const html = await parseMarkdown("```ts\nconst keyword: number = 1\n```")

    expect(html).toContain('data-language="ts"')
    expect(html).toMatch(/hljs-keyword/)
    expect(html).not.toContain('data-language="typescript"')
  })

  test("falls back to shiki for bundled languages hljs does not support", async () => {
    if (!shikiOnlyLanguage) throw new Error("expected at least one shiki-only bundled language")

    const html = await parseMarkdown(`\`\`\`${shikiOnlyLanguage}\nfn main() {}\n\`\`\``)

    expect(html).toContain(`data-language="${shikiOnlyLanguage}"`)
    expect(html).not.toContain('class="hljs"')
    expect(html).toMatch(/class="[^"]*shiki/)
  })

  test("downgrades oversized fenced blocks to plaintext stably", async () => {
    const html = await parseMarkdown(`\`\`\`javascript\nconst keyword = 1\n${"a".repeat(4 * 1024 + 1)}\n\`\`\``)

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="javascript"')
    expect(html).not.toMatch(/hljs-keyword/)
    expect(html).toContain("const keyword = 1")
  })

  test("downgrades unknown fenced languages to plaintext without crashing", async () => {
    const html = await parseMarkdown("```not-a-real-language\nconst keyword = 1\n```")

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="not-a-real-language"')
    expect(html).not.toMatch(/hljs-keyword/)
    expect(html).toContain("const keyword = 1")
  })
})

describe("nativeParser closed-loop behavior", () => {
  test("runs math first then secondary-highlights code blocks", async () => {
    const parser = createMarked({
      async nativeParser() {
        return [
          "<p>result $1+1$</p>",
          '<pre><code class="language-javascript">const keyword = 1</code></pre>',
        ].join("")
      },
    })

    const html = await parser.parse("ignored markdown")

    expect(html).toContain("katex")
    expect(html).not.toContain("$1+1$")
    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="javascript"')
    expect(html).toMatch(/hljs-keyword/)
  })

  test("does not highlight math that appears inside code blocks", async () => {
    const parser = createMarked({
      async nativeParser() {
        return '<pre><code class="language-javascript">const price = "$5"</code></pre>'
      },
    })

    const html = await parser.parse("ignored")

    expect(html).not.toContain("katex")
    expect(html).toContain('class="hljs"')
    expect(html).toContain("$5")
  })

  test("applies alias highlighting on native parser output", async () => {
    const parser = createMarked({
      async nativeParser() {
        return '<pre><code class="language-ts">const keyword: number = 1</code></pre>'
      },
    })

    const html = await parser.parse("ignored")

    expect(html).toContain('data-language="ts"')
    expect(html).toMatch(/hljs-keyword/)
  })

  test("falls back to shiki on native parser output for shiki-only languages", async () => {
    if (!shikiOnlyLanguage) throw new Error("expected at least one shiki-only bundled language")

    const parser = createMarked({
      async nativeParser() {
        return `<pre><code class="language-${shikiOnlyLanguage}">fn main() {}</code></pre>`
      },
    })

    const html = await parser.parse("ignored")

    expect(html).toContain(`data-language="${shikiOnlyLanguage}"`)
    expect(html).not.toContain('class="hljs"')
    expect(html).toMatch(/class="[^"]*shiki/)
  })

  test("downgrades oversized native parser code blocks to plaintext", async () => {
    const parser = createMarked({
      async nativeParser() {
        return `<pre><code class="language-javascript">const keyword = 1\n${"a".repeat(4 * 1024 + 1)}</code></pre>`
      },
    })

    const html = await parser.parse("ignored")

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="javascript"')
    expect(html).not.toMatch(/hljs-keyword/)
    expect(html).toContain("const keyword = 1")
  })

  test("downgrades unknown native parser languages to plaintext", async () => {
    const parser = createMarked({
      async nativeParser() {
        return '<pre><code class="language-not-a-real-language">const keyword = 1</code></pre>'
      },
    })

    const html = await parser.parse("ignored")

    expect(html).toContain('class="hljs"')
    expect(html).toContain('data-language="not-a-real-language"')
    expect(html).not.toMatch(/hljs-keyword/)
    expect(html).toContain("const keyword = 1")
  })
})
