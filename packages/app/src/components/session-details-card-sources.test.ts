import { describe, expect, test } from "bun:test"
import {
  descendantSessionIDs,
  finalizeSessionOutputArtifacts,
  formatOutputArtifactDisplayPath,
  isDisplayableWebSourceUrl,
  isSessionGeneratedArtifactPath,
  isSessionOutputArtifactPath,
  normalizeFilePath,
  normalizeOutputArtifactKey,
  normalizeWebSourceUrl,
  orderOutputArtifactsLatestFirst,
  outputArtifactExtension,
  outputArtifactsFromParts,
  recordSessionOutputArtifact,
  removeSessionOutputArtifact,
  sessionHasWebSearch,
  sessionWebSourceUrls,
  sessionsHaveWebAccess,
  sessionsWebSourceUrls,
  shellOutputFileEventsFromParts,
  urlsFromText,
  uniquePreserveOrder,
  uniquePreserveOrderLatestFirst,
} from "./session-details-card-sources"

describe("session-details-card-sources", () => {
  test("detects websearch tool usage in session parts", () => {
    expect(
      sessionHasWebSearch(
        [{ id: "m1", sessionID: "ses_1" } as never],
        {
          m1: [{ type: "tool", tool: "websearch", sessionID: "ses_1" } as never],
        },
      ),
    ).toBe(true)
  })

  test("detects webfetch tool usage", () => {
    expect(
      sessionsHaveWebAccess(
        new Set(["ses_1"]),
        { ses_1: [{ id: "m1" } as never] },
        {
          m1: [{ type: "tool", tool: "webfetch", sessionID: "ses_1" } as never],
        },
      ),
    ).toBe(true)
  })

  test("detects provider-native web_search tool calls", () => {
    expect(
      sessionsHaveWebAccess(
        new Set(["ses_1"]),
        { ses_1: [{ id: "m1" } as never] },
        {
          m1: [{ type: "tool", tool: "web_search", sessionID: "ses_1" } as never],
        },
      ),
    ).toBe(true)
  })

  test("includes child session tool calls", () => {
    expect(
      sessionsHaveWebAccess(
        new Set(["ses_root", "ses_child"]),
        { ses_child: [{ id: "m1" } as never] },
        {
          m1: [{ type: "tool", tool: "websearch", sessionID: "ses_child" } as never],
        },
      ),
    ).toBe(true)
  })

  test("includes nested descendant session tool calls", () => {
    expect(
      sessionsHaveWebAccess(
        descendantSessionIDs("ses_root", [
          { id: "ses_root" },
          { id: "ses_child", parentID: "ses_root" },
          { id: "ses_grand", parentID: "ses_child" },
        ]),
        { ses_grand: [{ id: "m1" } as never] },
        {
          m1: [{ type: "tool", tool: "websearch", sessionID: "ses_grand" } as never],
        },
      ),
    ).toBe(true)
  })

  test("ignores sessions outside tracked session tree", () => {
    expect(
      sessionsHaveWebAccess(
        new Set(["ses_1"]),
        { ses_other: [{ id: "m2" } as never] },
        {
          m2: [{ type: "tool", tool: "websearch", sessionID: "ses_other" } as never],
        },
      ),
    ).toBe(false)
  })

  test("does not scan parts for messages outside tracked sessions", () => {
    expect(
      sessionsHaveWebAccess(
        new Set(["ses_1"]),
        { ses_1: [{ id: "m1" } as never] },
        {
          m1: [{ type: "tool", tool: "read", sessionID: "ses_1" } as never],
          m2: [{ type: "tool", tool: "websearch", sessionID: "ses_other" } as never],
        },
      ),
    ).toBe(false)
  })

  test("returns false when session has no web access tool calls", () => {
    expect(
      sessionHasWebSearch(
        [{ id: "m1", sessionID: "ses_1" } as never],
        {
          m1: [{ type: "tool", tool: "read", sessionID: "ses_1" } as never],
        },
      ),
    ).toBe(false)
    expect(sessionHasWebSearch([], {})).toBe(false)
  })

  test("extracts webfetch url from tool input", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", sessionID: "ses_1" } as never], {
        m1: [
          {
            type: "tool",
            tool: "webfetch",
            sessionID: "ses_1",
            state: { status: "completed", input: { url: "https://example.com/docs" }, output: "" },
          } as never,
        ],
      }),
    ).toEqual(["https://example.com/docs"])
  })

  test("extracts urls from websearch output text", () => {
    expect(
      sessionsWebSourceUrls(
        new Set(["ses_1"]),
        { ses_1: [{ id: "m1" } as never] },
        {
          m1: [
            {
              type: "tool",
              tool: "websearch",
              sessionID: "ses_1",
              state: {
                status: "completed",
                input: { query: "test" },
                output: "https://a.example.com\nhttps://b.example.com/page",
              },
            } as never,
          ],
        },
      ),
    ).toEqual(["https://a.example.com"])
  })

  test("rejects office xml namespace urls", () => {
    expect(isDisplayableWebSourceUrl("http://schemas.openxmlformats.org/spreadsheetml/2006/main")).toBe(false)
    expect(isDisplayableWebSourceUrl("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")).toBe(true)
  })

  test("rejects loopback and private network urls", () => {
    expect(isDisplayableWebSourceUrl("http://localhost:4096/docs")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://127.0.0.2/api")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://[::1]:8080/")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://10.0.0.5/internal")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://192.168.1.10/status")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://172.16.0.1/")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://169.254.169.254/latest/meta-data/")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://2130706433/")).toBe(false)
    expect(isDisplayableWebSourceUrl("http://[::ffff:7f00:1]/")).toBe(false)
  })

  test("websearch output ignores inline schema mentions", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "websearch",
            state: {
              status: "completed",
              input: { query: "xlsx format" },
              output:
                "Uses http://schemas.openxmlformats.org/spreadsheetml/2006/main in file XML\nhttps://example.com/article",
            },
          } as never,
        ],
      }),
    ).toEqual(["https://example.com/article"])
  })

  test("extracts urls from bash curl commands", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: 'curl -s "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"' },
              output: '{"symbol":"BTCUSDT","price":"50000.00"}',
            },
          } as never,
        ],
      }),
    ).toEqual(["https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"])
  })

  test("extracts urls from powershell invoke-restmethod commands", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: {
                command:
                  'Invoke-RestMethod "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" | ConvertTo-Json',
              },
              output: '{"symbol":"BTCUSDT","price":"61724.27"}',
            },
          } as never,
        ],
      }),
    ).toEqual(["https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"])
  })

  test("extracts urls from python one-liner http requests", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: {
                command:
                  "python -c \"import json,urllib.request; print(json.load(urllib.request.urlopen('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT')))\"",
              },
              output: "{'symbol': 'BTCUSDT'}",
            },
          } as never,
        ],
      }),
    ).toEqual(["https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"])
  })

  test("extracts markdown links from websearch output", () => {
    expect(
      urlsFromText("Read [Binance API](https://api.binance.com/api/v3/ticker/price) for details."),
    ).toEqual(["https://api.binance.com/api/v3/ticker/price"])
  })

  test("ignores assistant text and noisy tool metadata outside structured web sources", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "websearch",
            metadata: {
              debug: { url: "https://noise.example.com/debug" },
              nested: [{ url: "https://noise.example.com/nested" }],
            },
            state: {
              status: "completed",
              input: { query: "btc price" },
              output: "https://result.example.com/article",
            },
          } as never,
          {
            type: "text",
            text: "Also see https://noise.example.com/cited and https://result.example.com/article",
          } as never,
        ],
      }),
    ).toEqual(["https://result.example.com/article"])
  })

  test("ignores bash commands that are not web requests", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "python make_xlsx.py" },
              output: "done",
            },
          } as never,
        ],
      }),
    ).toEqual([])
  })

  test("extracts urls from web search metadata sources", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1", role: "assistant" } as never], {
        m1: [
          {
            type: "tool",
            tool: "web_search",
            state: {
              status: "completed",
              input: {},
              output: "",
              metadata: {
                action: {
                  sources: [{ url: "https://example.com/docs" }, { url: "https://example.com/guide" }],
                },
              },
            },
          } as never,
        ],
      }),
    ).toEqual(["https://example.com/docs"])
  })

  test("dedupes urls across descendant sessions", () => {
    expect(
      sessionsWebSourceUrls(
        descendantSessionIDs("ses_root", [
          { id: "ses_root" },
          { id: "ses_child", parentID: "ses_root" },
        ]),
        {
          ses_child: [{ id: "m1" } as never],
        },
        {
          m1: [
            {
              type: "tool",
              tool: "webfetch",
              sessionID: "ses_child",
              state: { status: "completed", input: { url: "https://example.com" }, output: "" },
            } as never,
            {
              type: "tool",
              tool: "webfetch",
              sessionID: "ses_child",
              state: { status: "completed", input: { url: "https://example.com" }, output: "" },
            } as never,
          ],
        },
      ),
    ).toEqual(["https://example.com"])
  })

  test("orders web source urls newest first", () => {
    expect(
      sessionWebSourceUrls(
        [
          { id: "m1", role: "user" } as never,
          { id: "m2", role: "assistant" } as never,
          { id: "m3", role: "user" } as never,
          { id: "m4", role: "assistant" } as never,
        ],
        {
          m2: [
            {
              type: "tool",
              tool: "webfetch",
              state: { status: "completed", input: { url: "https://older.example.com" }, output: "" },
            } as never,
          ],
          m4: [
            {
              type: "tool",
              tool: "webfetch",
              state: { status: "completed", input: { url: "https://newer.example.com" }, output: "" },
            } as never,
          ],
        },
      ),
    ).toEqual(["https://newer.example.com", "https://older.example.com"])
  })

  test("keeps only the first web source url per user turn", () => {
    expect(
      sessionWebSourceUrls(
        [{ id: "m1", role: "user" } as never, { id: "m2", role: "assistant" } as never],
        {
          m2: [
            {
              type: "tool",
              tool: "websearch",
              state: {
                status: "completed",
                input: { query: "nasdaq composite" },
                output: "https://www.cnbc.com/nasdaq\nhttps://finance.yahoo.com/quote/%5EIXIC",
              },
            } as never,
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "completed",
                input: {
                  command:
                    'curl -s "https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EIXIC"',
                },
                output: "{}",
              },
            } as never,
          ],
        },
      ),
    ).toEqual(["https://www.cnbc.com/nasdaq"])
  })

  test("dedupes urls that only differ by trailing slash or host case", () => {
    expect(
      sessionWebSourceUrls([{ id: "m1" } as never], {
        m1: [
          {
            type: "tool",
            tool: "webfetch",
            sessionID: "ses_1",
            state: { status: "completed", input: { url: "https://Example.com/docs/" }, output: "" },
          } as never,
          {
            type: "tool",
            tool: "webfetch",
            sessionID: "ses_1",
            state: { status: "completed", input: { url: "https://example.com/docs" }, output: "" },
          } as never,
        ],
      }),
    ).toEqual(["https://Example.com/docs/"])
  })

  test("dedupes edited files across turns and repeated edits", () => {
    expect(
      uniquePreserveOrder(
        ["src/a.ts", "src/a.ts", "src/b.ts"],
        normalizeFilePath,
      ),
    ).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("orders output artifacts newest first while deduping", () => {
    expect(
      orderOutputArtifactsLatestFirst(
        ["src/a.ts", "src/b.ts", "src/a.ts"],
        normalizeFilePath,
      ),
    ).toEqual(["src/a.ts", "src/b.ts"])
    expect(
      orderOutputArtifactsLatestFirst(
        ["old.png", "snake.py", "new.png"],
        normalizeFilePath,
      ),
    ).toEqual(["new.png", "snake.py", "old.png"])
  })

  test("dedupes edited files with different path separators", () => {
    expect(
      uniquePreserveOrder(["src\\a.ts", "src/a.ts"], normalizeFilePath),
    ).toEqual(["src\\a.ts"])
  })

  test("normalizes web source urls for dedupe key", () => {
    expect(normalizeWebSourceUrl("https://Example.com/docs/")).toBe("https://example.com/docs")
  })

  test("collects image_generation tool attachments as output artifacts", () => {
    expect(
      outputArtifactsFromParts([
        {
          type: "tool",
          tool: "image_generation",
          sessionID: "ses_1",
          state: {
            status: "completed",
            input: { prompt: "earth from space" },
            output: "Generated 1 image.",
            attachments: [
              {
                type: "file",
                mime: "image/png",
                filename: "wanlai-image-earth.png",
                url: "https://cdn.example.com/earth.png",
              },
            ],
          },
        } as never,
      ]),
    ).toEqual(["wanlai-image-earth.png"])
  })

  test("skips image generation loading placeholders", () => {
    expect(
      outputArtifactsFromParts([
        {
          type: "tool",
          tool: "image_generation",
          sessionID: "ses_1",
          state: {
            status: "running",
            input: { prompt: "earth" },
            attachments: [
              {
                type: "file",
                mime: "image/png",
                filename: "wanlai-image-loading-1",
                url: "data:image/png;base64,abc",
              },
            ],
          },
        } as never,
      ]),
    ).toEqual([])
  })

  test("collects assistant file parts as output artifacts", () => {
    expect(
      outputArtifactsFromParts([
        {
          type: "file",
          mime: "image/png",
          filename: "poster.png",
          url: "file:///workspace/poster.png",
        } as never,
      ]),
    ).toEqual(["poster.png"])
  })

  test("ignores read tool file attachments because they are viewed files", () => {
    expect(
      outputArtifactsFromParts([
        {
          type: "file",
          mime: "text/plain",
          filename: "hello.txt",
          url: "file:///workspace/hello.txt",
        } as never,
        {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "C:\\Users\\Admin\\Documents\\sample.png" },
            output: "",
            attachments: [
              {
                type: "file",
                mime: "image/png",
                filename: "sample.png",
                url: "file:///C:/Users/developer/Documents/sample.png",
              },
              {
                type: "file",
                mime: "text/plain",
                filename: "notes.txt",
                url: "file:///C:/Users/developer/Documents/notes.txt",
              },
            ],
          },
        } as never,
      ]),
    ).toEqual(["hello.txt"])
  })

  test("filters output artifacts to image/audio/video/document types only", () => {
    expect(isSessionOutputArtifactPath("jin_metal_planet.jpg")).toBe(true)
    expect(isSessionOutputArtifactPath("office_sample.pdf")).toBe(true)
    expect(isSessionOutputArtifactPath("office_sample.docx")).toBe(true)
    expect(isSessionOutputArtifactPath("sample_table.csv")).toBe(true)
    expect(isSessionOutputArtifactPath("track.mp3", "audio/mpeg")).toBe(true)
    expect(isSessionOutputArtifactPath("clip.mp4", "video/mp4")).toBe(true)
    expect(isSessionOutputArtifactPath("snake.py")).toBe(false)
    expect(isSessionOutputArtifactPath("__pycache__/snake.cpython-311.pyc")).toBe(false)
    expect(isSessionOutputArtifactPath("src/index.ts")).toBe(false)
    expect(isSessionOutputArtifactPath("wanlai_stop_state_repro.zip")).toBe(false)
    expect(isSessionOutputArtifactPath("https://cdn.example.com/photo.jpg")).toBe(false)
    expect(outputArtifactExtension("path/to/file.PDF")).toBe(".pdf")
    expect(
      outputArtifactsFromParts([
        {
          type: "file",
          mime: "text/x-python",
          filename: "snake.py",
          url: "file:///snake.py",
        } as never,
        {
          type: "file",
          mime: "application/pdf",
          filename: "office_sample.pdf",
          url: "file:///office_sample.pdf",
        } as never,
      ]),
    ).toEqual(["office_sample.pdf"])
  })

  test("allows structured generated files beyond previewable artifact types", () => {
    expect(isSessionGeneratedArtifactPath("index.html")).toBe(true)
    expect(isSessionGeneratedArtifactPath("style.css")).toBe(true)
    expect(isSessionGeneratedArtifactPath("app.js")).toBe(true)
    expect(isSessionGeneratedArtifactPath("package.json")).toBe(true)
    expect(isSessionGeneratedArtifactPath("config.yaml")).toBe(true)
    expect(isSessionGeneratedArtifactPath(".gitignore")).toBe(true)
    expect(isSessionGeneratedArtifactPath("utils.py")).toBe(true)
    expect(isSessionGeneratedArtifactPath("__pycache__/utils.cpython-311.pyc")).toBe(false)
    expect(isSessionGeneratedArtifactPath("https://cdn.example.com/app.js")).toBe(false)
    expect(isSessionGeneratedArtifactPath("C:\\Users\\Admin\\Documents\\t\\")).toBe(false)
    // 守卫必须先于放行：Windows 反斜杠缓存目录、协议相对地址、空白路径都不能算产物。
    expect(isSessionGeneratedArtifactPath("build\\__pycache__\\meta.json")).toBe(false)
    expect(isSessionGeneratedArtifactPath("//cdn.example.com/app.js")).toBe(false)
    expect(isSessionGeneratedArtifactPath("   ")).toBe(false)
    expect(isSessionGeneratedArtifactPath("")).toBe(false)
    expect(isSessionGeneratedArtifactPath("src/")).toBe(false)

    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = normalizeFilePath
    ;["index.html", "style.css", "app.js", "package.json", "config.yaml", ".gitignore", "utils.py"].forEach((path) =>
      recordSessionOutputArtifact(entries, seq, path, { key, generated: true }),
    )

    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual([
      "utils.py",
      ".gitignore",
      "config.yaml",
      "package.json",
      "app.js",
      "style.css",
      "index.html",
    ])
  })

  // 多数用例只关心「哪些路径被收录」，这里把事件流投影成 change 路径列表。
  // unlink 语义另有专门用例覆盖，不在此投影里丢掉。
  const shellChangePaths = (parts: readonly unknown[]) =>
    shellOutputFileEventsFromParts(parts as never)
      .filter((item) => item.event === "change")
      .map((item) => item.path)

  test("shell 元数据 files 作为结构化产物来源", () => {
    expect(
      shellChangePaths([
        {
          type: "tool",
          tool: "shell",
          state: {
            status: "completed",
            input: { command: "python make.py" },
            output: "",
            metadata: {
              files: [
                { path: "C:\\Users\\Admin\\Documents\\test222\\blank.xlsx", event: "change" },
                { path: "report.docx", event: "change" },
              ],
            },
          },
        } as never,
      ]),
    ).toEqual(["C:\\Users\\Admin\\Documents\\test222\\blank.xlsx", "report.docx"])
  })

  test("shell 来源仍守可预览白名单，并拒绝远端 URL 与未完成状态", () => {
    const files = (items: unknown) => [
      {
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: {}, output: "", metadata: { files: items } },
      } as never,
    ]
    // 源码类扩展名不是可预览产物，仍被拦住（与其他来源一致）
    expect(shellChangePaths(files([{ path: "src/index.ts", event: "change" }]))).toEqual([])
    // 远端 URL 不是本地产物
    expect(shellChangePaths(files([{ path: "https://cdn.example.com/photo.jpg", event: "change" }]))).toEqual([])
    // 未完成 / 报错的工具调用不采信
    expect(
      shellChangePaths([
        {
          type: "tool",
          tool: "shell",
          state: { status: "error", metadata: { files: [{ path: "out.pdf", event: "change" }] } },
        } as never,
      ]),
    ).toEqual([])
    // 畸形元数据不得抛错
    expect(shellChangePaths(files("not-an-array"))).toEqual([])
    expect(shellChangePaths(files([null, 42, { event: "change" }, { path: "" }]))).toEqual([])
    // 重复路径不在本函数去重（去重会吃掉同轮后到的 unlink），由 record/finalize 保证幂等
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    for (const path of shellChangePaths(
      files([
        { path: "out.pdf", event: "change" },
        { path: "out.pdf", event: "change" },
      ]),
    )) {
      recordSessionOutputArtifact(entries, seq, path)
    }
    expect(finalizeSessionOutputArtifacts(entries)).toEqual(["out.pdf"])
  })

  test("apply_patch 的 metadata.files 不得被当成 shell 产物事件", () => {
    // apply_patch / patch 也把 files 放在 metadata 里，但形状是 { type, filePath, relativePath }。
    // 两者同名不同形，若不做结构化守卫（只认合法 event），diff 来源会从 shell 入口串味进来。
    expect(
      shellOutputFileEventsFromParts([
        {
          type: "tool",
          tool: "apply_patch",
          state: {
            status: "completed",
            metadata: {
              files: [
                { type: "delete", filePath: "C:/work/app/foo.pdf", relativePath: "foo.pdf", patch: "" },
                { type: "update", filePath: "C:/work/app/bar.docx", relativePath: "bar.docx", patch: "" },
              ],
            },
          },
        } as never,
      ]),
    ).toEqual([])
    // event 值非法的条目同样拒收
    expect(
      shellOutputFileEventsFromParts([
        {
          type: "tool",
          tool: "shell",
          state: { status: "completed", metadata: { files: [{ path: "a.pdf", event: "rename" }] } },
        } as never,
      ]),
    ).toEqual([])
  })

  test("shell unlink 回收残留条目，且不受可预览白名单限制", () => {
    const shellPart = (files: unknown) =>
      [
        {
          type: "tool",
          tool: "shell",
          state: { status: "completed", input: {}, output: "", metadata: { files } },
        } as never,
      ] as const
    // unlink 必须绕过可预览白名单：app.js 是 diff 来源以 generated 放行进来的，
    // 若 unlink 也按白名单过滤，shell 删掉它之后就永远回收不掉。
    expect(shellOutputFileEventsFromParts(shellPart([{ path: "app.js", event: "unlink" }]))).toEqual([
      { path: "app.js", event: "unlink" },
    ])
    // 远端 URL 即便标 unlink 也不是本地产物
    expect(
      shellOutputFileEventsFromParts(shellPart([{ path: "https://cdn.example.com/a.png", event: "unlink" }])),
    ).toEqual([])
    // 同一轮先写后删：两个事件都要保留且保持顺序，否则 unlink 会被去重吃掉
    expect(
      shellOutputFileEventsFromParts(
        shellPart([
          { path: "tmp.pdf", event: "change" },
          { path: "tmp.pdf", event: "unlink" },
        ]),
      ),
    ).toEqual([
      { path: "tmp.pdf", event: "change" },
      { path: "tmp.pdf", event: "unlink" },
    ])
  })

  test("跨轮：第一轮 shell 生成、第二轮 shell 删除后输出区不留残留", () => {
    // themanforfree 第四轮指出的场景。这里按 cardOutputFiles 的真实消费顺序重放事件流。
    const key = (path: string) => normalizeOutputArtifactKey(path, "C:/work/app")
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const apply = (files: unknown) => {
      for (const change of shellOutputFileEventsFromParts([
        { type: "tool", tool: "shell", state: { status: "completed", metadata: { files } } } as never,
      ])) {
        if (change.event === "unlink") {
          removeSessionOutputArtifact(entries, change.path, key)
          continue
        }
        recordSessionOutputArtifact(entries, seq, change.path, { key })
      }
    }

    apply([{ path: "report.pdf", event: "change" }])
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["report.pdf"])

    // 第二轮 shell 删除它：绝对路径与相对路径经 key 归一后应命中同一条目
    apply([{ path: "C:\\work\\app\\report.pdf", event: "unlink" }])
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual([])

    // 再次真实生成应当能重新收录（删除不是永久墓碑）
    apply([{ path: "report.pdf", event: "change" }])
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["report.pdf"])
  })

  test("removeSessionOutputArtifact drops every entry sharing the key", () => {
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = (path: string) => normalizeOutputArtifactKey(path, "C:/work/app")
    recordSessionOutputArtifact(entries, seq, "foo.ts", { key, generated: true })
    recordSessionOutputArtifact(entries, seq, "keep.ts", { key, generated: true })
    removeSessionOutputArtifact(entries, "C:\\work\\app\\foo.ts", key)
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["keep.ts"])
    // 移除不存在的路径是幂等的
    removeSessionOutputArtifact(entries, "never-there.png", key)
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["keep.ts"])
  })

  test("assistant text and folder listings never produce output artifacts", () => {
    const listing = [
      "本次对话我共生成了 31 个文件：",
      "random_report.docx",
      "wanlai_stop_state_repro.zip",
      "覆盖 `.js` `.ts` `.py` `.pdf` 共 16 种文件格式。",
      "已生成文件 C:\\Users\\Admin\\Documents\\test222\\blank.xlsx",
    ].join("\n")
    expect(outputArtifactsFromParts([{ type: "text", text: listing } as never])).toEqual([])
    expect(outputArtifactsFromParts([{ type: "reasoning", text: listing } as never])).toEqual([])
    expect(
      outputArtifactsFromParts([
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: listing },
        } as never,
      ]),
    ).toEqual([])
    // 正文来源已移除：目录清单、失败措辞等都不再有任何入口能把路径收进输出区。
    // 唯一的 shell 入口只认元数据 files，不看正文，故清单正文产出为空。
    expect(
      shellChangePaths([
        {
          type: "tool",
          tool: "shell",
          state: { status: "completed", input: { command: "ls" }, output: listing },
        } as never,
      ]),
    ).toEqual([])
  })

  test("失败与计划措辞不再产生条目：正文不再是任何来源", () => {
    // 这些措辞在旧的正文兜底下会被当成已生成产物（themanforfree 第三轮实测），
    // 现在正文不参与收集，无论怎么写都不可能进输出区。
    const wordings = [
      "无法保存到 report.pdf",
      "文件未保存到 report.pdf",
      "导出失败，原计划输出到 report.xlsx",
      "由于权限不足，无法导出到 C:\\tmp\\a.xlsx",
      "计划输出到 plan.docx，但被取消了",
      "已生成文件 report.docx",
    ]
    for (const text of wordings) {
      expect(outputArtifactsFromParts([{ type: "text", text } as never])).toEqual([])
      expect(
        shellChangePaths([{ type: "tool", tool: "shell", state: { status: "completed", output: text } } as never]),
      ).toEqual([])
    }
  })

  test("删除 diff 回收条目后，只有结构化证据能重新收录", () => {
    const key = (path: string) => normalizeOutputArtifactKey(path, "C:/work/app")
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }

    recordSessionOutputArtifact(entries, seq, "report.docx", { key, generated: true, bump: true })
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["report.docx"])

    removeSessionOutputArtifact(entries, "report.docx", key)
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual([])

    // 正文再怎么声称「已生成」都拿不到路径，因此不存在凭正文复活的通道
    expect(
      shellChangePaths([
        { type: "tool", tool: "shell", state: { status: "completed", output: "已生成 report.docx" } } as never,
      ]),
    ).toEqual([])
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual([])

    // shell 元数据是结构化证据：文件确实又被写了一次，应当重新收录
    for (const path of shellChangePaths([
      {
        type: "tool",
        tool: "shell",
        state: { status: "completed", metadata: { files: [{ path: "report.docx", event: "change" }] } },
      } as never,
    ])) {
      recordSessionOutputArtifact(entries, seq, path, { key })
    }
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["report.docx"])
  })

  test("generated artifact recording keeps any written file type but rejects noise", () => {
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = normalizeFilePath
    for (const path of [
      "src/custom.output",
      "产品数据.xlsx",
      "Dockerfile",
      "https://cdn.example.com/app.js",
      "dist/",
      "   ",
    ]) {
      recordSessionOutputArtifact(entries, seq, path, { key, generated: true })
    }
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual([
      "Dockerfile",
      "产品数据.xlsx",
      "src/custom.output",
    ])
  })

  test("ignores remote web assets in output artifacts", () => {
    expect(
      outputArtifactsFromParts([
        {
          type: "file",
          mime: "image/jpeg",
          filename: "weather.jpg",
          url: "https://cdn.worldweatheronline.com/images/weather.jpg",
        } as never,
      ]),
    ).toEqual([])
    expect(
      outputArtifactsFromParts([
        {
          type: "tool",
          tool: "websearch",
          state: {
            status: "completed",
            input: { query: "weather" },
            output: "https://cdn.worldweatheronline.com/images/wx/01.jpg\nhttps://cdn.worldweatheronline.com/images/wx/02.jpg",
          },
        } as never,
        {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "curl -s https://cdn.example.com/photo.png" },
            output: "saved",
          },
        } as never,
      ]),
    ).toEqual([])
  })

  test("finalizeSessionOutputArtifacts keeps newest first and bumps duplicate seq", () => {
    expect(
      finalizeSessionOutputArtifacts(
        [
          { path: "wanlai-image-1.png", seq: 0 },
          { path: "wanlai-image-2.png", seq: 1 },
          { path: "blank.xlsx", seq: 2 },
          { path: "wanlai-image-1.png", seq: 3 },
        ],
        normalizeFilePath,
      ),
    ).toEqual(["wanlai-image-1.png", "blank.xlsx", "wanlai-image-2.png"])
  })

  test("recordSessionOutputArtifact keeps first-seen order when later text mentions old files", () => {
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = normalizeFilePath
    recordSessionOutputArtifact(entries, seq, "wanlai-image-1.png", { key })
    recordSessionOutputArtifact(entries, seq, "wanlai-image-2.png", { key })
    recordSessionOutputArtifact(entries, seq, "wanlai-image-3.png", { key })
    recordSessionOutputArtifact(entries, seq, "wanlai-image-4.png", { key })
    recordSessionOutputArtifact(entries, seq, "blank.xlsx", { key })
    recordSessionOutputArtifact(entries, seq, "wanlai-image-1.png", { key })
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual([
      "blank.xlsx",
      "wanlai-image-4.png",
      "wanlai-image-3.png",
      "wanlai-image-2.png",
      "wanlai-image-1.png",
    ])
  })

  test("recordSessionOutputArtifact bumps only on explicit write or edit regen", () => {
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = normalizeFilePath
    recordSessionOutputArtifact(entries, seq, "blank.xlsx", { key })
    recordSessionOutputArtifact(entries, seq, "wanlai-image-1.png", { key })
    recordSessionOutputArtifact(entries, seq, "wanlai-image-1.png", { key })
    recordSessionOutputArtifact(entries, seq, "blank.xlsx", { key, bump: true })
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["blank.xlsx", "wanlai-image-1.png"])
  })

  test("generated diff paths bump to newest on repeated edits and dedupe across path forms", () => {
    const entries: { path: string; seq: number }[] = []
    const seq = { value: 0 }
    const key = (path: string) => normalizeOutputArtifactKey(path, "C:/work/app")
    // user summary diff 先落地，随后 write/edit 工具 diff 以 bump 提到最新。
    recordSessionOutputArtifact(entries, seq, "src/index.ts", { key, generated: true })
    recordSessionOutputArtifact(entries, seq, "README.md", { key, generated: true })
    recordSessionOutputArtifact(entries, seq, "C:\\work\\app\\src\\index.ts", { key, generated: true, bump: true })
    expect(finalizeSessionOutputArtifacts(entries, key)).toEqual(["C:\\work\\app\\src\\index.ts", "README.md"])
  })

  test("create-then-delete and restore-original clear the output entry", () => {
    const key = (path: string) => normalizeOutputArtifactKey(path, "C:/work/app")
    // 与 cardOutputFiles 的 applyDiffRows 同构：removed 行回收旧条目，其余按 generated 收录。
    // 真实工具 part → diff 行的转换在 packages/ui 的 session-diff.test.ts 里覆盖。
    const run = (rows: { file: string; removed: boolean }[]) => {
      const entries: { path: string; seq: number }[] = []
      const seq = { value: 0 }
      for (const row of rows) {
        if (row.removed) {
          removeSessionOutputArtifact(entries, row.file, key)
          continue
        }
        recordSessionOutputArtifact(entries, seq, row.file, { key, generated: true, bump: true })
      }
      return finalizeSessionOutputArtifacts(entries, key)
    }

    expect(run([{ file: "foo.ts", removed: false }])).toEqual(["foo.ts"])
    // 创建后删除：卡片不能继续展示一个点开必失败的文件
    expect(
      run([
        { file: "foo.ts", removed: false },
        { file: "foo.ts", removed: true },
      ]),
    ).toEqual([])
    // 其它文件不受影响，且绝对/相对路径归一为同一 key
    expect(
      run([
        { file: "keep.docx", removed: false },
        { file: "foo.ts", removed: false },
        { file: "C:\\work\\app\\foo.ts", removed: true },
      ]),
    ).toEqual(["keep.docx"])
    // 删除后重建应重新出现
    expect(
      run([
        { file: "baz.ts", removed: false },
        { file: "baz.ts", removed: true },
        { file: "baz.ts", removed: false },
      ]),
    ).toEqual(["baz.ts"])
  })

  test("normalizeOutputArtifactKey relativizes workspace paths", () => {
    expect(
      normalizeOutputArtifactKey("C:/Users/developer/Documents/test222/blank.xlsx", "C:/Users/developer/Documents/test222"),
    ).toBe("blank.xlsx")
  })

  test("formatOutputArtifactDisplayPath shows relative path inside workspace and absolute outside", () => {
    const root = "C:/Users/developer/Documents/test222"
    expect(formatOutputArtifactDisplayPath(`${root}/subdir/blank.xlsx`, root)).toBe("subdir/blank.xlsx")
    expect(formatOutputArtifactDisplayPath("wanlai-image-1.png", root)).toBe("wanlai-image-1.png")
    expect(formatOutputArtifactDisplayPath("C:\\Users\\Admin\\Documents\\other\\blank.xlsx", root)).toBe(
      "C:\\Users\\Admin\\Documents\\other\\blank.xlsx",
    )
  })

  test("outputArtifactImageMime maps extensions and wanlai-image prefix", async () => {
    const { outputArtifactImageMime, loadOutputArtifactImagePreview, sessionOutputArtifactPreviewUrls } =
      await import("./session-details-card-sources")
    expect(outputArtifactImageMime("sample.jpg")).toBe("image/jpeg")
    expect(outputArtifactImageMime("wanlai-image-3.png")).toBe("image/png")
    expect(outputArtifactImageMime("wanlai-image-2")).toBe("image/png")
    expect(outputArtifactImageMime("blank.xlsx")).toBeUndefined()
    const url = await loadOutputArtifactImagePreview("photo.png", {
      readFileAsDataURL: async () => "data:image/png;base64,abc",
    })
    expect(url).toBe("data:image/png;base64,abc")
    const fallback = await loadOutputArtifactImagePreview("photo.png", {
      readFile: async () => ({ type: "binary", content: "xyz" }),
    })
    expect(fallback).toBe("data:image/png;base64,xyz")
    const sdkImage = await loadOutputArtifactImagePreview("photo.png", {
      readFile: async () => ({
        type: "text",
        content: "abc123",
        encoding: "base64",
        mimeType: "image/png",
      }),
    })
    expect(sdkImage).toBe("data:image/png;base64,abc123")
    const inline = await loadOutputArtifactImagePreview("photo.png", {
      inlineUrl: "data:image/png;base64,inline",
    })
    expect(inline).toBe("data:image/png;base64,inline")
    const previews = sessionOutputArtifactPreviewUrls(
      [{ id: "m1", role: "assistant", sessionID: "ses_1" } as never],
      {
        m1: [
          {
            type: "tool",
            tool: "image_generation",
            sessionID: "ses_1",
            state: {
              status: "completed",
              input: { prompt: "earth" },
              attachments: [
                {
                  type: "file",
                  mime: "image/png",
                  filename: "wanlai-image-1.png",
                  url: "data:image/png;base64,thumb",
                },
              ],
            },
          } as never,
        ],
      },
      (path) => path,
    )
    expect(previews.get("wanlai-image-1.png")).toBe("data:image/png;base64,thumb")
  })
})
