import { onCleanup, onMount, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { FileContent } from "@opencode-ai/sdk/v2"
import * as XLSX from "xlsx"
import { HyperFormula } from "hyperformula"
import { validateOfficeZip } from "./office-zip"

const MAX_SHEET_COUNT = 200
const MAX_WORKBOOK_CELL_COUNT = 200_000
const MAX_SHEET_ROWS = 10_000

interface CellBudget {
  remaining: number
}

function applyBudget(sheet: XLSX.WorkSheet, budget: CellBudget): XLSX.WorkSheet {
  const ref = sheet["!ref"]
  if (!ref) return sheet
  const range = XLSX.utils.decode_range(ref)
  const rowCount = range.e.r - range.s.r + 1
  const colCount = range.e.c - range.s.c + 1
  const requested = rowCount * colCount
  if (requested <= budget.remaining && rowCount <= MAX_SHEET_ROWS) {
    budget.remaining -= requested
    return sheet
  }
  const allowed = Math.max(0, budget.remaining)
  if (allowed === 0) {
    range.e.r = range.s.r
    range.e.c = range.s.c
    return { ...sheet, "!ref": XLSX.utils.encode_range(range) }
  }
  const cappedCols = Math.min(colCount, allowed)
  const cappedRows = Math.min(rowCount, MAX_SHEET_ROWS, Math.max(1, Math.floor(allowed / cappedCols)))
  range.e.r = range.s.r + cappedRows - 1
  range.e.c = range.s.c + cappedCols - 1
  budget.remaining = Math.max(0, budget.remaining - cappedRows * cappedCols)
  return { ...sheet, "!ref": XLSX.utils.encode_range(range) }
}

export function clampSheetRange(sheet: XLSX.WorkSheet): XLSX.WorkSheet {
  return applyBudget(sheet, { remaining: MAX_WORKBOOK_CELL_COUNT })
}

export function clampWorkbookCells(workbook: XLSX.WorkBook): void {
  const budget: CellBudget = { remaining: MAX_WORKBOOK_CELL_COUNT }
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (sheet) workbook.Sheets[sheetName] = applyBudget(sheet, budget)
  }
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&#(\d+);?/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
}

function isSafeSpreadsheetUrl(value: string) {
  const normalized = decodeHtmlAttribute(value).replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase()
  return !normalized.startsWith("javascript:") && !normalized.startsWith("data:") && !normalized.startsWith("vbscript:")
}

export function sanitizeSpreadsheetHtml(value: string) {
  return value.replace(/\s(href|xlink:href)\s*=\s*(["'])(.*?)\2/gi, (attribute, _name, _quote, target) =>
    isSafeSpreadsheetUrl(target) ? attribute : "",
  )
}

function sheetToMatrix(sheet: XLSX.WorkSheet): (string | number | boolean | null)[][] {
  const ref = sheet["!ref"] || "A1"
  const range = XLSX.utils.decode_range(ref)
  const matrix: (string | number | boolean | null)[][] = []
  for (let row = range.s.r; row <= range.e.r; row++) {
    const rowData: (string | number | boolean | null)[] = []
    for (let col = range.s.c; col <= range.e.c; col++) {
      const addr = XLSX.utils.encode_cell({ r: row, c: col })
      const cell = sheet[addr]
      if (!cell) {
        rowData.push(null)
        continue
      }
      if (typeof cell.f === "string" && cell.f) {
        rowData.push(cell.f.startsWith("=") ? cell.f : `=${cell.f}`)
      } else if (cell.v != null) {
        rowData.push(cell.v as string | number | boolean)
      } else {
        rowData.push(null)
      }
    }
    matrix.push(rowData)
  }
  return matrix
}

function writeComputedValues(workbook: XLSX.WorkBook, hf: HyperFormula) {
  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet || !sheet["!ref"]) return
    const range = XLSX.utils.decode_range(sheet["!ref"])
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) {
        const addr = XLSX.utils.encode_cell({ r: row, c: col })
        const cell = sheet[addr]
        if (!cell || !cell.f) continue
        const value = hf.getCellValue({ sheet: sheetIndex, row, col })
        if (value != null && typeof value !== "object") {
          cell.v = value as string | number
          if (typeof value === "number") {
            cell.t = "n"
          }
          delete cell.w
        } else if (value != null && typeof value === "object" && "type" in value) {
          const error = value as { type?: string }
          if (error.type && error.type.startsWith("#")) {
            cell.v = error.type
            cell.t = "e"
            delete cell.w
          }
        }
      }
    }
  })
}

function computeFormulas(workbook: XLSX.WorkBook): void {
  const sheetData: Record<string, (string | number | boolean | null)[][]> = {}
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    sheetData[sheetName] = sheetToMatrix(sheet)
  })
  try {
    const hf = HyperFormula.buildFromSheets(sheetData, {
      licenseKey: "gpl-v3",
    })
    writeComputedValues(workbook, hf)
    hf.destroy()
  } catch {
    // formula computation is best-effort; if it fails, fall through to cached/raw values
  }
}

export function SpreadsheetPreview(props: { content: FileContent; filename?: string }) {
  const i18n = useLanguage()
  const [sheets, setSheets] = createSignal<string[]>([])
  const [activeSheet, setActiveSheet] = createSignal(0)
  const [html, setHtml] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal("")
  let workbook: XLSX.WorkBook | undefined
  let disposed = false

  const renderSheet = (index: number) => {
    if (!workbook) return
    const sheetName = workbook.SheetNames[index]
    if (!sheetName) return
    const sheet = workbook.Sheets[sheetName]
    const htmlString = sanitizeSpreadsheetHtml(XLSX.utils.sheet_to_html(sheet, { id: "xlsx-preview-table", editable: false }))
    setHtml(htmlString)
    setActiveSheet(index)
  }

  onMount(() => {
    const b64 = props.content.content
    if (!b64) return
    setLoaded(false)
    setError("")
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    void validateOfficeZip(bytes)
      .then((validated) => {
        if (disposed || !validated) return
        try {
          workbook = XLSX.read(validated, { type: "array", cellStyles: true, cellNF: true, cellDates: true })
          if (workbook.SheetNames.length > MAX_SHEET_COUNT) {
            workbook.SheetNames = workbook.SheetNames.slice(0, MAX_SHEET_COUNT)
          }
          clampWorkbookCells(workbook)
          if (disposed) return
          computeFormulas(workbook)
          if (disposed) return
          setSheets(workbook.SheetNames)
          renderSheet(0)
          setLoaded(true)
        } catch (e) {
          if (disposed) return
          setError(e instanceof Error ? e.message : i18n.t("session.files.preview.spreadsheet.loadFailed"))
          setLoaded(true)
        }
      })
      .catch((e) => {
        if (disposed) return
        setError(e instanceof Error ? e.message : i18n.t("session.files.preview.spreadsheet.loadFailed"))
        setLoaded(true)
      })
  })

  onCleanup(() => {
    disposed = true
    workbook = undefined
  })

  return (
    <div data-component="spreadsheet-preview-shell" class="flex h-full min-h-0 flex-col bg-background-base">
      <Show when={sheets().length > 1}>
        <div class="flex shrink-0 items-end gap-0.5 border-b border-border-base bg-background-base px-2 pt-1.5">
          {sheets().map((name, index) => (
            <button
              type="button"
              class="border border-b-0 px-3 py-1.5 text-11-medium whitespace-nowrap transition-colors"
              classList={{
                "border-border-base bg-surface-base text-text-strong": index === activeSheet(),
                "border-transparent bg-transparent text-text-weak hover:bg-surface-base": index !== activeSheet(),
              }}
              onClick={() => renderSheet(index)}
            >
              {name}
            </button>
          ))}
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-auto">
        <Show when={loaded()} fallback={
          <div class="flex h-full items-center justify-center text-text-weak">
            {i18n.t("common.loading")}...
          </div>
        }>
          <Show when={!error()} fallback={
            <div class="flex h-full items-center justify-center p-6 text-text-weak">{error()}</div>
          }>
            <Show when={html()} fallback={
              <div class="flex h-full items-center justify-center p-6 text-text-weak">{i18n.t("session.files.preview.spreadsheet.empty")}</div>
            }>
              <div
                data-component="spreadsheet-preview-grid"
                class="h-full bg-white"
                innerHTML={html()}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
