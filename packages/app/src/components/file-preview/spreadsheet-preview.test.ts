import { describe, expect, test } from "bun:test"
import * as XLSX from "xlsx"

describe("SpreadsheetPreview office reader", () => {
  test("uses SheetJS + HyperFormula for office-style rendering with formula computation", async () => {
    const source = await Bun.file(new URL("./spreadsheet-preview.tsx", import.meta.url)).text()

    expect(source).toContain('import * as XLSX from "xlsx"')
    expect(source).toContain('import { HyperFormula } from "hyperformula"')
    expect(source).toContain("XLSX.utils.sheet_to_html")
    expect(source).toContain("sanitizeSpreadsheetHtml")
    expect(source).toContain("innerHTML={html()}")
    expect(source).toContain("computeFormulas")
    expect(source).toContain("writeComputedValues")
    expect(source).toContain('data-component="spreadsheet-preview-shell"')
    expect(source).toContain('data-component="spreadsheet-preview-grid"')
    expect(source).not.toContain("exceljs")
    expect(source).not.toContain("ExcelJS")
    expect(source).not.toContain("stripSpreadsheetDrawings")
  })

  test("removes active-content URLs before rendering workbook HTML", async () => {
    const { sanitizeSpreadsheetHtml } = await import("./spreadsheet-preview")

    expect(sanitizeSpreadsheetHtml('<a href="javascript:alert(1)">bad</a>')).not.toContain("javascript:")
    expect(sanitizeSpreadsheetHtml('<a href="data:text/html,bad">bad</a>')).not.toContain("data:")
    expect(sanitizeSpreadsheetHtml('<a href="https://example.com">safe</a>')).toContain("https://example.com")
  })

  test("uses theme tokens for workbook tab chrome", async () => {
    const source = await Bun.file(new URL("./spreadsheet-preview.tsx", import.meta.url)).text()

    expect(source).toContain("border-border-base")
    expect(source).toContain("bg-background-base")
    expect(source).toContain("text-text-strong")
    expect(source).not.toContain('border-[#e0e1e3]')
    expect(source).not.toContain('text-[#111827]')
  })

  test("clampSheetRange leaves small sheets unchanged and truncates oversized ranges", async () => {
    const { clampSheetRange } = await import("./spreadsheet-preview")

    const small = XLSX.utils.aoa_to_sheet([["a", "b"], ["1", "2"]])
    expect(clampSheetRange(small)["!ref"]).toBe("A1:B2")

    const huge = XLSX.utils.aoa_to_sheet([["x"]])
    huge["!ref"] = "A1:XFD1048576"
    const clamped = clampSheetRange(huge)
    const range = XLSX.utils.decode_range(clamped["!ref"]!)
    const rowCount = range.e.r - range.s.r + 1
    const colCount = range.e.c - range.s.c + 1
    expect(rowCount * colCount).toBeLessThanOrEqual(200_000)
    expect(rowCount).toBeLessThanOrEqual(10_000)
  })

  test("clampWorkbookCells applies a workbook-wide cell budget across all sheets", async () => {
    const { clampWorkbookCells } = await import("./spreadsheet-preview")

    const workbook = XLSX.utils.book_new()
    for (let i = 0; i < 5; i++) {
      const sheet = XLSX.utils.aoa_to_sheet([["x"]])
      sheet["!ref"] = "A1:XFD1048576"
      XLSX.utils.book_append_sheet(workbook, sheet, `Sheet${i + 1}`)
    }
    clampWorkbookCells(workbook)

    let total = 0
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet || !sheet["!ref"]) continue
      const range = XLSX.utils.decode_range(sheet["!ref"])
      const rows = range.e.r - range.s.r + 1
      const cols = range.e.c - range.s.c + 1
      total += rows * cols
    }
    expect(total).toBeLessThanOrEqual(200_000 + workbook.SheetNames.length)
  })

  test("clampSheetRange caps a narrow tall sheet to the row limit even within cell budget", async () => {
    const { clampSheetRange } = await import("./spreadsheet-preview")

    const tall = XLSX.utils.aoa_to_sheet([["x"]])
    tall["!ref"] = "A1:A200000"
    const clamped = clampSheetRange(tall)
    const range = XLSX.utils.decode_range(clamped["!ref"]!)
    const rowCount = range.e.r - range.s.r + 1
    const colCount = range.e.c - range.s.c + 1
    expect(rowCount).toBeLessThanOrEqual(10_000)
    expect(rowCount * colCount).toBeLessThanOrEqual(200_000)
  })
})
