import { describe, expect, test } from "bun:test"
import { getProjectFilesPersistKey } from "./project-files-persist"

describe("project file preview lifecycle", () => {
  test("文件打开失败时统一显示 Codex 风格空状态和精简错误通知", async () => {
    const preview = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()
    const legacy = await Bun.file(new URL("../../pages/session/file-tabs.tsx", import.meta.url)).text()
    const context = await Bun.file(new URL("../../context/file.tsx", import.meta.url)).text()
    const styles = await Bun.file(new URL("../../index.css", import.meta.url)).text()
    const loadError = context.slice(context.indexOf("const setLoadError"), context.indexOf("const load ="))
    const toastStart = styles.indexOf(".file-open-error-toast")
    const toastStyle = styles.slice(toastStart, styles.indexOf("\n}\n", toastStart))

    expect(preview.match(/<FileOpenErrorPlaceholder \/>/g)).toHaveLength(2)
    expect(legacy).toContain("<FileOpenErrorPlaceholder />")
    expect(loadError).toContain('class: "file-open-error-toast"')
    expect(loadError).toContain('icon: "circle-x"')
    expect(loadError).not.toContain("description: message")
    // 错误通知保留普通轻阴影，避免高饱和红色描边在四个圆角处叠成深色块。
    expect(toastStyle).toContain("box-shadow: var(--shadow-xs)")
    expect(toastStyle).not.toContain("shadow-xs-border-critical-base")
  })

  test("recreates a reader when switching between files of the same type", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()

    expect(source).toContain("when={state()?.content}")
    expect(source).toContain("keyed")
    expect(source).toContain("{(content) => {")
  })

  test("keeps the file tree toggle visible when no file is open", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()
    const headerStart = source.indexOf('data-component="project-files-toolbar"')
    const toggle = source.indexOf('aria-label={collapsed() ? language.t("session.files.expandTree")', headerStart)
    const pathShow = source.indexOf("<Show when={path()}>", headerStart)

    expect(headerStart).toBeGreaterThan(-1)
    expect(toggle).toBeGreaterThan(headerStart)
    expect(pathShow).toBeGreaterThan(headerStart)
    expect(toggle).toBeGreaterThan(pathShow)
  })

  test("resolves project files persist keys for embedded and normal panels", () => {
    expect(getProjectFilesPersistKey()).toBe("project-files")
    expect(getProjectFilesPersistKey(false)).toBe("project-files")
    expect(getProjectFilesPersistKey(true)).toBe("project-files:embedded")
  })
  test("renders preview tabs with italic label styling", async () => {
    const source = await Bun.file(new URL("./session-sortable-tab.tsx", import.meta.url)).text()

    expect(source).toContain('classList={{ italic: props.preview }}')
    expect(source).toContain('style={props.preview ? { "font-style": "italic" } : undefined}')
  })

  test("double clicking a preview tab converts it to a fixed tab", async () => {
    const source = await Bun.file(new URL("./session-sortable-tab.tsx", import.meta.url)).text()

    expect(source).toContain("const unpreview = () => {")
    expect(source).toContain("if (!isPreview()) return")
    expect(source).toContain("void tabs().open(props.tab, { preview: false })")
    expect(source).toContain("onDblClick={unpreview}")
  })

  test("double clicking a file tree item fixes the matching preview tab", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()

    expect(source).toContain("const fileTab = file.tab(node.path)")
    expect(source).toContain("if (session.all().includes(fileTab)) {")
    expect(source).toContain("session.close(PROJECT_FILES_TAB_ID)")
    expect(source).toContain("session.setActive(fileTab)")
    expect(source).toContain("openProjectFile(node.path, { preview: false })")
  })

  test("clears the selected file when the browse tab becomes active", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()

    expect(source).toContain("if (!props.active) return")
    expect(source).toContain("if (!isProjectFilesTab(props.tab)) return")
    expect(source).toContain("if (!projectFiles.selectedPath) return")
    expect(source).toContain('setProjectFiles("selectedPath", undefined)')
  })

  test("clicking an already opened file tab only activates it from the file tree", async () => {
    const source = await Bun.file(new URL("../../pages/session/session-side-panel.tsx", import.meta.url)).text()

    expect(source).toContain("if (tabs().all().includes(tab)) {")
    expect(source).toContain("tabs().setActive(tab)")
    expect(source).toContain("return")
    expect(source).toContain("openTab(tab, { preview: true })")
  })

  test("pins an active preview file before reopening the browse project files tab", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()

    expect(source).toContain("const preview = tabs.preview()")
    expect(source).toContain("const active = tabs.active()")
    expect(source).toContain("preview && active === preview")
    expect(source).toContain("void tabs.open(preview, { preview: false })")
    expect(source).toContain("void tabs.open(PROJECT_FILES_TAB_ID)")
  })

  test("replaces the browse tab with the selected file tab without opening review", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()

    expect(source).toContain("const openProjectFile = (filePath: string, opts: { preview: boolean }) =>")
    expect(source).toContain("replaceDefaultBrowseTab(session, fileTab, opts)")
    expect(source).toContain("session.setActive(fileTab)")
    expect(source).toContain('setProjectFiles("selectedPath", filePath)')
    expect(source).not.toContain("openReviewPanel")
  })

  test("keeps outer file-tab behavior for non-browser file views", async () => {
    const source = await Bun.file(new URL("./project-files-tab.tsx", import.meta.url)).text()

    expect(source).toContain("replaceTabInPlace(session, currentTab, fileTab, opts)")
    expect(source).toContain("activateOrOpenSessionFileTab(session, fileTab, opts)")
    expect(source).toContain("browsePreviewTab")
    expect(source).not.toContain("onClick={() => activateFileTab(tab)}")
    expect(source).not.toContain("<SortableProvider ids={openTabs()}>")
  })
})
