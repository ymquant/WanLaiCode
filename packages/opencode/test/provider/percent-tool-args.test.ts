import { test, expect, describe } from "bun:test"
import { wrapSSE, stripSSEKeepAlive } from "../../src/provider/provider"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

// Reproduction harness for the reported bug: a write/edit tool call whose
// filePath contains a literal '%' (e.g. "100%正式接管") fails to parse with
// "Unterminated string in JSON at position X".
//
// This file decisively determines whether the CLIENT-side parsing path
// (wrapSSE + stripSSEKeepAlive + @ai-sdk/openai-compatible SSE parse) corrupts
// or truncates the '%' bytes. If '%' survives all client transforms AND the
// SDK parses input.filePath === "100%正式接管", the corruption is NOT client-side.

const TARGET = "100%正式接管"
const ARGS_JSON = JSON.stringify({ filePath: TARGET, content: "hello" })
// Sanity: the exact literal the task asks us to prove is valid JSON.
const ARGS_LITERAL = '{"filePath":"100%正式接管","content":"hello"}'

// Split the streamed function.arguments into deltas the way an OpenAI-compatible
// upstream does: one tool-start frame (id/name, empty args) then many tiny
// arguments deltas, deliberately slicing *through* the '%' and the multibyte
// "正式接管" so we catch any byte-boundary corruption.
function chatChunk(delta: unknown) {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta }],
    }) +
    "\n\n"
  )
}

function toolStartFrame(id: string, name: string) {
  return chatChunk({
    tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
  })
}

function toolArgsFrame(text: string) {
  return chatChunk({ tool_calls: [{ index: 0, function: { arguments: text } }] })
}

// Split ARGS_JSON into deltas that deliberately cut THROUGH the '%' and the
// multibyte "正式接管": one piece ends just before '%', the next is exactly
// "%正式接管", and the rest is split into single chars. This is adversarial to
// byte boundaries while keeping "%正式接管" contiguous in one frame so the
// byte-level survival check below is meaningful.
function buildArgPieces(): string[] {
  const at = ARGS_JSON.indexOf(TARGET) // index of "100%正式接管" inside the json
  const pctRel = TARGET.indexOf("%") // 3 -> after "100"
  const cut = at + pctRel // split point right before '%'
  const before = ARGS_JSON.slice(0, cut) // up to and including "100
  const block = "%正式接管" // kept contiguous on purpose
  const after = ARGS_JSON.slice(cut + block.length) // rest of the json

  const pieces: string[] = []
  // chop "before" into single chars
  for (const ch of before) pieces.push(ch)
  pieces.push(block)
  for (const ch of after) pieces.push(ch)
  return pieces
}

// Build the SSE event chunks for the write tool call.
function buildSseChunks(): string[] {
  const pieces = buildArgPieces()

  const chunks: string[] = []
  chunks.push(toolStartFrame("call_write_1", "write"))
  for (const p of pieces) chunks.push(toolArgsFrame(p))
  // a couple of keepalive heartbeats interleaved, to exercise stripSSEKeepAlive
  chunks.push('data: {"type":"ping"}\n\n')
  chunks.push(chatChunk({}) /* empty delta, real chunk -> kept */)
  chunks.push(
    "data: " +
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }) +
      "\n\n",
  )
  chunks.push("data: [DONE]\n\n")
  return chunks
}

function eventStream(chunks: string[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        // Encode each SSE chunk as its own byte buffer. Some chunks are 1-char
        // arguments deltas, so multibyte CJK already crosses frame boundaries.
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk))
        c.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function readAllText(res: Response) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

// Reconstruct the concatenated function.arguments from a transformed SSE body
// the same way @ai-sdk/openai-compatible accumulates delta.tool_calls[].function.arguments.
function extractToolArgs(sse: string): string {
  let args = ""
  for (const line of sse.split(/\r\n|\r|\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).replace(/^ /, "")
    if (data === "[DONE]" || data === "") continue
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    const calls = parsed?.choices?.[0]?.delta?.tool_calls
    if (!Array.isArray(calls)) continue
    for (const c of calls) {
      const a = c?.function?.arguments
      if (typeof a === "string") args += a
    }
  }
  return args
}

describe("percent-in-tool-args: plain JSON validity", () => {
  test("JSON.parse of the literal filePath args succeeds (plain % is valid JSON)", () => {
    const parsed = JSON.parse(ARGS_LITERAL) as { filePath: string; content: string }
    expect(parsed.filePath).toBe(TARGET)
    expect(parsed.content).toBe("hello")
  })

  test("JSON.stringify round-trip preserves the % and CJK", () => {
    const parsed = JSON.parse(ARGS_JSON) as { filePath: string }
    expect(parsed.filePath).toBe(TARGET)
    expect(ARGS_JSON).toBe(ARGS_LITERAL)
  })
})

describe("percent-in-tool-args: client SSE transforms (wrapSSE -> stripSSEKeepAlive)", () => {
  test("'%正式接管' survives wrapSSE + stripSSEKeepAlive and re-parses", async () => {
    const ctl = new AbortController()
    let res = eventStream(buildSseChunks())
    // wrapSSE with a generous timeout (real path uses this); then strip keepalive.
    res = wrapSSE(res, 5000, ctl)
    res = stripSSEKeepAlive(res)

    const out = await readAllText(res)

    // The ping heartbeat must be gone, real frames + [DONE] kept.
    expect(out.includes('{"type":"ping"}')).toBe(false)
    expect(out.includes("[DONE]")).toBe(true)

    // "%正式接管" is streamed contiguously in one arguments delta, so it must
    // survive verbatim in the transformed SSE text.
    expect(out.includes("%正式接管")).toBe(true)

    // Reassemble the streamed tool-call arguments and JSON.parse them.
    const reassembled = extractToolArgs(out)
    expect(reassembled).toBe(ARGS_JSON)
    const parsed = JSON.parse(reassembled) as { filePath: string; content: string }
    expect(parsed.filePath).toBe(TARGET)
    expect(parsed.content).toBe("hello")
  })

  test("byte-level: encoded '%' (0x25) and CJK bytes are preserved verbatim", async () => {
    const ctl = new AbortController()
    let res = eventStream(buildSseChunks())
    res = wrapSSE(res, 5000, ctl)
    res = stripSSEKeepAlive(res)

    // Read raw bytes (no text decode) and assert the UTF-8 byte sequence of
    // "%正式接管" appears intact.
    const reader = res.body!.getReader()
    const parts: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(value)
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const all = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      all.set(p, off)
      off += p.length
    }

    const needle = new TextEncoder().encode("%正式接管") // 25 e6 ad a3 e5 bc 8f e6 8e a5 e7 ae a1
    const hay = all
    let found = false
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let match = true
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) {
          match = false
          break
        }
      }
      if (match) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })
})

describe("percent-in-tool-args: end-to-end through @ai-sdk/openai-compatible", () => {
  test("SDK doStream parses tool input filePath === '100%正式接管'", async () => {
    // Mock fetch returns the SSE produced by the FULL client transform chain,
    // so the SDK's own SSE parser + tool-call accumulation runs on real bytes.
    const mockFetch = (async () => {
      const ctl = new AbortController()
      let res = eventStream(buildSseChunks())
      res = wrapSSE(res, 5000, ctl)
      res = stripSSEKeepAlive(res)
      return res
    }) as unknown as typeof fetch

    const provider = createOpenAICompatible({
      name: "wanlaicode-test",
      baseURL: "http://localhost/v1",
      fetch: mockFetch,
    })
    const model = provider.chatModel("test-model")

    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "write",
          description: "write a file",
          inputSchema: {
            type: "object",
            properties: { filePath: { type: "string" }, content: { type: "string" } },
            required: ["filePath", "content"],
          },
        },
      ],
    })

    const parts: any[] = []
    const reader = result.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    // The SDK emits a tool-call part once arguments are complete.
    const toolCall = parts.find((p) => p.type === "tool-call")
    expect(toolCall).toBeDefined()
    expect(toolCall.toolName).toBe("write")

    const rawInput = toolCall.input
    // input is the raw JSON string of arguments at the LanguageModelV2 layer.
    const parsed = (typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput) as {
      filePath: string
      content: string
    }
    expect(parsed.filePath).toBe(TARGET)
    expect(parsed.content).toBe("hello")
  })
})
