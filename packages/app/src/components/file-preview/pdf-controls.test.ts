import { describe, expect, test } from "bun:test"
import { PDF_ZOOM_OPTIONS, clampPdfPage, nextPdfMatch, nextPdfScale, parsePdfScale, pdfAutomaticScale } from "./pdf-controls"
import { pdfToolbarVisibility } from "./pdf-controls"

describe("PDF controls", () => {
  test("clamps typed page navigation to the document range", () => {
    expect(clampPdfPage("2", 3, 1)).toBe(2)
    expect(clampPdfPage("99", 3, 1)).toBe(3)
    expect(clampPdfPage("0", 3, 2)).toBe(1)
    expect(clampPdfPage("nope", 3, 2)).toBe(2)
  })

  test("steps through stable zoom presets", () => {
    expect(nextPdfScale(1, 1)).toBe(1.1)
    expect(nextPdfScale(1, -1)).toBe(0.9)
    expect(nextPdfScale(4, 1)).toBe(4)
    expect(nextPdfScale(0.25, -1)).toBe(0.25)
  })

  test("accepts percentage zoom input and rejects invalid values", () => {
    expect(parsePdfScale("125%", 1)).toBe(1.25)
    expect(parsePdfScale("10", 1)).toBe(0.25)
    expect(parsePdfScale("900", 1)).toBe(4)
    expect(parsePdfScale("fit", 1.5)).toBe(1.5)
  })

  test("provides every Chrome-style zoom option in display order", () => {
    expect(PDF_ZOOM_OPTIONS).toEqual([
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
    ])
  })

  test("uses page width for portrait auto zoom and page fit for landscape", () => {
    expect(pdfAutomaticScale(600, 800, 720, 700)).toBe(1.2)
    expect(pdfAutomaticScale(1000, 600, 700, 500)).toBe(0.7)
  })

  test("wraps search navigation in both directions", () => {
    expect(nextPdfMatch(0, 3, 1)).toBe(1)
    expect(nextPdfMatch(2, 3, 1)).toBe(0)
    expect(nextPdfMatch(0, 3, -1)).toBe(2)
    expect(nextPdfMatch(-1, 0, 1)).toBe(-1)
  })

  test("hides right then left controls based on measured group widths", () => {
    expect(pdfToolbarVisibility(620, 190, 260, 28, 32)).toEqual({ page: true, search: true })
    expect(pdfToolbarVisibility(500, 190, 260, 28, 32)).toEqual({ page: true, search: false })
    expect(pdfToolbarVisibility(440, 190, 260, 28, 32)).toEqual({ page: false, search: false })
  })

  test("subtracts horizontal padding before comparing group widths", () => {
    expect(pdfToolbarVisibility(620, 190, 260, 28, 32, 24)).toEqual({ page: true, search: true })
    expect(pdfToolbarVisibility(500, 190, 260, 28, 32, 24)).toEqual({ page: false, search: false })
    expect(pdfToolbarVisibility(440, 190, 260, 28, 32, 24)).toEqual({ page: false, search: false })
  })
})
