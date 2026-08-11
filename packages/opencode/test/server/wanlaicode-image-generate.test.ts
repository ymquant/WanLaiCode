import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { pathToFileURL } from "url"
import {
  callImageGenerationApi,
  imageBlob,
  imageGenerationPrompt,
  imageRequestPayload,
  readableImageGenerationError,
  readableImageGenerationErrorWithMessages,
} from "../../src/provider/wanlaicode-image-generation"

test("provider runtime does not depend on Bun globals", async () => {
  const source = await Bun.file(new URL("../../src/provider/wanlaicode-image-generation.ts", import.meta.url)).text()
  expect(source).not.toContain("Bun.")
})

describe("wanlaicode image generation prompt", () => {
  test("uses caller-provided i18n text for group-disabled image generation errors", () => {
    expect(
      readableImageGenerationErrorWithMessages(new Error("Image generation is not enabled for this group"), {
        group_disabled: "当前账号组未开通图片生成功能，请联系管理员开通后再试。",
      }),
    ).toBe("当前账号组未开通图片生成功能，请联系管理员开通后再试。")
    expect(
      readableImageGenerationErrorWithMessages(
        {
          data: {
            message: "Image generation is not enabled for this group",
          },
        },
        {
          group_disabled: "Image generation is not enabled for this account group.",
        },
      ),
    ).toBe("Image generation is not enabled for this account group.")
  })

  test("keeps group-disabled image generation errors unchanged without i18n text", () => {
    expect(
      readableImageGenerationError(new Error("Image generation is not enabled for this group")),
    ).toBe("Image generation is not enabled for this group")
    expect(
      readableImageGenerationErrorWithMessages(
        new Error("Image generation is not enabled for this group"),
        undefined,
      ),
    ).toBe("Image generation is not enabled for this group")
  })

  test("keeps unknown image generation errors unchanged", () => {
    expect(
      readableImageGenerationErrorWithMessages(new Error("Request failed"), {
        group_disabled: "当前账号组未开通图片生成功能，请联系管理员开通后再试。",
      }),
    ).toBe("Request failed")
  })

  test("uses the original prompt when no context text is present", () => {
    expect(imageGenerationPrompt({ prompt: "  生成一张猫图  " })).toBe("生成一张猫图")
  })

  test("combines context text with the user prompt for backend image calls", () => {
    const result = imageGenerationPrompt({
      prompt: "生成一张封面",
      context_text: "Selected chat excerpts:\n极简黑白风格",
    })
    // 上下文作为"画什么"的依据，且包含用户请求
    expect(result).toContain("Use the session context below to decide the subject and content of the image.")
    expect(result).toContain("Selected chat excerpts:\n极简黑白风格")
    expect(result).toContain("User image request: 生成一张封面")
  })

  test("keeps batch image count separate from single-canvas content", () => {
    const result = imageGenerationPrompt(
      {
        prompt: "生成三张不同风格的科幻飞鱼图",
        context_text: "用户要三张不同风格：太空星云、赛博城市、云海日落。",
      },
      { index: 2, total: 3 },
    )

    expect(result).toContain("This API request is image 2 of 3")
    expect(result).toContain("Create exactly one complete standalone image in this file.")
    expect(result).toContain("Do not create a collage, triptych, multi-panel layout")
    expect(result).toContain("choose one distinct variant for this file only")
  })

  test("instructs the model to infer subject from context for brief requests", () => {
    const result = imageGenerationPrompt({
      prompt: "给我图片",
      context_text: "Current conversation (use it as the basis for what to generate; the user's request above takes priority):\nUser: 生成一些题目\nAssistant: 请告诉我学科、年级、题型。",
    })
    expect(result).toContain("infer what to draw from this context")
    expect(result).toContain("生成一些题目")
    expect(result).toContain("User image request: 给我图片")
  })

  test("treats the immediate previous assistant answer as authoritative for text-card prompts", () => {
    const result = imageGenerationPrompt({
      prompt: "给我图片",
      context_text: [
        "Image generation source priority:",
        "Use only the immediate_previous_assistant_answer below as the image content source.",
        "Ignore older chat images, screenshots, generated-image results, revised prompts, and unrelated previous visual tasks.",
        "",
        "latest_user_request:",
        "给我图片",
        "",
        "immediate_previous_assistant_answer:",
        "交付风险清单：\n1. 上下文短追问容易串到旧图片。\n2. 图片工具需要明确内容来源。",
      ].join("\n"),
    })

    // 这里模拟“刚回答完文字，用户只说给我图片”的场景，最终图片 prompt 必须继续锁住上一条回答。
    expect(result).toContain("Previous assistant answer rendering instruction")
    expect(result).toContain("authoritative source")
    expect(result).toContain("Do not turn nouns")
    expect(result).toContain("Avoid using older conversation images")
    expect(result).toContain("User image request: 给我图片")
    expect(result).toContain("交付风险清单")
    expect(result).toContain("上下文短追问容易串到旧图片")
  })

  test("treats input images as the primary source for edit prompts", () => {
    const result = imageGenerationPrompt({
      prompt: "改成 gitee 风格",
      context_text: "Current uploaded images (primary edit target):\n- Image 1: uploaded.png (image/png)\n\nCurrent conversation:\nAssistant: 上一张图是综合常识练习卡片。",
      input_images: [{ data_url: "data:image/png;base64,current", mime: "image/png", filename: "uploaded.png" }],
    })

    expect(result).toContain("editing the provided input image")
    expect(result).toContain("primary source of visual truth")
    expect(result).toContain("do not replace the uploaded image with older chat content")
    expect(result).toContain("User image request: 改成 gitee 风格")
  })

  test("does not add image API advanced defaults unless configured", () => {
    expect(imageRequestPayload({ model: "gpt-image-2", prompt: "生成一张猫图" })).toEqual({
      model: "gpt-image-2",
      prompt: "生成一张猫图",
    })
  })

  test("keeps explicitly configured image API options", () => {
    expect(
      imageRequestPayload({
        model: "gpt-image-2",
        prompt: "生成一张猫图",
        size: "1024x1024",
        output_format: "png",
      }),
    ).toEqual({
      model: "gpt-image-2",
      prompt: "生成一张猫图",
      size: "1024x1024",
      output_format: "png",
    })
  })

  test("adds single-image batch instructions to image API payloads", () => {
    const payload = imageRequestPayload(
      {
        model: "gpt-image-2",
        prompt: "生成三张不同风格的科幻飞鱼图",
        size: "1024x1024",
        output_format: "png",
      },
      { index: 1, total: 3 },
    )

    expect(payload.prompt).toContain("This API request is image 1 of 3")
    expect(payload.prompt).toContain("not by drawing multiple images inside one canvas")
    expect(payload).toMatchObject({
      model: "gpt-image-2",
      size: "1024x1024",
      output_format: "png",
    })
  })

  test("requests multi-image batches sequentially and reports progress", async () => {
    const previousFetch = globalThis.fetch
    const requests: Array<RequestInfo | URL> = []
    const pending: Array<(response: Response) => void> = []
    const progress: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          requests.push(input)
          pending.push(resolve)
        }),
      { preconnect: previousFetch.preconnect },
    )
    try {
      const result = callImageGenerationApi({
        apiKey: "key",
        payload: { model: "gpt-image-2", prompt: "生成三张猫图", count: 3, output_format: "png" },
        onImage: ({ image, index }) => {
          progress.push(`${index}:${image.url}`)
        },
      })

      while (requests.length < 1) await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(requests).toHaveLength(1)

      pending[0]?.(Response.json({ data: [{ b64_json: "image-1" }] }))
      while (requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
      expect(progress).toEqual(["1:data:image/png;base64,image-1"])

      pending[1]?.(Response.json({ data: [{ b64_json: "image-2" }] }))
      while (requests.length < 3) await new Promise((resolve) => setTimeout(resolve, 0))
      expect(progress).toEqual(["1:data:image/png;base64,image-1", "2:data:image/png;base64,image-2"])

      pending[2]?.(Response.json({ data: [{ b64_json: "image-3" }] }))
      const images = await result
      expect(requests).toHaveLength(3)
      expect(images.map((image) => image.filename)).toEqual([
        "wanlai-image-1.png",
        "wanlai-image-2.png",
        "wanlai-image-3.png",
      ])
      expect(progress).toEqual([
        "1:data:image/png;base64,image-1",
        "2:data:image/png;base64,image-2",
        "3:data:image/png;base64,image-3",
      ])
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("loads reference images from http urls", async () => {
    const previousFetch = globalThis.fetch
    const calls: RequestInit[] = []
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {})
        return new Response(new Blob(["image"], { type: "image/png" }), {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      },
      { preconnect: previousFetch.preconnect },
    )
    try {
      const file = await imageBlob({
        data_url: "https://cdn.example.com/generated.png",
        filename: "generated.png",
      })
      expect(file.name).toBe("generated.png")
      expect(file.type).toBe("image/png")
      expect(calls[0]?.redirect).toBe("manual")
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("rejects redirected reference image URLs", async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/generated.png" },
        }),
      { preconnect: previousFetch.preconnect },
    )
    try {
      await expect(
        imageBlob({
          data_url: "https://cdn.example.com/generated.png",
          filename: "generated.png",
        }),
      ).rejects.toThrow("Reference image URL redirects are not allowed")
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("rejects local reference image URLs", async () => {
    for (const data_url of [
      "http://127.0.0.1:8080/generated.png",
      "http://localhost:8080/generated.png",
      "http://[::1]:8080/generated.png",
      "http://service.local/generated.png",
    ]) {
      await expect(imageBlob({ data_url, filename: "generated.png" })).rejects.toThrow(
        "Reference image URL cannot target local or private network hosts",
      )
    }
  })

  test("loads reference images from local file URLs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wanlaicode-image-reference-"))
    const filePath = path.join(dir, "reference.png")
    try {
      await writeFile(filePath, "image")
      const file = await imageBlob({
        data_url: pathToFileURL(filePath).toString(),
        filename: "generated.png",
        mime: "image/png",
      })
      expect(file.name).toBe("generated.png")
      expect(file.type).toBe("image/png")
      expect(await file.text()).toBe("image")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects unsupported reference image URL protocols", async () => {
    await expect(
      imageBlob({
        data_url: "ftp://example.com/generated.png",
        filename: "generated.png",
      }),
    ).rejects.toThrow("Reference image must be a data or HTTP(S) URL")
  })
})
