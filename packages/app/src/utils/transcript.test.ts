import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { formatTranscript } from "./transcript"

const user = (id: string) =>
  ({
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "wanlaicode", modelID: "gpt-5" },
  }) satisfies UserMessage

const assistant = (input?: { providerID?: string; modelID?: string }) =>
  ({
    id: "msg_assistant",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 2, completed: 1002 },
    parentID: "msg_user",
    modelID: input?.modelID ?? "gpt-5",
    providerID: input?.providerID ?? "wanlaicode",
    mode: "normal",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  }) satisfies AssistantMessage

const session = { id: "ses_1", title: "Demo", time: { created: 1, updated: 2 } }

describe("formatTranscript", () => {
  test("formats text, reasoning, and tool details", () => {
    const parts = [
      {
        id: "part_text",
        sessionID: "ses_1",
        messageID: "msg_user",
        type: "text",
        text: "hello",
      },
      {
        id: "part_reasoning",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "reasoning",
        text: "thinking",
        time: { start: 2 },
      },
      {
        id: "part_tool",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool: "skill",
        state: {
          status: "completed",
          input: { name: "code-review" },
          output: "loaded",
          title: "Loaded",
          metadata: {},
          time: { start: 3, end: 4 },
        },
      },
    ] satisfies Part[]

    expect(
      formatTranscript(
        session,
        [
          { info: user("msg_user"), parts: [parts[0]] },
          { info: assistant(), parts: [parts[1], parts[2]] },
        ],
        {
          thinking: true,
          toolDetails: true,
          assistantMetadata: true,
          providers: [
            {
              id: "wanlaicode",
              name: "WanLaiCode",
              source: "api",
              env: [],
              options: {},
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  providerID: "wanlaicode",
                  api: { id: "gpt-5", url: "https://example.test", npm: "@ai-sdk/openai" },
                  name: "GPT-5",
                  capabilities: {
                    temperature: false,
                    reasoning: true,
                    attachment: false,
                    toolcall: true,
                    input: { text: true, audio: false, image: false, video: false, pdf: false },
                    output: { text: true, audio: false, image: false, video: false, pdf: false },
                    interleaved: false,
                  },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: { context: 1, output: 1 },
                  status: "active",
                  release_date: "2025-01-01",
                  options: {},
                  headers: {},
                },
              },
            },
          ],
        },
      ),
    ).toContain("## Assistant (Build · GPT-5 · 1.0s)")
  })

  test("omits synthetic text and tool payload details when disabled", () => {
    const transcript = formatTranscript(
      session,
      [
        {
          info: user("msg_user"),
          parts: [
            {
              id: "part_synthetic",
              sessionID: "ses_1",
              messageID: "msg_user",
              type: "text",
              text: "hidden",
              synthetic: true,
            },
            {
              id: "part_visible",
              sessionID: "ses_1",
              messageID: "msg_user",
              type: "text",
              text: "visible",
            },
          ],
        },
        {
          info: assistant(),
          parts: [
            {
              id: "part_tool",
              sessionID: "ses_1",
              messageID: "msg_assistant",
              type: "tool",
              callID: "call_1",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "echo secret" },
                output: "secret",
                title: "Ran command",
                metadata: {},
                time: { start: 3, end: 4 },
              },
            },
          ],
        },
      ],
      { thinking: false, toolDetails: false, assistantMetadata: false },
    )

    expect(transcript).toContain("visible")
    expect(transcript).toContain("**Tool: bash**")
    expect(transcript).not.toContain("hidden")
    expect(transcript).not.toContain("echo secret")
    expect(transcript).not.toContain("secret\n```")
  })

  test("formats tool errors and falls back to model id without provider metadata", () => {
    const transcript = formatTranscript(
      session,
      [
        {
          info: assistant({ providerID: "missing", modelID: "custom-model" }),
          parts: [
            {
              id: "part_tool_error",
              sessionID: "ses_1",
              messageID: "msg_assistant",
              type: "tool",
              callID: "call_1",
              tool: "skill",
              state: {
                status: "error",
                input: { name: "bad-skill" },
                error: "failed",
                metadata: {},
                time: { start: 3, end: 4 },
              },
            },
          ],
        },
      ],
      { thinking: true, toolDetails: true, assistantMetadata: true, providers: [] },
    )

    expect(transcript).toContain("## Assistant (Build · custom-model · 1.0s)")
    expect(transcript).toContain("**Error:**")
    expect(transcript).toContain("failed")
  })
})
