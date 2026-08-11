import type { Hooks } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import path from "path"

export interface CodexHookHandlerCommand {
  type: "command"
  command: string
  timeout?: number
}

export interface CodexHookHandlerPrompt {
  type: "prompt"
}

export interface CodexHookHandlerAgent {
  type: "agent"
}

export type CodexHookHandler = CodexHookHandlerCommand | CodexHookHandlerPrompt | CodexHookHandlerAgent

export interface CodexMatcherGroup {
  matcher?: string
  hooks: CodexHookHandler[]
}

export interface CodexHookEvents {
  PreToolUse?: CodexMatcherGroup[]
  PermissionRequest?: CodexMatcherGroup[]
  PostToolUse?: CodexMatcherGroup[]
  SessionStart?: CodexMatcherGroup[]
  UserPromptSubmit?: CodexMatcherGroup[]
  Stop?: CodexMatcherGroup[]
}

export interface CodexHooksFile {
  hooks: CodexHookEvents
}

// Inline hook definition form from plugin.json `hooks` field
interface HookInlineObject {
  path: string
  events?: string[]
  matcher?: string
}

const SUPPORTED_EVENTS: Partial<Record<keyof CodexHookEvents, keyof Hooks>> = {
  PreToolUse: "tool.execute.before",
  PermissionRequest: "permission.ask",
  PostToolUse: "tool.execute.after",
  UserPromptSubmit: "command.execute.before",
}

const UNSUPPORTED_EVENTS: (keyof CodexHookEvents)[] = ["SessionStart", "Stop"]

export interface AddonHooksResult {
  hooks: Partial<Hooks>
  unsupportedEvents: string[]
}

function makeCommandRunner(command: string, addonRoot: string, timeoutMs?: number) {
  return async (input: any, output: any) => {
    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: addonRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })

      let finished = false
      proc.exited.then(() => { finished = true }).catch(() => {})
      const timeout = timeoutMs
        ? new Promise<void>((resolve) => {
            setTimeout(() => {
              if (!finished) proc.kill()
              resolve()
            }, timeoutMs)
          })
        : undefined

      const [stdout] = await Promise.all([new Response(proc.stdout).text(), timeout ?? proc.exited])

      if (stdout) {
        output.metadata = output.metadata || {}
        const prev = output.metadata.hookOutput
        output.metadata.hookOutput = prev ? `${prev}\n${stdout}` : stdout
      }
    } catch {
      // Command errors are non-fatal
    }
  }
}

function convertHookHandler(
  handler: CodexHookHandler,
  addonRoot: string,
): ((input: any, output: any) => Promise<void>) | null {
  if (handler.type === "command") {
    return makeCommandRunner(handler.command, addonRoot, handler.timeout)
  }
  if (handler.type === "prompt") {
    console.warn('[addon] hook handler type "prompt" is not supported, skipping')
    return null
  }
  if (handler.type === "agent") {
    console.warn('[addon] hook handler type "agent" is not supported, skipping')
    return null
  }
  return null
}

function wrapWithMatcher(
  fn: (input: any, output: any) => Promise<void>,
  matcher: string | undefined,
): (input: any, output: any) => Promise<void> {
  if (!matcher) return fn
  let regex: RegExp | null
  try {
    regex = new RegExp(matcher)
  } catch {
    regex = null
  }
  return async (input: any, output: any) => {
    const toolName = typeof input?.tool === "string" ? input.tool : ""
    const matches = regex ? regex.test(toolName) : toolName === matcher
    if (matches) await fn(input, output)
  }
}

export function convertHooksFile(file: CodexHooksFile, addonRoot: string): AddonHooksResult {
  const eventHandlers = new Map<keyof Hooks, Array<(input: any, output: any) => Promise<void>>>()
  const unsupportedEvents: string[] = []

  for (const [codexEvent, matcherGroups] of Object.entries(file.hooks) as [keyof CodexHookEvents, CodexMatcherGroup[]][]) {
    if (!matcherGroups?.length) continue

    if (UNSUPPORTED_EVENTS.includes(codexEvent)) {
      console.warn(`[addon] codex hook event "${codexEvent}" has no opencode equivalent, skipping`)
      if (!unsupportedEvents.includes(codexEvent)) unsupportedEvents.push(codexEvent)
      continue
    }

    const opencodeEvent = SUPPORTED_EVENTS[codexEvent]
    if (!opencodeEvent) continue

    const handlers = eventHandlers.get(opencodeEvent) ?? []
    for (const group of matcherGroups) {
      for (const handler of group.hooks) {
        const fn = convertHookHandler(handler, addonRoot)
        if (fn) handlers.push(wrapWithMatcher(fn, group.matcher))
      }
    }
    if (handlers.length) eventHandlers.set(opencodeEvent, handlers)
  }

  const hooks: Partial<Hooks> = {}
  for (const [event, handlers] of eventHandlers) {
    ;(hooks as any)[event] = async (input: any, output: any) => {
      for (const fn of handlers) await fn(input, output)
    }
  }
  return { hooks, unsupportedEvents }
}

function inlineObjectToHooksFile(obj: HookInlineObject, addonRoot: string): CodexHooksFile {
  const scriptPath = path.resolve(addonRoot, obj.path)
  const events = obj.events?.length
    ? obj.events
    : (Object.keys(SUPPORTED_EVENTS) as (keyof CodexHookEvents)[])

  const hooksFile: CodexHooksFile = { hooks: {} }
  for (const event of events) {
    const group: CodexMatcherGroup = {
      matcher: obj.matcher,
      hooks: [{ type: "command", command: `'${scriptPath.replace(/'/g, "'\\''")}'` }],
    }
    const existing = hooksFile.hooks[event as keyof CodexHookEvents] ?? []
    ;(hooksFile.hooks as any)[event] = [...existing, group]
  }
  return hooksFile
}

export function mergeResults(a: AddonHooksResult, b: AddonHooksResult): AddonHooksResult {
  const merged: Partial<Hooks> = { ...a.hooks }
  for (const [key, fn] of Object.entries(b.hooks)) {
    const existing = (merged as any)[key]
    if (existing) {
      ;(merged as any)[key] = async (input: any, output: any) => {
        await existing(input, output)
        await (fn as any)(input, output)
      }
    } else {
      ;(merged as any)[key] = fn
    }
  }
  const unsupportedEvents = [...new Set([...a.unsupportedEvents, ...b.unsupportedEvents])]
  return { hooks: merged, unsupportedEvents }
}

async function loadHooksFile(addonRoot: string, filePath: string): Promise<AddonHooksResult | null> {
  try {
    const fullPath = path.resolve(addonRoot, filePath)
    const content = await readFile(fullPath, "utf-8")
    const parsed = JSON.parse(content) as CodexHooksFile
    return convertHooksFile(parsed, addonRoot)
  } catch (e) {
    console.warn(`[addon] failed to load hooks file "${filePath}":`, e)
    return null
  }
}

export async function loadAndConvertHooks(
  addonRoot: string,
  hooksField: unknown,
): Promise<AddonHooksResult | null> {
  if (!hooksField) return null

  // String: path to hooks.json file
  if (typeof hooksField === "string") {
    return loadHooksFile(addonRoot, hooksField)
  }

  // Array
  if (Array.isArray(hooksField)) {
    if (hooksField.length === 0) return null
    // string[]: multiple hooks file paths
    if (typeof hooksField[0] === "string") {
      let combined: AddonHooksResult = { hooks: {}, unsupportedEvents: [] }
      for (const p of hooksField as string[]) {
        const result = await loadHooksFile(addonRoot, p)
        if (result) combined = mergeResults(combined, result)
      }
      return combined
    }
    // HookInlineObject[]: array of inline hook definitions
    let combined: AddonHooksResult = { hooks: {}, unsupportedEvents: [] }
    for (const obj of hooksField as HookInlineObject[]) {
      if (obj && typeof obj === "object" && "path" in obj) {
        const file = inlineObjectToHooksFile(obj, addonRoot)
        const result = convertHooksFile(file, addonRoot)
        combined = mergeResults(combined, result)
      }
    }
    return combined
  }

  // Object: either CodexHooksFile ({hooks:{...}}) or HookInlineObject ({path:...})
  if (typeof hooksField === "object" && hooksField !== null) {
    if ("hooks" in hooksField) {
      return convertHooksFile(hooksField as CodexHooksFile, addonRoot)
    }
    if ("path" in hooksField) {
      const file = inlineObjectToHooksFile(hooksField as HookInlineObject, addonRoot)
      return convertHooksFile(file, addonRoot)
    }
  }

  return null
}
