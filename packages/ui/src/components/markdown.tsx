import { useMarked } from "../context/marked"
import { useI18n } from "../context/i18n"
import DOMPurify from "dompurify"
import { checksum } from "@opencode-ai/core/util/encode"
import type { MarkdownPathResolution } from "../context/data"
import { ComponentProps, createEffect, createResource, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"
import { createMarkdownStream } from "./markdown-stream"
import { fileUrlFromAbsolutePath, isHtmlFilePath, isSystemBrowserModifier } from "./markdown-local-path"

type Entry = {
  hash: string
  html: string
}

type RenderedBlock = {
  id: string
  html: string
}

type MountedBlock = {
  id: string
  nodes: Node[]
}

const max = 200
const cache = new Map<string, Entry>()

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

const config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
}

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

type CopyLabels = {
  copy: string
  copied: string
}

type OpenMarkdownLocalPath = ((absolutePath: string, kind?: "file" | "directory") => void | Promise<void>) & {
  canOpen?: (absolutePath: string, kind?: "file" | "directory") => boolean
}

const urlPattern = /^(https?|file):\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const code = block.querySelector("code")
  const explicitLanguage = block.getAttribute("data-language")
  const language =
    (explicitLanguage && explicitLanguage !== "text" ? explicitLanguage : undefined) ??
    code?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
  const label = language ?? "text"
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    if (language) wrapper.setAttribute("data-language", language)
    wrapper.setAttribute("data-language-label", label)
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  if (language) parent.setAttribute("data-language", language)
  else parent.removeAttribute("data-language")
  parent.setAttribute("data-language-label", label)

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement, openExternalLink?: (url: string) => void | Promise<void>) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      if (openExternalLink) {
        parentLink.removeAttribute("target")
        parentLink.setAttribute("data-href", href)
      }
      continue
    }

    const link = document.createElement("a")
    link.className = "external-link"
    link.href = href
    if (openExternalLink) {
      link.setAttribute("data-href", href)
    } else {
      link.target = "_blank"
      link.rel = "noopener noreferrer"
    }
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function setupMarkdownExternalLinkClick(
  root: HTMLDivElement,
  openExternalLink?: (url: string) => void | Promise<void>,
  openSystemBrowserLink?: (url: string) => void | Promise<void>,
) {
  if (!openExternalLink && !openSystemBrowserLink) return () => {}

  const fn = (e: MouseEvent) => {
    const el = e.target
    if (!(el instanceof Element)) return
    const a = el.closest("a.external-link")
    if (!(a instanceof HTMLAnchorElement)) return
    const href = a.getAttribute("data-href") || a.getAttribute("href")
    if (!href) return
    const target = resolveMarkdownExternalLinkClickTarget({
      href,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      canOpenExternal: !!openExternalLink,
      canOpenSystem: !!openSystemBrowserLink,
    })
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    if (target.type === "system" && openSystemBrowserLink) {
      void openSystemBrowserLink(target.value)
      return
    }
    if (target.type === "builtin" && openExternalLink) void openExternalLink(target.value)
  }

  root.addEventListener("click", fn)
  return () => root.removeEventListener("click", fn)
}

export function resolveMarkdownExternalLinkClickTarget(input: {
  href: string
  ctrlKey?: boolean
  metaKey?: boolean
  canOpenExternal: boolean
  canOpenSystem: boolean
  platform?: { isMac?: boolean }
}) {
  if (!urlPattern.test(input.href)) return undefined
  if (isSystemBrowserModifier(input, input.platform)) {
    if ((/^https?:\/\//i.test(input.href) || isHtmlFilePath(input.href)) && input.canOpenSystem) {
      return { type: "system" as const, value: input.href }
    }
  }
  if (input.canOpenExternal) return { type: "builtin" as const, value: input.href }
  return undefined
}

export function resolveMarkdownFileLinkClickTarget(input: {
  href?: string | null
  absolutePath?: string | null
  kind?: "file" | "directory"
  canOpenInReview: boolean
  canOpenLocal: boolean
  canOpenExternal: boolean
  preferReview?: boolean
  preferExternal?: boolean
}) {
  if (input.preferReview && input.absolutePath && input.canOpenInReview) return { type: "review" as const }
  if (input.preferExternal && input.href && input.canOpenExternal && urlPattern.test(input.href)) {
    return { type: "external" as const, value: input.href }
  }
  if (input.absolutePath && input.canOpenLocal) return { type: "local" as const, value: input.absolutePath, kind: input.kind }
  if (input.absolutePath && input.canOpenInReview) return { type: "review" as const }
  if (input.href && input.canOpenExternal && urlPattern.test(input.href)) {
    return { type: "external" as const, value: input.href }
  }
  return undefined
}

export function shouldOpenHtmlFileInSystemBrowser(
  path?: string | null,
  ctrlKey?: boolean,
  metaKey?: boolean,
  platform?: { isMac?: boolean },
) {
  return isHtmlFilePath(path) && isSystemBrowserModifier({ ctrlKey, metaKey }, platform)
}

export function resolveMarkdownHtmlFileBrowserClick(input: {
  href?: string | null
  absolutePath?: string | null
  kind?: "file" | "directory"
  ctrlKey?: boolean
  metaKey?: boolean
  canOpenExternal: boolean
  canOpenSystem: boolean
  platform?: { isMac?: boolean }
}) {
  if (input.kind === "directory") return undefined
  if (!isHtmlFilePath(input.absolutePath) && !isHtmlFilePath(input.href)) return undefined
  const value = input.href && urlPattern.test(input.href) ? input.href : input.absolutePath ? fileUrlFromAbsolutePath(input.absolutePath) : undefined
  if (!value) return undefined
  if (isSystemBrowserModifier(input, input.platform)) {
    if (input.canOpenSystem) return { type: "system" as const, value }
    return undefined
  }
  if (input.canOpenExternal) return { type: "builtin" as const, value }
  return undefined
}

const fileLinkIconSvg = {
  folder: `<path d="M2.08301 2.91675V16.2501H17.9163V5.41675H9.99967L8.33301 2.91675H2.08301Z" stroke="currentColor" stroke-linecap="round"/>`,
  code: `<path d="M8.7513 7.5013L6.2513 10.0013L8.7513 12.5013M11.2513 7.5013L13.7513 10.0013L11.2513 12.5013M2.91797 2.91797H17.0846V17.0846H2.91797V2.91797Z" stroke="currentColor"/>`,
  "open-file": `<path d="M7.91602 2.91406H2.91602V17.0807H17.0827V12.0807M12.0827 2.91406H17.0827V7.91406M9.58268 10.4141L16.666 3.33073" stroke="currentColor" stroke-linecap="square"/>`,
  comment: `<path d="M16.25 3.75H3.75V16.25L6.875 14.4643H16.25V3.75Z" stroke="currentColor" stroke-linecap="square"/>`,
} as const

function pathBasename(filepath: string): string {
  const n = filepath.replace(/\\/g, "/")
  const i = n.lastIndexOf("/")
  return i === -1 ? n : n.slice(i + 1)
}

function pickFileLinkIcon(kind: "file" | "directory", basename: string): keyof typeof fileLinkIconSvg {
  if (kind === "directory") return "folder"
  const lower = basename.toLowerCase()
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "comment"
  if (
    lower.endsWith(".json") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  )
    return "code"
  return "open-file"
}

async function enrichMarkdownFileLinks(
  root: HTMLDivElement,
  opts: {
    resolve?: (raw: string) => Promise<MarkdownPathResolution | undefined>
    signal?: AbortSignal
    hasClickHandler?: boolean
  },
) {
  const resolve = opts.resolve
  if (!resolve) return

  const codes = Array.from(root.querySelectorAll(":not(pre) > code")).filter((node): node is HTMLElement => {
    if (!(node instanceof HTMLElement)) return false
    if (node.closest("a.markdown-file-link")) return false
    const p = node.parentElement
    if (p instanceof HTMLAnchorElement && p.classList.contains("external-link")) return false
    return true
  })

  await Promise.all(
    codes.map(async (code) => {
      if (opts.signal?.aborted) return
      const raw = code.textContent ?? ""
      const resolved = await resolve(raw)
      if (!resolved || opts.signal?.aborted) return

      const iconKey = pickFileLinkIcon(resolved.kind, pathBasename(resolved.absolutePath))
      const iconEl = createIcon(fileLinkIconSvg[iconKey], "markdown-file-link-icon-svg")

      const iconWrap = document.createElement("span")
      iconWrap.setAttribute("data-slot", "markdown-file-link-icon")
      iconWrap.appendChild(iconEl)

      const link = document.createElement("a")
      link.className = "markdown-file-link"
      link.href = resolved.href
      if (opts.hasClickHandler) {
        link.setAttribute("data-href", resolved.href)
      }
      link.setAttribute("data-tooltip", resolved.title)
      link.setAttribute("data-absolute-path", resolved.absolutePath)
      link.setAttribute("data-kind", resolved.kind)
      link.rel = "noopener noreferrer"

      const parent = code.parentNode
      if (!parent) return

      parent.insertBefore(link, code)
      link.appendChild(iconWrap)
      link.appendChild(code)
    }),
  )

  const rawLinks = Array.from(root.querySelectorAll("a.markdown-pending-file-link[data-href]")).filter(
    (el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement,
  )
  await Promise.all(
    rawLinks.map(async (link) => {
      if (opts.signal?.aborted) return
      const raw = link.getAttribute("data-href")
      if (!raw) return
      const resolved = await resolve(raw)
      if (!resolved || opts.signal?.aborted) {
        link.removeAttribute("href")
        link.removeAttribute("data-href")
        link.removeAttribute("target")
        link.className = ""
        link.style.cursor = "default"
        link.style.textDecoration = "none"
        link.style.color = "inherit"
        return
      }

      const iconKey = pickFileLinkIcon(resolved.kind, pathBasename(resolved.absolutePath))
      const iconEl = createIcon(fileLinkIconSvg[iconKey], "markdown-file-link-icon-svg")
      const iconWrap = document.createElement("span")
      iconWrap.setAttribute("data-slot", "markdown-file-link-icon")
      iconWrap.appendChild(iconEl)

      link.href = resolved.href
      link.className = "markdown-file-link"
      if (opts.hasClickHandler) {
        link.setAttribute("data-href", resolved.href)
      }
      link.setAttribute("data-tooltip", resolved.title)
      link.setAttribute("data-absolute-path", resolved.absolutePath)
      link.setAttribute("data-kind", resolved.kind)
      link.rel = "noopener noreferrer"
      link.removeAttribute("target")

      if (!link.querySelector("[data-slot='markdown-file-link-icon']")) {
        link.insertBefore(iconWrap, link.firstChild)
      }
    }),
  )
}

function setupMarkdownFileLinkClick(
  root: HTMLDivElement,
  openReviewPanel?: () => void | Promise<void>,
  openLocalPath?: OpenMarkdownLocalPath,
  openExternalLink?: (url: string) => void | Promise<void>,
  openSystemBrowserLink?: (url: string) => void | Promise<void>,
) {
  if (!openReviewPanel && !openLocalPath && !openExternalLink && !openSystemBrowserLink) return () => {}

  const fn = (e: MouseEvent) => {
    const el = e.target
    if (!(el instanceof Element)) return
    const a = el.closest("a.markdown-file-link")
    if (!(a instanceof HTMLAnchorElement)) return
    const href = a.getAttribute("data-href") || a.getAttribute("href")
    const abs = a.getAttribute("data-absolute-path")
    const kind = a.getAttribute("data-kind") as "file" | "directory" | null
    const htmlBrowserTarget = resolveMarkdownHtmlFileBrowserClick({
      href,
      absolutePath: abs,
      kind: kind ?? undefined,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      canOpenExternal: !!openExternalLink,
      canOpenSystem: !!openSystemBrowserLink,
    })
    if (htmlBrowserTarget) {
      e.preventDefault()
      e.stopPropagation()
      if (htmlBrowserTarget.type === "system" && openSystemBrowserLink) {
        void openSystemBrowserLink(htmlBrowserTarget.value)
        return
      }
      if (htmlBrowserTarget.type === "builtin" && openExternalLink) {
        void openExternalLink(htmlBrowserTarget.value)
        return
      }
    }
    const target = resolveMarkdownFileLinkClickTarget({
      href,
      absolutePath: abs,
      kind: kind ?? undefined,
      canOpenInReview: !!openReviewPanel,
      canOpenLocal: !!openLocalPath && (!abs || !openLocalPath.canOpen || openLocalPath.canOpen(abs, kind ?? undefined)),
      canOpenExternal: !!openExternalLink || !!openSystemBrowserLink,
      preferReview: false,
      preferExternal: isSystemBrowserModifier(e) && !abs && !!openSystemBrowserLink,
    })
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    if (target.type === "review" && openReviewPanel) {
      void openReviewPanel()
      return
    }
    if (target.type === "local" && openLocalPath) {
      void openLocalPath(target.value, target.kind)
      return
    }
    if (target.type === "external") {
      const externalTarget = resolveMarkdownExternalLinkClickTarget({
        href: target.value,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        canOpenExternal: !!openExternalLink,
        canOpenSystem: !!openSystemBrowserLink,
      })
      if (externalTarget?.type === "system" && openSystemBrowserLink) {
        void openSystemBrowserLink(externalTarget.value)
        return
      }
      if (externalTarget?.type === "builtin" && openExternalLink) void openExternalLink(externalTarget.value)
    }
  }

  root.addEventListener("click", fn)
  return () => root.removeEventListener("click", fn)
}

function decorate(root: HTMLDivElement, labels: CopyLabels, openExternalLink?: (url: string) => void | Promise<void>) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root, openExternalLink)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
}

function touch(key: string, value: Entry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

/**
 * 返回新旧渲染结果中可以原样保留的稳定前缀长度。
 * 流式更新只替换第一个变化块及其后方节点，避免每个 token 都遍历整篇 Markdown DOM。
 */
export function stableMarkdownBlockPrefix(previous: readonly { id: string }[], next: readonly { id: string }[]) {
  const limit = Math.min(previous.length, next.length)
  const changed = Array.from({ length: limit }, (_, index) => index).find(
    (index) => previous[index]?.id !== next[index]?.id,
  )
  return changed ?? limit
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
    resolveMarkdownPath?: (raw: string) => Promise<MarkdownPathResolution | undefined>
    openReviewPanel?: () => void | Promise<void>
    openLocalPath?: OpenMarkdownLocalPath
    openExternalLink?: (url: string) => void | Promise<void>
    openSystemBrowserLink?: (url: string) => void | Promise<void>
    /** 最终 Markdown 已提交 DOM 并经过一帧绘制；回合展示态据此避免早于正文结束。 */
    onRenderSettled?: (text: string) => void
  },
) {
  const [local, others] = splitProps(props, [
    "text",
    "cacheKey",
    "streaming",
    "class",
    "classList",
    "resolveMarkdownPath",
    "openReviewPanel",
    "openLocalPath",
    "openExternalLink",
    "openSystemBrowserLink",
    "onRenderSettled",
  ])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  // 每个 Markdown 实例独占增量状态，避免不同消息共享尾块，同时让长回复只重算正在增长的末段。
  const stream = createMarkdownStream()
  const [html] = createResource(
    () => ({
      text: local.text,
      key: local.cacheKey,
      streaming: local.streaming ?? false,
    }),
    async (src) => {
      // 服务端和客户端必须返回同一种分块结构，避免 hydration 后重新走整篇字符串渲染路径。
      if (isServer) return [{ id: `fallback:${checksum(src.text)}`, html: fallback(src.text) }] satisfies RenderedBlock[]
      if (!src.text) return [] satisfies RenderedBlock[]

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        stream(src.text, src.streaming).map(async (block, index) => {
          const hash = checksum(block.raw)
          const id = `${block.mode}:${hash}`
          const key = base ? `${base}:${index}:${block.mode}` : hash

          if (key && hash) {
            const cached = cache.get(key)
            if (cached && cached.hash === hash) {
              touch(key, cached)
              return { id, html: cached.html } satisfies RenderedBlock
            }
          }

          const next = await Promise.resolve(marked.parse(block.src))
          const safe = sanitize(next)
          if (key && hash) touch(key, { hash, html: safe })
          return { id, html: safe } satisfies RenderedBlock
        }),
      ).catch(() => [{ id: `fallback:${checksum(src.text)}`, html: fallback(src.text) }] satisfies RenderedBlock[])
    },
    {
      initialValue: local.text
        ? ([{ id: `fallback:${checksum(local.text)}`, html: fallback(local.text) }] satisfies RenderedBlock[])
        : [],
    },
  )

  let enrichAbort: AbortController | undefined
  let mounted: MountedBlock[] = []
  let settledFrame: number | undefined
  let settledPaintFrame: number | undefined

  const scheduleRenderSettled = (renderedText: string) => {
    if (!local.onRenderSettled || local.streaming || html.loading) return
    if (settledFrame !== undefined) cancelAnimationFrame(settledFrame)
    if (settledPaintFrame !== undefined) cancelAnimationFrame(settledPaintFrame)

    // 第一次 rAF 发生在绘制前，只负责把最终 DOM 留给本帧；第二次 rAF 才发生在至少一次绘制之后。
    // 两帧内若又收到同 part 的迟到文本，则旧版本不得提前释放回合展示运行态。
    settledFrame = requestAnimationFrame(() => {
      settledFrame = undefined
      if (local.streaming || html.loading || local.text !== renderedText) return
      settledPaintFrame = requestAnimationFrame(() => {
        settledPaintFrame = undefined
        if (local.streaming || html.loading || local.text !== renderedText) return
        local.onRenderSettled?.(renderedText)
      })
    })
  }

  createEffect(() => {
    const container = root()
    if (!container) return
    if (isServer) return

    // 事件统一委托给 Markdown 根节点，内容增量变化时不再反复解绑和重绑整组监听器。
    const fileLinkCleanup = setupMarkdownFileLinkClick(
      container,
      local.openReviewPanel,
      local.openLocalPath,
      local.openExternalLink,
      local.openSystemBrowserLink,
    )
    const externalLinkCleanup = setupMarkdownExternalLinkClick(
      container,
      local.openExternalLink,
      local.openSystemBrowserLink,
    )
    const copyCleanup = setupCodeCopy(container, () => ({
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }))

    onCleanup(() => {
      fileLinkCleanup()
      externalLinkCleanup()
      copyCleanup()
    })
  })

  createEffect(() => {
    const container = root()
    const blocks = local.text ? (html.latest ?? html() ?? []) : []
    if (!container) return
    if (isServer) return

    const stable = stableMarkdownBlockPrefix(mounted, blocks)
    if (stable === mounted.length && stable === blocks.length) {
      scheduleRenderSettled(local.text)
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const next = blocks.slice(stable).map((block) => {
      const temp = document.createElement("div")
      temp.innerHTML = block.html
      decorate(temp, labels, local.openExternalLink)
      return { id: block.id, nodes: Array.from(temp.childNodes) } satisfies MountedBlock
    })
    const anchor = mounted[stable]?.nodes.find((node) => node.parentNode === container) ?? null
    const fragment = document.createDocumentFragment()
    next.flatMap((block) => block.nodes).forEach((node) => fragment.appendChild(node))

    // 先把新尾块插入旧尾块之前，再统一移除旧节点；稳定前缀的节点、文件链接装饰和复制状态完全不动。
    container.insertBefore(fragment, anchor)
    mounted
      .slice(stable)
      .flatMap((block) => block.nodes)
      .forEach((node) => node.parentNode?.removeChild(node))
    mounted = [...mounted.slice(0, stable), ...next]
    scheduleRenderSettled(local.text)

    enrichAbort?.abort()
    enrichAbort = new AbortController()

    void enrichMarkdownFileLinks(container, {
      resolve: local.resolveMarkdownPath,
      signal: enrichAbort.signal,
      hasClickHandler: !!local.openLocalPath || !!local.openReviewPanel || !!local.openExternalLink || !!local.openSystemBrowserLink,
    })
  })

  onCleanup(() => {
    enrichAbort?.abort()
    if (settledFrame !== undefined) cancelAnimationFrame(settledFrame)
    if (settledPaintFrame !== undefined) cancelAnimationFrame(settledPaintFrame)
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}
