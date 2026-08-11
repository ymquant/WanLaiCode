const scales = [0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

export const PDF_ZOOM_OPTIONS = [
  ["auto", "session.files.preview.pdf.zoom.auto"],
  ["actual", "session.files.preview.pdf.zoom.actual"],
  ["page-fit", "session.files.preview.pdf.zoom.pageFit"],
  ["page-width", "session.files.preview.pdf.zoom.pageWidth"],
  ["0.5", "50%"],
  ["0.75", "75%"],
  ["1", "100%"],
  ["1.25", "125%"],
  ["1.5", "150%"],
  ["2", "200%"],
  ["3", "300%"],
  ["4", "400%"],
] as const

export type PdfZoomOption = (typeof PDF_ZOOM_OPTIONS)[number][0]

export function pdfAutomaticScale(pageWidth: number, pageHeight: number, availableWidth: number, availableHeight: number) {
  const widthScale = availableWidth / pageWidth
  if (pageWidth <= pageHeight) return Math.min(widthScale, 1.25)
  return Math.min(widthScale, availableHeight / pageHeight)
}

export function clampPdfPage(value: string, total: number, fallback: number) {
  const page = Number.parseInt(value, 10)
  if (!Number.isFinite(page)) return fallback
  return Math.min(Math.max(page, 1), Math.max(total, 1))
}

export function nextPdfScale(current: number, direction: -1 | 1) {
  if (direction > 0) return scales.find((value) => value > current + 0.001) ?? scales.at(-1)!
  return [...scales].reverse().find((value) => value < current - 0.001) ?? scales[0]
}

export function parsePdfScale(value: string, fallback: number) {
  const percent = Number.parseFloat(value.replace("%", ""))
  if (!Number.isFinite(percent)) return fallback
  return Math.min(Math.max(percent / 100, 0.25), 4)
}

export function nextPdfMatch(current: number, count: number, direction: -1 | 1) {
  if (count === 0) return -1
  return (Math.max(current, 0) + direction + count) % count
}

export function pdfToolbarVisibility(container: number, page: number, zoom: number, search: number, gap: number, padding = 0) {
  const usable = Math.max(0, container - padding)
  if (usable >= page + zoom + search + gap * 2) return { page: true, search: true }
  if (usable >= page + zoom + gap) return { page: true, search: false }
  return { page: false, search: false }
}
