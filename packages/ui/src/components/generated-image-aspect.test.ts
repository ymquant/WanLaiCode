import { describe, expect, test } from "bun:test"
import { loadingImageAspectRatio } from "./generated-image-aspect"

// 生图占位与成图必须同高，否则图片落地那一刻的高度差会把正在阅读的用户顶走。
// 唯一的比例来源是占位 SVG 的 viewBox —— provider 按请求 size 生成它（imageLoadingUrl），
// 成图 part 自身不带任何尺寸信息。
const placeholder = (viewWidth: number, viewHeight: number) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewWidth} ${viewHeight}"><rect/></svg>`)}`

describe("loadingImageAspectRatio", () => {
  test("reads the requested ratio out of the placeholder viewBox", () => {
    expect(loadingImageAspectRatio(placeholder(1024, 1024))).toBe("1024 / 1024")
    // 1536x1024 → provider 换算成 1024x683 的 viewBox
    expect(loadingImageAspectRatio(placeholder(1024, 683))).toBe("1024 / 683")
    // 1024x1536 → 683x1024
    expect(loadingImageAspectRatio(placeholder(683, 1024))).toBe("683 / 1024")
  })

  test("falls back to undefined for anything that is not a placeholder", () => {
    // 真实成图：解析不出比例时交回 CSS 的方形兜底，不能凭空造一个错的。
    expect(loadingImageAspectRatio("https://example.com/image.png")).toBeUndefined()
    expect(loadingImageAspectRatio("data:image/png;base64,AAAA")).toBeUndefined()
  })

  test("rejects malformed or degenerate viewBoxes", () => {
    expect(loadingImageAspectRatio("data:image/svg+xml;base64,%%%")).toBeUndefined()
    expect(loadingImageAspectRatio(placeholder(0, 1024))).toBeUndefined()
    expect(loadingImageAspectRatio(`data:image/svg+xml;base64,${btoa("<svg></svg>")}`)).toBeUndefined()
  })
})

describe("generated image placeholder continuity", () => {
  test("provider replaces the placeholder in place instead of recreating it", async () => {
    const source = await Bun.file(
      new URL("../../../opencode/src/provider/wanlaicode-image-generation.ts", import.meta.url),
    ).text()

    // 复用 part id 是前端锁存比例的前提：删旧建新会让组件实例重建，
    // 占位阶段算出的比例随之丢失，成图解码前又退回方形。
    expect(source).toContain("id: loadingImagePartID ?? PartID.ascending()")
    expect(source).not.toContain("removePart({\n            sessionID: started.sessionID")
  })

  test("the ratio is latched so it survives the swap to the real image", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

    // 一旦算出就不再重算：url 换成真实图片后解析不出比例，重算会把它清掉。
    expect(source).toContain("if (aspectRatio() || !loading()) return")
    expect(source).toContain('style={aspectRatio() ? { "aspect-ratio": aspectRatio() } : undefined}')
  })
})
