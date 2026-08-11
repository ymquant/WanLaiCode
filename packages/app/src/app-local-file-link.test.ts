import { describe, expect, test } from "bun:test"

describe("session local file link bridge", () => {
  test("opens dispatched local file links as outer file tabs", async () => {
    const source = await Bun.file(new URL("./app.tsx", import.meta.url)).text()

    expect(source).toContain('import { OPEN_LOCAL_FILE_EVENT, type OpenLocalFileEventDetail } from "@/utils/open-local-file"')
    expect(source).toContain("const tab = file.tab(detail.absolutePath)")
    expect(source).toContain("void tabs().open(tab, { preview: false })")
    expect(source).toContain("window.addEventListener(OPEN_LOCAL_FILE_EVENT, localFileHandler)")
    expect(source).not.toContain("tabs().open(PROJECT_FILES_TAB_ID)")
    expect(source).not.toContain("requestOpenFile(detail.absolutePath)")
  })
})
