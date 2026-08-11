import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  attachQuickChatToTask,
  QUICK_CHAT_ATTACH_EVENT,
  quickChatModelContext,
  quickChatModelSelection,
  releaseQuickChatModelSelection,
  resolveQuickChatModelSelection,
  updateQuickChatModelSelection,
  quickChatTranscript,
  type QuickChatAttachDetail,
} from "./quick-chat"

const messages = [
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "u2", role: "user" },
] satisfies Array<Pick<Message, "id" | "role">>

const text = (messageID: string, value: string, synthetic = false) =>
  ({ id: `${messageID}-part`, messageID, sessionID: "s1", type: "text", text: value, synthetic }) as Part

describe("quickChatTranscript", () => {
  test("keeps visible user and assistant text", () => {
    expect(
      quickChatTranscript({
        messages,
        partsByMessage: {
          u1: [text("u1", "你好")],
          a1: [text("a1", "你好！"), text("a1", "hidden", true)],
          u2: [text("u2", "继续")],
        },
      }),
    ).toBe("User: 你好\n\nAssistant: 你好！\n\nUser: 继续")
  })

  test("keeps the newest complete turns when capped", () => {
    expect(
      quickChatTranscript({
        messages,
        partsByMessage: {
          u1: [text("u1", "old")],
          a1: [text("a1", "middle")],
          u2: [text("u2", "new")],
        },
        maxChars: 28,
      }),
    ).toBe("Assistant: middle\n\nUser: new")
  })
})

describe("resolveQuickChatModelSelection", () => {
  const snapshot = { model: { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" } }

  test("快照有效时直接复用目录页当前模型", () => {
    expect(resolveQuickChatModelSelection({ snapshot, recent: [], valid: () => true })).toEqual(snapshot)
  })

  test("快照失效时回退到全局最近使用过的有效模型", () => {
    expect(
      resolveQuickChatModelSelection({
        snapshot: { model: { providerID: "wanlaicode", modelID: "removed" } },
        recent: [
          { providerID: "wanlaicode", modelID: "removed" },
          { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" },
        ],
        valid: (model) => model.modelID !== "removed",
      }),
    ).toEqual(snapshot)
  })

  test("回退到最近使用模型时保留其推理档位", () => {
    expect(
      resolveQuickChatModelSelection({
        snapshot: undefined,
        recent: [{ providerID: "wanlaicode", modelID: "gpt-5.6", variant: "xhigh" }],
        valid: () => true,
      }),
    ).toEqual({ model: { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "xhigh" } })
  })

  test("快照与最近使用都不可用时不回退到任何默认模型", () => {
    expect(
      resolveQuickChatModelSelection({
        snapshot: { model: { providerID: "wanlaicode", modelID: "removed" } },
        recent: [{ providerID: "wanlaicode", modelID: "removed" }],
        valid: () => false,
      }),
    ).toBeUndefined()
  })
})

describe("快捷聊天模型快照生命周期", () => {
  test("保留目录页最后一次有效模型快照供全局 Dock 使用", () => {
    const owner = Symbol("directory-a")
    updateQuickChatModelSelection({ model: { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" } }, owner)

    expect(quickChatModelSelection()).toEqual({
      model: { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" },
    })

    releaseQuickChatModelSelection(owner)
    expect(quickChatModelSelection()).toBeUndefined()
  })

  test("目录桥卸载后不再沿用旧快照，改用全局最近使用模型", () => {
    const owner = Symbol("directory-a")
    updateQuickChatModelSelection({ model: { providerID: "wanlaicode", modelID: "directory-a-model" } }, owner)
    releaseQuickChatModelSelection(owner)

    expect(
      resolveQuickChatModelSelection({
        snapshot: quickChatModelSelection(),
        recent: [{ providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" }],
        valid: () => true,
      }),
    ).toEqual({ model: { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" } })
  })

  test("旧目录桥的延迟卸载不得清掉新目录已写入的快照", () => {
    const a = Symbol("directory-a")
    const b = Symbol("directory-b")
    updateQuickChatModelSelection({ model: { providerID: "wanlaicode", modelID: "directory-a-model" } }, a)
    updateQuickChatModelSelection({ model: { providerID: "wanlaicode", modelID: "directory-b-model" } }, b)

    releaseQuickChatModelSelection(a)
    expect(quickChatModelSelection()).toEqual({ model: { providerID: "wanlaicode", modelID: "directory-b-model" } })

    releaseQuickChatModelSelection(b)
    expect(quickChatModelSelection()).toBeUndefined()
  })
})

describe("quickChatModelContext", () => {

  test("快捷聊天创建与发送复用当前模型和推理档位", () => {
    expect(
      quickChatModelContext({
        model: { providerID: "wanlaicode", modelID: "gpt-5.6", variant: "high" },
      }),
    ).toEqual({
      create: {
        model: { id: "gpt-5.6", providerID: "wanlaicode", variant: "high" },
      },
      prompt: {
        model: { providerID: "wanlaicode", modelID: "gpt-5.6" },
        variant: "high",
      },
    })
  })
})

describe("attachQuickChatToTask", () => {
  const listen = (handler: (event: Event) => void) => {
    window.addEventListener(QUICK_CHAT_ATTACH_EVENT, handler)
    return () => window.removeEventListener(QUICK_CHAT_ATTACH_EVENT, handler)
  }
  const reference = { id: "ses_1", title: "新聊天", transcript: "内容" }
  const detailOf = (event: Event) => (event as CustomEvent<QuickChatAttachDetail>).detail

  // 这是本函数存在的理由：PromptInput 未挂载时（子会话、权限/提问阻塞、prompt 未 ready）
  // 没有任何监听器，dispatchEvent 仍返回 true。若据此提示「已添加」，引用其实丢了。
  test("零监听器时返回 unhandled，而不是误报成功", () => {
    expect(attachQuickChatToTask(reference)).toBe("unhandled")
  })

  test("监听器未写回执时同样是 unhandled", () => {
    const off = listen(() => {})
    expect(attachQuickChatToTask(reference)).toBe("unhandled")
    off()
  })

  test("插入成功回 added", () => {
    const off = listen((event) => (detailOf(event).result = "added"))
    expect(attachQuickChatToTask(reference)).toBe("added")
    off()
  })

  test("已引用过回 duplicate", () => {
    const off = listen((event) => (detailOf(event).result = "duplicate"))
    expect(attachQuickChatToTask(reference)).toBe("duplicate")
    off()
  })

  test("引用内容原样传给监听方", () => {
    let seen: QuickChatAttachDetail | undefined
    const off = listen((event) => {
      seen = detailOf(event)
      seen.result = "added"
    })
    attachQuickChatToTask(reference)
    expect(seen).toMatchObject(reference)
    off()
  })
})
