// 从生图占位的 data:image/svg+xml;base64 URL 里取出 viewBox，换算成 CSS aspect-ratio。
// 该 SVG 由 provider 按请求 size 生成（见 imageLoadingUrl），是图片加载完成前唯一的比例来源 ——
// 成图 part 只带 mime/filename/url，自身不含任何尺寸信息。
export function loadingImageAspectRatio(url: string) {
  const encoded = url.match(/^data:image\/svg\+xml;base64,(.+)$/)?.[1]
  if (!encoded) return undefined

  let svg: string
  try {
    svg = atob(encoded)
  } catch {
    return undefined
  }

  const box = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/)
  if (!box) return undefined

  const width = Number(box[1])
  const height = Number(box[2])
  if (!(width > 0) || !(height > 0)) return undefined

  return `${width} / ${height}`
}
