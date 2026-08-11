import { describe, expect, test } from "bun:test"
import { orchestratePastedText } from "./paste-orchestrator"

type AddedAttachment = {
  content: string
  ext?: "txt" | "json"
  title?: string
}

function createHarness(options?: {
  failJson?: boolean
  failText?: boolean
  missingAttachments?: boolean
}) {
  const texts: string[] = []
  const attachments: AddedAttachment[] = []
  const errors: Array<{ name: string; chars: number }> = []

  return {
    texts,
    attachments,
    errors,
    input: {
      addText: (content: string) => {
        texts.push(content)
      },
      addAttachment: async (content: string, ext?: "txt" | "json", title?: string) => {
        attachments.push({ content, ext, title })
        if (options?.missingAttachments) return undefined
        if (ext === "json" && options?.failJson) throw new Error("json write failed")
        if (ext !== "json" && options?.failText) throw new Error("text write failed")
        const suffix = ext ?? "txt"
        return title?.endsWith(`.${suffix}`) ? title : `${title ?? "pasted-text"}.${suffix}`
      },
      insertNativeText: () => false,
      recordError: (name: string, _err: unknown, chars: number) => {
        errors.push({ name, chars })
      },
    },
  }
}

describe("orchestratePastedText", () => {
  test("turns json segments into attachment anchors in paste order", async () => {
    const harness = createHarness()
    const alice = `{"name":"Alice","payload":"${"x".repeat(300)}"}`
    const bob = `{"name":"Bob","payload":"${"y".repeat(300)}"}`

    await orchestratePastedText(`${alice}\nbetween\n${bob}`, harness.input)

    expect(harness.attachments.map((item) => [item.ext, item.title, item.content])).toEqual([
      ["json", "Alice.json", alice],
      ["json", "Bob.json", bob],
    ])
    expect(harness.texts).toEqual(["@Alice.json\n", "\nbetween\n", "@Bob.json\n"])
    expect(harness.errors).toEqual([])
  })

  test("turns short json segments into attachment anchors", async () => {
    const harness = createHarness()

    await orchestratePastedText(`{"ok":true}\nshort\n{"id":1}`, harness.input)

    expect(harness.attachments.map((item) => [item.ext, item.title, item.content])).toEqual([
      ["json", "ok-true.json", `{"ok":true}`],
      ["json", "1.json", `{"id":1}`],
    ])
    expect(harness.texts).toEqual(["@ok-true.json\n", "\nshort\n", "@1.json\n"])
    expect(harness.errors).toEqual([])
  })

  test("preserves newlines around json attachment anchors on the default path", async () => {
    const harness = createHarness()

    await orchestratePastedText(`请按这个处理\n{"ok":true}\n谢谢`, harness.input)

    expect(harness.attachments.map((item) => [item.ext, item.title])).toEqual([["json", "ok-true.json"]])
    expect(harness.texts).toEqual(["请按这个处理\n", "@ok-true.json\n", "\n谢谢"])
    expect(harness.errors).toEqual([])
  })

  test("preserves newlines between consecutive json attachment anchors", async () => {
    const harness = createHarness()
    const pasted = `短json多段\n[1, 2, {"x": true}]\n{"ok":true}\n{"name":"Alice","age":30,"city":"Beijing"}`

    await orchestratePastedText(pasted, harness.input)

    expect(harness.attachments.map((item) => item.title)).toEqual(["array-3.json", "ok-true.json", "Alice.json"])
    expect(harness.texts).toEqual([
      "短json多段\n",
      "@array-3.json\n",
      "\n",
      "@ok-true.json\n",
      "\n",
      "@Alice.json\n",
    ])
    expect(harness.errors).toEqual([])
  })

  test("turns long mixed json text into one text attachment without extracting json", async () => {
    const harness = createHarness()
    const notes = "x".repeat(8000)
    const pasted = `前置说明\n{"name":"Alice"}\n${notes}\n{"name":"Bob"}`

    await orchestratePastedText(pasted, harness.input)

    // 与主分支大段粘贴一致：只落附件卡片，不往编辑器插入 @ 锚点文本。
    expect(harness.attachments).toEqual([
      { content: pasted, ext: undefined, title: undefined },
    ])
    expect(harness.texts).toEqual([])
  })

  test("turns large pure json paste into a json attachment card", async () => {
    const harness = createHarness()
    const json = `{"name":"Alice","payload":"${"x".repeat(8000)}"}`

    await orchestratePastedText(json, harness.input)

    expect(harness.attachments).toEqual([{ content: json, ext: "json", title: "Alice.json" }])
    expect(harness.texts).toEqual(["@Alice.json\n"])
    expect(harness.errors).toEqual([])
  })

  test("turns large pure json array paste into a json attachment card", async () => {
    const harness = createHarness()
    const json = `[${Array.from({ length: 500 }, (_, i) => `{"id":${i}}`).join(",")}]`

    await orchestratePastedText(json, harness.input)

    expect(harness.attachments).toHaveLength(1)
    expect(harness.attachments[0]?.ext).toBe("json")
    expect(harness.attachments[0]?.content).toBe(json)
    expect(harness.texts).toEqual([`@${harness.attachments[0]?.title}\n`])
    expect(harness.errors).toEqual([])
  })

  test("falls back to raw json text when json attachment writing fails", async () => {
    const harness = createHarness({ failJson: true })
    const alice = `{"name":"Alice","payload":"${"x".repeat(300)}"}`
    const bob = `{"name":"Bob","payload":"${"y".repeat(300)}"}`

    await orchestratePastedText(`${alice}\nshort\n${bob}`, harness.input)

    expect(harness.attachments.map((item) => item.title)).toEqual(["Alice.json", "Bob.json"])
    expect(harness.texts).toEqual([alice, "\nshort\n", bob])
    expect(harness.errors).toEqual([
      { name: "prompt.paste.jsonAttachment.failed", chars: alice.length },
      { name: "prompt.paste.jsonAttachment.failed", chars: bob.length },
    ])
  })

  test("falls back to merged notes text when notes attachment writing fails", async () => {
    const harness = createHarness({ failText: true })
    const notes = "x".repeat(8000)
    const pasted = `{"name":"Alice"}\n${notes}\n{"name":"Bob"}`

    await orchestratePastedText(pasted, harness.input)

    expect(harness.attachments).toEqual([
      { content: pasted, ext: undefined, title: undefined },
    ])
    expect(harness.texts).toEqual([pasted])
    expect(harness.errors).toEqual([{ name: "prompt.paste.textAttachment.failed", chars: pasted.length }])
  })

  test("falls back to text when attachment support is missing", async () => {
    const harness = createHarness({ missingAttachments: true })
    const text = "x".repeat(8000)

    await orchestratePastedText(text, harness.input)

    expect(harness.attachments).toEqual([{ content: text, ext: undefined, title: undefined }])
    expect(harness.texts).toEqual([text])
    expect(harness.errors).toEqual([])
  })
})
