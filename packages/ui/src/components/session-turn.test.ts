import { describe, expect, test } from "bun:test"
import { collapseThinkingWithViewport } from "./thinking-collapse-scroll"

describe("SessionTurn", () => {
  test("renders automation create cards in final chat content instead of thinking content", async () => {
    const source = (await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()).replace(/\r\n/g, "\n")

    expect(source).toContain('tool === "automation_create"')
    expect(source).toContain("mainChatAssistantPart(part)")
    expect(source).toContain("assistantHasMainChatPart()")
    expect(source).toContain("mainChatAssistantPart(p)")
    expect(source).not.toContain("assistantHasAutomationCard")
  })

  test("renders assistant image files in final chat content instead of processed thinking content", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain("function assistantImageFile")
    expect(source).toContain("if (assistantImageFile(part)) return true")
    // 图片只在最终聊天区渲染，且不随 working 切换容器 —— 搬家会让图片重新加载并双向顶走阅读位置。
    expect(source).toContain("if (mainChatAssistantPart(part)) return false")
    expect(source).not.toContain("!assistantImageFile(part) || !working")
    expect(source).toContain("mainChatAssistantPart(p)")
    expect(source).not.toContain("working() || assistantHasImageFile()")
  })

  test("never disables scroll anchoring inside a turn", async () => {
    const css = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()

    // 用户向上滚动阅读时 auto-scroll 不介入，浏览器滚动锚定是唯一的高度突变补偿机制。
    // 任何一处 overflow-anchor: none 都会让整棵子树失去锚点候选资格。
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(declarations).not.toContain("overflow-anchor")
  })

  test("keeps visible thinking open when the user is reading it", () => {
    let collapsed = false
    const viewport = {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 300,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    }
    const content = { getBoundingClientRect: () => ({ top: 120, bottom: 420 }) }

    // 用户已离开底部且推理区仍在视口内时，自动折叠必须让出阅读控制权。
    expect(collapseThinkingWithViewport({ viewport, content, collapse: () => (collapsed = true) })).toBe(false)
    expect(collapsed).toBe(false)
  })

  test("compensates scroll position when completed thinking collapses above the viewport", () => {
    const viewport = {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 500,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    }
    const content = { getBoundingClientRect: () => ({ top: -320, bottom: -20 }) }

    const collapsed = collapseThinkingWithViewport({
      viewport,
      content,
      collapse: () => {
        viewport.scrollHeight = 900
      },
      schedule: (callback) => callback(),
    })

    // 上方减少 300px 后同步回退 scrollTop，屏幕中的正文保持原坐标而不是突然向上跳。
    expect(collapsed).toBe(true)
    expect(viewport.scrollTop).toBe(200)
  })

  test("does not overwrite user scrolling before collapse compensation runs", () => {
    const viewport = {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 500,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    }
    const content = { getBoundingClientRect: () => ({ top: -320, bottom: -20 }) }
    let compensate = () => {}

    collapseThinkingWithViewport({
      viewport,
      content,
      collapse: () => {
        viewport.scrollHeight = 900
      },
      schedule: (callback) => (compensate = callback),
    })
    viewport.scrollTop = 450
    compensate()

    // 折叠与下一帧之间的新手势优先级最高，补偿逻辑不能把用户重新拉回旧阅读位置。
    expect(viewport.scrollTop).toBe(450)
  })

  test("still collapses completed thinking while following the bottom", () => {
    let collapsed = false
    const viewport = {
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTop: 495,
      getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    }
    const content = { getBoundingClientRect: () => ({ top: 100, bottom: 400 }) }

    expect(collapseThinkingWithViewport({ viewport, content, collapse: () => (collapsed = true) })).toBe(true)
    expect(collapsed).toBe(true)
  })

  test("keeps the turn visually working until the final markdown is painted", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    // runtimeWorking 只代表后端/消息终态；renderState.pendingFinalTextVersion 覆盖最终 Markdown
    // 仍在异步解析和提交 DOM 的窗口，避免“处理中”先变“已处理”或先折叠成空状态。
    expect(source).toContain("const runtimeWorking = createMemo(() => {")
    expect(source).toContain("pendingFinalTextVersion")
    expect(source).toContain("renderedFinalTextVersion")
    // 结算版本必须与 Markdown 真正绘制的展示文本一致，不能拿尚未展示的原始 store 文本冒充完成。
    expect(source).toContain("text: text ? displayImageFailureText(text, i18n.t) : text")
    expect(source).toContain("runtimeWorking() || renderState.runObserved")
    expect(source).toContain("releasePresentationAfterPaint(target)")
    expect(source).toContain("clearPresentationFrame()")
    expect(source).toContain("onTextRendered={onFinalTextRendered}")
  })

  test("allows the app to override stale session status when deciding if a turn is working", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain("working?: boolean")
    expect(source).toContain("if (props.working !== undefined) return props.working")
  })

  test("renders image generation tool attachments like Codex generated image gallery", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()

    expect(source).toContain("function imageGenerationAttachments")
    expect(source).toContain('if (part.tool !== "image_generation") return []')
    expect(source).toContain('part.state.status !== "error"')
    expect(source).toContain("(part.state as { attachments?: FilePart[] }).attachments")
    expect(source).toContain("function GeneratedImageGallery")
    expect(source).toContain('data-slot="session-turn-generated-image-gallery"')
    expect(source).toContain("assistantHasGeneratedImages()")
    expect(source).toContain("generatedImagesFromParts(messageParts(assistantMessage.id))")
    expect(source).toContain(
      "finalAssistantTextPartID() || assistantHasMainChatPart() || assistantHasGeneratedImages()",
    )
    expect(css).toContain('[data-slot="session-turn-generated-image-gallery"]')
    expect(css).toContain("width: min(100%, 400px)")
    expect(css).toContain("flex-wrap: wrap")
    expect(css).toContain("calc(25% - 6px)")
    expect(css).not.toContain("overflow-x: auto")
    expect(css).toContain("border-radius: 16px")
  })

  test("renders image generation tool status with a dedicated card", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./basic-tool.css", import.meta.url)).text()

    expect(source).toContain('name: "image_generation"')
    expect(source).toContain('icon="photo"')
    expect(source).toContain("hideDetails")
    expect(source).toContain('pending() ? "Generating image" : "Image generation"')
    expect(source).toContain('"No image was returned"')
    expect(source).toContain("generatedImageAttachmentCount")
    expect(source).toContain("后续生成已停止")
    expect(source).toContain("requestedImageCount")
    expect(source).toContain("maxImageCount")
    expect(source).toContain("当前最多一次生成")
    expect(source).toContain('data-slot="basic-tool-tool-info-structured" class="image-generation-output"')
    expect(source).toContain('data-slot="basic-tool-tool-info-main" class="image-generation-output"')
    expect(css).toContain("&.image-generation-output")
    expect(css).toContain('&:has([data-slot="basic-tool-tool-subtitle"].image-generation-output)')
    expect(css).toContain("flex-direction: column")
    expect(css).toContain("align-items: flex-start")
    expect(css).toContain("white-space: pre-wrap")
    expect(css).toContain("overflow-wrap: anywhere")
    expect(css).not.toContain("&.image-generation-output {\n      overflow: hidden")
  })

  test("renders denied image generation with real upgrade plans and a recoverable action", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
    const errorCard = await Bun.file(new URL("./tool-error-card.tsx", import.meta.url)).text()
    const dataContext = await Bun.file(new URL("../context/data.tsx", import.meta.url)).text()

    // 服务端拒绝标记是升级卡的唯一入口，普通生图失败不得误展示套餐购买操作。
    expect(source).toContain("partMetadata().imageGenerationPlanDenied === true")
    expect(source).toContain("parseImageGenerationUpgradePlans(props.metadata.supportedPlans)")
    expect(source).toContain("parseImageGenerationUpgradePlans(props.metadata.upgradePlans)")
    expect(source).toContain("parseImageGenerationStorefrontPlans(cachedPlanCatalog()?.plans)")
    // 旧 upgradePlans 只是可升级子集；缺少 supportedPlans 时仍要加载全局真实目录，再用旧数据兜底。
    expect(source).toContain("const hasAuthoritativeMetadataSupportedPlans = createMemo")
    expect(source).toContain("metadataPlanCatalogAvailable() === true")
    expect(source).toContain("metadataPlanCatalogAvailable() === undefined && metadataSupportedPlans().length > 0")
    expect(source).toContain("if (hasAuthoritativeMetadataSupportedPlans()) return metadataSupportedPlans()")
    expect(source).toContain("return upgradePlans()")
    expect(source).toContain("data.loadPurchasePlanCatalog")
    expect(source).toContain("supportedPlans().length > 0")
    expect(source).toContain('data-slot="image-generation-supported-plans"')
    expect(source).toContain("formatImageGenerationPlanNames(supportedPlans(), i18n.locale())")
    expect(source).toContain('data-slot="image-generation-purchase-plans-link"')
    expect(source).toContain("text-text-interactive-base hover:underline")
    expect(source).toContain('"ui.imageGeneration.planDenied.plansLabel"')
    expect(source).toContain("upgradePlans: upgradePlans()")
    expect(source).toContain("supportedPlans: supportedPlans()")
    expect(source).toContain("purchaseEnabled: purchaseEnabled()")
    expect(source).toContain("planCatalogAvailable: planCatalogAvailable()")
    expect(source).toContain("parseImageGenerationMetadataFlag(props.metadata.purchaseEnabled)")
    // 套餐接口异常时必须给出明确空态，不能再次退化为截图中只有两句同义拒绝文案。
    expect(source).toContain('"ui.imageGeneration.planDenied.plansEmpty"')
    expect(source).toContain('"ui.imageGeneration.planDenied.plansDisabled"')
    expect(source).toContain('"ui.imageGeneration.planDenied.plansUnavailable"')
    expect(source).toContain("defaultOpen={imageGenerationPlanDenied() || props.defaultOpen}")

    // 套餐拒绝卡必须覆盖内部 group_disabled 英文哨兵，确保所有入口统一展示当前套餐口径。
    expect(source).toContain(
      'error={imageGenerationPlanDenied() ? i18n.t("ui.imageGeneration.planDenied.message") : error()}',
    )
    expect(source).toContain(
      'imageGenerationPlanDenied() ? i18n.t("ui.imageGeneration.planDenied.subtitle") : taskSubtitle()',
    )

    // 应用内用户中心优先保留登录态，宿主未注入能力时才使用服务端真实购买地址。
    expect(source).toContain("void data.openPurchasePlans?.()")
    expect(source).toContain("void data.openExternalLink?.(next.url)")
    expect(dataContext).toContain("openPurchasePlans?: () => void | Promise<void>")
    expect(dataContext).toContain("purchasePlanCatalog?: () => PurchasePlanCatalog | null | undefined")
    expect(dataContext).toContain("loadPurchasePlanCatalog?: () => Promise<void>")
    expect(errorCard).toContain("{split.children}")
  })

  test("normalizes object tool errors before rendering error cards", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

    expect(source).toContain('import { displayImageFailureText, displayToolErrorText } from "./session-error-display"')
    expect(source).toContain("const errorText = createMemo(() => {")
    expect(source).toContain("return displayToolErrorText((part().state as { error?: unknown }).error, i18n.t)")
    expect(source).toContain("<Match when={errorText()}>")
    expect(source).not.toContain('part().state.status === "error" &&\n              (part().state as any).error')
  })

  test("renders persisted auto-review outcomes beside their tool call", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

    expect(source).toContain("parseToolPermissionReview(partMetadata().permissionReview)")
    expect(source).toContain("<ToolPermissionReview review={permissionReview()}")
  })

  test("renders auto-review outcomes in every grouped tool detail", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
    const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end))

    expect(section("function ContextToolGroup", "function CommandToolGroup")).toContain(
      "<ToolPermissionReviewForPart part={partAccessor()} />",
    )
    expect(section("function CommandToolGroup", "type EditSummaryItem")).toContain(
      "<ToolPermissionReviewForPart part={partAccessor()} />",
    )
    expect(section("function EditToolGroup", "const PREVIEW_LEN")).toContain(
      "<ToolPermissionReview review={item().review} />",
    )
  })

  test("keeps completed image generation tool status in processed thinking content", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain("function processedThinkingPart")
    expect(source).toContain('if (part.type === "tool" && part.tool === "image_generation") return true')
    // TimelineTurn 显式传入 working 运行态；过滤器据此保持统一调用契约，图片位置仍由稳定布局规则决定。
    expect(source).toContain("processedThinkingPart(")
    expect(source).toContain("processedThinkingPart(part, finalAssistantTextPartID(), working())")
    expect(source).toContain("const processedThinkingVisible")
    expect(source).toContain("processedThinkingPart(part, finalAssistantTextPartID())")
    expect(source).toContain("if (processedThinkingVisible()) return true")
    expect(source).not.toContain("if (assistantMessages().length > 0) return true")
    expect(source).toContain("return assistantTextPartInActivity(part, finalTextPartID)")
  })

  test("keeps final assistant content visible while the turn is still working", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    const finalContent = source.slice(
      source.indexOf('data-slot="session-turn-assistant-final-content"'),
      source.indexOf("<Show when={showEditSummaryBelowFinal()}>"),
    )
    expect(finalContent).toContain("if (p.id === finalAssistantTextPartID()) return true")
    expect(finalContent).toContain("if (generated.length > 0)")
    expect(finalContent).not.toContain("if (working()) return false")
    expect(finalContent).not.toContain("if (working()) return []")
  })

  test("keeps the completed edit card when the model has no final text", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const summaryRule = source.slice(
      source.indexOf("const showEditSummaryBelowFinal"),
      source.indexOf("const showOtherDiffSummaryBelowMd"),
    )

    // 无正文回合也必须走统一的新卡片，不能退回截图中的旧版扁平 Changed 文件列表。
    expect(summaryRule).toContain("if (working()) return false")
    expect(summaryRule).not.toContain("finalTextStarted")
    expect(summaryRule).toContain("edited() > 0 || editedToolFiles().length > 0")
  })

  test("iterates stable parts so streaming does not rebuild the final content list", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    // <For> 按引用比对。若逐条包一层新对象再迭代，流式期间每个 token 都会让整列 dispose
    // 重建，正文 DOM 反复重挂，抵消 PacedMarkdown 常驻的意义。part 是 store 里的稳定 proxy。
    expect(source).toContain("<For each={finalContent().parts}>")
    expect(source).not.toContain("finalContentParts")
    expect(source).not.toContain('type: "message-parts"')
  })

  test("renders assistant errors even when the turn has no visible parts", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain("function errorMessageText")
    expect(source).toContain("const showStandaloneError")
    expect(source).toContain("<Show when={showStandaloneError()}>")
    expect(source).toContain('data-slot="session-turn-error-message"')
    expect(source).toContain("const showEmptyAssistantResponse")
    expect(source).toContain('data-kind="empty-response-message"')
  })

  test("renders after-user content before assistant activity and errors", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const userContentIndex = source.indexOf('data-slot="session-turn-message-content"')
    const afterUserIndex = source.indexOf("{props.afterUserContent}")
    const assistantActivityIndex = source.indexOf('data-slot="session-turn-thinking-trigger"')

    expect(source).toContain("afterUserContent?: JSX.Element")
    expect(afterUserIndex).toBeGreaterThan(userContentIndex)
    expect(assistantActivityIndex).toBeGreaterThan(afterUserIndex)
  })

  test("renders inline error cards as Codex-style centered info pills", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()
    const inlineNoticeCss = css.slice(
      css.indexOf('[data-slot="session-turn-inline-notice-wrap"]'),
      css.indexOf('[data-slot="session-turn-assistant-content"]'),
    )

    // inline error with content
    expect(source).toContain('data-kind="error-inline"')
    // standalone error
    expect(source).toContain('data-kind="standalone-error"')
    // empty response
    expect(source).toContain('data-kind="empty-response"')
    expect(source).toContain('data-kind="empty-response-message"')

    // shared structure
    expect(source).toContain('data-slot="session-turn-inline-notice-wrap"')
    expect(source).toContain('class="inline-notice-card"')
    expect(source).toContain('data-slot="session-turn-inline-notice-icon"')
    expect(source).toContain('data-slot="session-turn-inline-notice-content"')
    expect(source).toContain('variant="normal"')
    expect(source).not.toContain('variant="error"')

    // CSS
    expect(css).toContain('[data-slot="session-turn-inline-notice-wrap"]')
    expect(css).toContain('[data-component="card"].inline-notice-card')
    expect(css).toContain('[data-slot="session-turn-inline-notice-icon"]')
    expect(css).toContain('[data-slot="session-turn-inline-notice-content"]')
    expect(css).toContain('[data-slot="session-turn-inline-notice-message"]')
    expect(css).toContain("margin-inline: auto")
    expect(inlineNoticeCss).toContain("background: var(--background-base)")
    expect(inlineNoticeCss).toContain("border: 1px solid var(--border-weak-base)")
    expect(inlineNoticeCss).toContain("border-radius: var(--radius-xl)")
    expect(inlineNoticeCss).toContain("--icon-base: var(--text-strong)")
    expect(inlineNoticeCss).toContain("display: grid")
    expect(inlineNoticeCss).toContain("grid-template-columns: min-content minmax(0, 1fr)")
    expect(inlineNoticeCss).toContain("justify-content: flex-start")
    expect(inlineNoticeCss).toContain("font-size: var(--font-size-base)")
    expect(inlineNoticeCss).not.toContain("--card-accent")
    expect(inlineNoticeCss).not.toContain("light-dark(")
    expect(inlineNoticeCss).not.toContain("color-mix(")
    expect(inlineNoticeCss).not.toContain("rgba(")
    expect(inlineNoticeCss).not.toContain("border-radius: 999px")
    expect(inlineNoticeCss).not.toContain("border-radius: var(--radius-md)")
    expect(inlineNoticeCss).not.toContain("border-radius: var(--radius-lg)")
    expect(inlineNoticeCss).not.toContain("border-radius: var(--radius-full)")
    expect(inlineNoticeCss).not.toContain("font-size: var(--font-size-small)")
    expect(inlineNoticeCss).not.toContain("line-height: 18px")
    expect(inlineNoticeCss).not.toContain("empty-response-orbit")
    expect(inlineNoticeCss).not.toContain("animation:")

    // error text/detail must preserve newlines from backend raw messages
    expect(inlineNoticeCss).toContain("white-space: pre-wrap")
    // empty-response single-line ellipsis must NOT be overridden by pre-wrap
    expect(inlineNoticeCss).toContain("white-space: nowrap")
  })

  test("keeps processed duration ticking while the turn is working", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain("if (working()) return now() - start")
    expect(source).toContain("setNow(Date.now())")
    expect(source).toContain('if (typeof end === "number") return end')
  })

  test("labels active turns as processing instead of processed", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain('error() ? i18n.t("ui.messagePart.diagnostic.error") : working() ? "处理中" : "已处理"')
    expect(source).toContain("{thinkingLabel()}")
  })

  test("does not expose untranslated reasoning originals while translation is pending", async () => {
    const turn = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const part = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

    expect(turn).toContain("showReasoningSummaries && part.text?.trim()")
    expect(turn).toContain('if (part.type === "reasoning" && part.text)')
    expect(turn).not.toContain("part.text?.trim() || part.originalText?.trim()")
    expect(turn).not.toContain("heading(part.text || part.originalText")
    expect(part).toContain(
      'const text = () => (showOriginal() && part().originalText?.trim() ? part().originalText! : (part().text ?? "")).trim()',
    )
    expect(part).toContain("const hasOriginal = () => !!part().text?.trim() && !!part().originalText?.trim()")
    expect(part).not.toContain("part().text || part().originalText")
  })

  test("labels errored turns as errors instead of processed", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    expect(source).toContain("const thinkingLabel")
    expect(source).toContain('error() ? i18n.t("ui.messagePart.diagnostic.error") : working() ? "处理中" : "已处理"')
    expect(source).toContain("{thinkingLabel()}")
  })

  test("uses the default TextShimmer sweep for active thinking", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()

    expect(source).toContain('class="text-12-regular cursor-default session-turn-thinking-shimmer"')
    expect(css).not.toContain('[data-component="text-shimmer"].session-turn-thinking-shimmer')
    expect(css).not.toContain("--text-shimmer-peak-color: var(--text-weak)")
  })

  test("keeps active thinking after every visible turn update", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const activityIndex = source.indexOf("<For each={activityMembers()}>")
    const persistentSteeringIndex = source.indexOf('data-slot="session-turn-persistent-steering-messages"')
    const finalContentIndex = source.indexOf('data-slot="session-turn-assistant-final-content"')
    const activeThinkingIndex = source.indexOf('data-slot="session-turn-thinking"')

    // 流式 phase 可能晚于首个文本 delta 到达；不论内容暂时落在哪个展示区，运行态都必须是回合最后的动态。
    expect(activeThinkingIndex).toBeGreaterThan(activityIndex)
    expect(activeThinkingIndex).toBeGreaterThan(persistentSteeringIndex)
    expect(activeThinkingIndex).toBeGreaterThan(finalContentIndex)
  })

  test("opens the file context menu from edited file rows", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const part = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()

    expect(source).toContain('import { FileLinkContextMenu } from "./file-link-context-menu"')
    expect(source).toContain('import { resolveWorkspaceFilePath } from "./session-turn-path"')
    expect(source).toContain("const onEditDiffContextMenu = (event: MouseEvent, filePath: string) => {")
    expect(source).toContain("if (!data.fileContextMenuActions) return")
    expect(source).toContain("setEditDiffContextPath(resolveFilePath(filePath))")
    expect(source).toContain('data-slot="session-turn-edit-md-name"')
    expect(source).toContain("data-absolute-path={resolveFilePath(f().file)}")
    expect(source).toContain("onContextMenu={(event) => onEditDiffContextMenu(event, f().file)}")
    expect(source).toContain("onContextMenu={(event) => onEditDiffContextMenu(event, diff.file)}")
    expect(source).toContain("<FileLinkContextMenu")
    expect(source).toContain("actions={data.fileContextMenuActions!}")
    expect(part).toContain('import { resolveWorkspaceFilePath } from "./session-turn-path"')
    expect(part).toContain("const onEditActivityFileContextMenu = (event: MouseEvent, filePath: string) => {")
    expect(part).toContain("data-absolute-path={resolveFilePath(item().filePath)}")
    expect(part).toContain("void openPath(item().filePath, e.ctrlKey, e.metaKey)")
    expect(part).toContain("onContextMenu={(event) => onEditActivityFileContextMenu(event, item().filePath)}")
  })

  test("bounds large final diff summaries before mounting file rows", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    // 超长会话可能积累上千个文件；默认收起、分批挂载和静态数字三层保护缺一不可。
    expect(source).toContain("FINAL_DIFF_AUTO_COLLAPSE_THRESHOLD = 80")
    expect(source).toContain("mergedFinalReviewDiffs().slice(0, finalDiffLimit())")
    expect(source).toContain("<For each={visibleFinalReviewDiffs()}>")
    expect(source).toContain("<DiffChanges changes={diff} animated={false} />")
    expect(source).toContain('data-slot="session-turn-edit-diff-more"')
  })

  test("keeps synthetic and ignored assistant text out of final chat content", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const members = await Bun.file(new URL("./session-turn-members.ts", import.meta.url)).text()

    expect(members).toContain("function visibleAssistantTextPart")
    expect(members).toContain("!part.synthetic && !part.ignored")
    expect(source).toContain("selectFinalAssistantTextPart(")
    // 完成态编辑卡不再依赖最终正文；正文展示与复制统一经过 phase-aware 过滤。
    expect(source).toContain("const showAssistantCopyPartID = createMemo(() => finalTextSelection()?.part.id)")
    expect(source).toContain("if (p.id === finalAssistantTextPartID()) return true")
    expect(source).toContain("if (!mainChatAssistantPart(p)) return false")
  })

  test("keeps compaction summary assistant messages out of final chat content", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const members = await Bun.file(new URL("./session-turn-members.ts", import.meta.url)).text()

    expect(source).toContain("function finalAssistantMessage")
    expect(source).toContain("return message.summary !== true")
    // 最新响应段仍由成员模型圈定；真正的 final_answer 再由渲染层结合 parts 选择。
    expect(members).toContain("members.slice(lastSteeringIndex < 0 ? 0 : lastSteeringIndex)")
    expect(members).toContain("currentAssistants.findLast")
    expect(members).toContain("message.summary !== true")
    expect(source).toContain("!finalAssistantMessage(assistantMessage)")
    expect(source).toContain("if (!finalAssistantMessage(assistantMessage)) return false")
  })

  test("keeps post-compaction activity visible and flips the divider once compaction completes", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    // overflow 自动压缩与后续续跑共享同一回合：不能因为回合里出现过 compaction part
    // 就隐藏整个思考组，否则压缩后几小时的真实工作全部空白、看起来像卡死。
    // 只有纯压缩回合（手动 /compact，无其他真实活动）才继续只用分割线表达。
    // 失败摘要保留在活动里只为错误卡片；不算真实活动，不能因此放开思考组（否则内部 reasoning 与错误卡双显）。
    // steer 是同一 turn 的真实成员；自动压缩判定不能把它误当成内部摘要后整组隐藏。
    expect(source).toContain('(member) => member.type !== "assistant" || member.message.summary !== true')
    expect(source).toContain("if (compaction() && !realActivity) return false")
    expect(source).not.toContain("if (compaction()) return false")

    // 分割线时态跟随压缩摘要自身的收尾，而不是整回合 working：
    // 目标模式续跑期间压缩早已完成，divider 必须切回「会话已压缩」。
    expect(source).toContain("compactionFinished(")
    expect(source).not.toContain('return working() ? i18n.t("ui.messagePart.compacting")')

    // 多次压缩取最新一次的状态。
    expect(source).toContain('.findLast((part) => part.type === "compaction")')
  })

  test("renders steering bubbles in source order and keeps them visible while collapsed", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()
    const css = await Bun.file(new URL("./session-turn.css", import.meta.url)).text()
    const thinkingIndex = source.indexOf('data-slot="session-turn-thinking-trigger"')
    const activityIndex = source.indexOf("<For each={activityMembers()}>", thinkingIndex)
    const persistentIndex = source.indexOf('data-slot="session-turn-persistent-steering-messages"', thinkingIndex)
    const finalContentIndex = source.indexOf('data-slot="session-turn-assistant-final-content"', thinkingIndex)

    // Codex 只有一个 turn 级处理容器：展开时 steer 位于 expandedUnits 原序，折叠时由 persistentUnits 接管。
    expect(source).toContain("memberMessageIDs?: readonly string[]")
    expect(source).toContain("steeringUserMessageIDs?: readonly string[]")
    expect(source).toContain("activitySegments")
    expect(source).toContain("<For each={activityMembers()}>")
    expect(source).toContain('member.type === "steering" && thinkingOpen()')
    expect(source).toContain("<For each={steeringMessages()}>{renderSteeringMessage}</For>")
    expect(source).toContain("!thinkingHeaderVisible() || !thinkingOpen()")
    expect(source).not.toContain("renderHistoricalActivity")
    expect(source).not.toContain('data-slot="session-turn-processed"')
    expect(source).not.toContain("session-turn-steered-summary")
    expect(activityIndex).toBeGreaterThan(thinkingIndex)
    expect(persistentIndex).toBeGreaterThan(activityIndex)
    expect(finalContentIndex).toBeGreaterThan(thinkingIndex)
    expect(css).toContain('[data-slot="session-turn-steering-message"]')
  })

  test("renders one turn-level activity chain and only the latest assistant final text", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    // 每条 assistant 与 steer 都进入唯一活动链；segment 只参与终态归属，不能生成第二个“已处理”区块。
    expect(source).toContain("<For each={activityMembers()}>")
    expect(source).toContain("const activityPart = (messageID: string, part: PartType)")
    expect(source).not.toContain("historicalActivityDuration")
    expect(source).toContain("includeText={true}")
    expect(source).toContain("return assistantTextPartInActivity(part, finalTextPartID)")
    expect(source).not.toContain("earlierAssistantContentVisible")
    // 新空 assistant 只更新终态，不会替换真正含 final_answer 的底部内容。
    expect(source).toContain("const latestAssistant = createMemo(() => presentation().finalAssistant)")
    expect(source).toContain("selectFinalAssistantTextPart(")
    expect(source).toContain("currentAssistantMessages().findLast((message) => {")
    expect(source).toContain("<For each={finalAnswerAssistant() ? [finalAnswerAssistant()!] : emptyAssistant}>")
    // 最终正文可以来自较早 assistant，但 Fork 必须保留到响应段物理末端，不能漏掉后续成员。
    expect(source).toContain("latestAssistant() ?? currentAssistantMessages().at(-1)")
  })

  test("does not label a steering-only follow-up as processed", async () => {
    const source = await Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

    // steer 的计数只服务运行态和队列归属，不能再让处理组凭空出现，也不能生成额外文案。
    expect(source).not.toContain("steeredCount")
    expect(source).not.toContain("session-turn-steered-summary")
    expect(source).not.toContain("ui.sessionTurn.steered")
    expect(source).toContain("const thinkingHeaderVisible")
    expect(source).toContain("只有 steer 气泡而没有真实处理活动时不显示")
    expect(source).toContain("!working() && !processedThinkingVisible() && steeringMessages().length > 0")
    expect(source).toContain("<Show when={thinkingHeaderVisible()}>")
    // 标题隐藏或折叠时，官方 persistentUnits 等价区域继续保留 steer 气泡。
    expect(source).toContain("!thinkingHeaderVisible() || !thinkingOpen()")
    expect(source.match(/data-slot="session-turn-thinking-trigger"/g)).toHaveLength(1)
  })
})
