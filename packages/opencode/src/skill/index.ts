import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { registerAddonCapabilityInvalidator } from "@/addon/capability-invalidation"
import { Flag, env } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { Glob } from "@opencode-ai/core/util/glob"
import * as Log from "@opencode-ai/core/util/log"
import { Discovery } from "./discovery"
import { Addon } from "@/addon"

const log = Log.create({ service: "skill" })
const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
const BUILTIN_LOCATION_PREFIX = "builtin:"
const PERSONAL_SKILLS_ADDON_KEY = "personal-skills@personal"
const PERSONAL_SKILL_INSTALL_MARKER = ".wanlaicode-installed"

const Source = Schema.Literals(["builtin", "global", "project", "config", "addon"])
export type Source = Schema.Schema.Type<typeof Source>

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  location: Schema.String,
  content: Schema.String,
  source: Schema.optional(Source),
  addonName: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const InvalidError = NamedError.create(
  "SkillInvalidError",
  z.object({
    path: z.string(),
    message: z.string().optional(),
    issues: z.custom<z.core.$ZodIssue[]>().optional(),
  }),
)

export const NameMismatchError = NamedError.create(
  "SkillNameMismatchError",
  z.object({
    path: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
)

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

const builtinSkills: Info[] = [
  {
    name: "imagegen",
    description: "Generate or edit images by using the image_generation tool when the user asks for visual output.",
    location: `${BUILTIN_LOCATION_PREFIX}imagegen`,
    // 技能页的“系统”分组依赖 builtin source 展示内置技能。
    source: "builtin",
    displayName: "Image Gen",
    content: [
      "Use the image_generation tool to make or edit images for this project.",
      "",
      "Call image_generation when the user asks to create a picture, poster, image card, infographic, visual asset, avatar, cover, wallpaper, product mockup, or any other image.",
      "Call image_generation when the user asks to modify, restyle, redraw, extend, or continue an uploaded or recent generated image.",
      "Loading this skill does not generate an image. After loading it for a real image request, immediately call image_generation with a concrete prompt.",
      "For vague follow-ups, read the conversation and pass a concrete image prompt plus compact context_text. Do not ask a separate classifier to decide.",
      "Do not treat bare punctuation or clarification follow-ups like ?, 什么意思, 啥情况, 怎么回事, or 'huh' as image generation. Answer those as normal chat.",
      "Use action=edit and recent images when the latest request points at an uploaded or previous image. Otherwise use action=generate.",
      "Do not use image_generation for normal chat, image analysis, coding, UI implementation, Mermaid diagrams, or requests asking about an image without creating or editing one.",
    ].join("\n"),
  },
]

export function isBuiltinLocation(location: string) {
  return location.startsWith(BUILTIN_LOCATION_PREFIX)
}

const formattedLocation = (location: string) => (isBuiltinLocation(location) ? location : pathToFileURL(location).href)

type DiscoveryState = {
  matches: { path: string; source: Info["source"] }[]
  dirs: string[]
}

type ScanState = {
  matches: Map<string, Source>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  readonly invalidate: () => Effect.Effect<void>
}

async function tryReadOpenAIYaml(skillDir: string): Promise<{ display_name?: string; icon_small?: string; icon_large?: string }> {
  const { readFile } = await import("fs/promises")
  // 优先读 wanlaicode 自有的 agents/wanlaicode.yaml;兼容外部 codex 插件的 openai.yaml。
  const candidates = [
    path.join(skillDir, "agents", "wanlaicode.yaml"),
    path.join(skillDir, "wanlaicode.yaml"),
    path.join(skillDir, "agents", "openai.yaml"),
    path.join(skillDir, "openai.yaml"),
  ]
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf-8")
      const result: { display_name?: string; icon_small?: string; icon_large?: string } = {}
      for (const line of text.split(/\r?\n/)) {
        const colonIdx = line.indexOf(":")
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim()
        if (!["display_name", "icon_small", "icon_large"].includes(key)) continue
        const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "")
        if (value) (result as Record<string, string>)[key] = value
      }
      return result
    } catch {
      // file not found, try next
    }
  }
  return {}
}

async function resolveIconDataUri(skillDir: string, iconRelPath: string): Promise<string | undefined> {
  const { readFile } = await import("fs/promises")
  const absPath = path.resolve(skillDir, iconRelPath)
  const ext = path.extname(absPath).toLowerCase()
  const mimeMap: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  }
  const mime = mimeMap[ext]
  if (!mime) return undefined
  try {
    const buf = await readFile(absPath)
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return undefined
  }
}

const add = Effect.fnUntraced(function* (state: State, match: string, source: Info["source"], bus: Bus.Interface) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return

  const parsed = z.object({ name: z.string(), description: z.string() }).safeParse(md.data)
  if (!parsed.success) return

  if (state.skills[parsed.data.name]) {
    if (source === "builtin") return // builtin 优先级最低,绝不覆盖已加载的其它来源
    log.warn("duplicate skill name", {
      name: parsed.data.name,
      existing: state.skills[parsed.data.name].location,
      duplicate: match,
    })
  }

  const skillDir = path.dirname(match)

  // Read optional openai.yaml for display_name and icon
  const openaiMeta = yield* Effect.tryPromise({
    try: () => tryReadOpenAIYaml(skillDir),
    catch: () => ({}),
  }).pipe(Effect.orElseSucceed(() => ({} as { display_name?: string; icon_small?: string; icon_large?: string })))

  const displayName = openaiMeta.display_name || undefined

  const iconRelPath = openaiMeta.icon_small || openaiMeta.icon_large
  const icon = iconRelPath
    ? yield* Effect.tryPromise({
        try: () => resolveIconDataUri(skillDir, iconRelPath),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    : undefined

  state.dirs.add(skillDir)
  state.skills[parsed.data.name] = {
    name: parsed.data.name,
    description: parsed.data.description,
    location: match,
    content: md.content,
    source,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(icon !== undefined ? { icon } : {}),
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts: { dot?: boolean; scope?: string; source: Source },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, { cwd: root, absolute: true, include: "file", symlink: true, dot: opts.dot }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches) {
    if (!state.matches.has(match)) state.matches.set(match, opts.source)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: AppFileSystem.Interface,
  global: Global.Interface,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Map(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!Flag.WANLAICODE_DISABLE_EXTERNAL_SKILLS) {
    if (!Flag.WANLAICODE_DISABLE_CLAUDE_CODE_SKILLS) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global", source: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project", source: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN, { source: "config" })
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    const directSkill = path.join(dir, "SKILL.md")
    if (yield* fsys.isFile(directSkill)) {
      if (!state.matches.has(directSkill)) state.matches.set(directSkill, "config")
      state.dirs.add(dir)
    }
    yield* scan(state, dir, SKILL_PATTERN, { source: "config" })
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN, { source: "config" })
    }
  }

  const personalSkillsRoot = path.join(global.data, "personal", "skills")
  if (yield* fsys.isDir(personalSkillsRoot)) {
    const disabledPersonalSkills = new Set(cfg.plugins?.[PERSONAL_SKILLS_ADDON_KEY]?.disabled_skills ?? [])
    const markers = yield* Effect.tryPromise({
      try: () =>
        Glob.scan(`*/${PERSONAL_SKILL_INSTALL_MARKER}`, {
          cwd: personalSkillsRoot,
          absolute: true,
          include: "file",
          dot: true,
        }),
      catch: (error) => error,
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => log.warn("failed to scan personal skills", { error }))),
      Effect.orElseSucceed(() => [] as string[]),
    )
    for (const marker of markers) {
      const skillDir = path.dirname(marker)
      const skillFile = path.join(skillDir, "SKILL.md")
      if (!(yield* fsys.isFile(skillFile))) continue
      const md = yield* Effect.tryPromise({
        try: () => ConfigMarkdown.parse(skillFile),
        catch: (error) => error,
      }).pipe(Effect.orElseSucceed(() => undefined))
      const parsed = z.object({ name: z.string() }).safeParse(md?.data)
      if (parsed.success && disabledPersonalSkills.has(parsed.data.name)) continue
      if (!state.matches.has(skillFile)) state.matches.set(skillFile, "global")
      state.dirs.add(skillDir)
    }
  }

  const builtinRoot = env("BUILTIN_SKILLS_DIR")
  const disableBuiltinRaw = env("DISABLE_BUILTIN_SKILLS")?.toLowerCase()
  const disableBuiltin = disableBuiltinRaw === "true" || disableBuiltinRaw === "1"
  if (builtinRoot && !disableBuiltin && (yield* fsys.isDir(builtinRoot))) {
    yield* scan(state, builtinRoot, SKILL_PATTERN, { source: "builtin" })
  }

  return {
    matches: Array.from(state.matches, ([p, source]) => ({ path: p, source })),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (state: State, discovered: DiscoveryState, bus: Bus.Interface) {
  const builtin = discovered.matches.filter((m) => m.source === "builtin")
  const others = discovered.matches.filter((m) => m.source !== "builtin")
  yield* Effect.forEach(others, (m) => add(state, m.path, m.source, bus), { concurrency: "unbounded", discard: true })
  yield* Effect.forEach(builtin, (m) => add(state, m.path, m.source, bus), { concurrency: "unbounded", discard: true })
  log.info("init", { count: Object.keys(state.skills).length })
})

const loadAddonSkills = Effect.fnUntraced(function* (state: State) {
  const addonOpt = yield* Effect.serviceOption(Addon.Service)
  if (Option.isNone(addonOpt)) return

  const addonSvc = addonOpt.value
  const addonSkills = yield* addonSvc.getSkills()

  let loaded = 0
  for (const { addonName, namespacedName, skill } of addonSkills) {
    if (state.skills[namespacedName]) {
      log.warn("duplicate addon skill name, keeping first", {
        name: namespacedName,
        existing: state.skills[namespacedName].location,
        duplicate: skill.location,
      })
      continue
    }

    state.skills[namespacedName] = {
      name: namespacedName,
      description: skill.description,
      location: skill.location,
      content: skill.content,
      source: "addon",
      addonName,
    }
    loaded++
  }

  log.info("addon skills loaded", { count: loaded, total: addonSkills.length })
})

const loadBuiltinSkills = Effect.fnUntraced(function* (state: State) {
  for (const item of builtinSkills) {
    // 用户或插件已经提供同名 skill 时，保留外部版本；内置版本只做兜底。
    if (state.skills[item.name]) continue
    state.skills[item.name] = item
  }
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(config, discovery, fsys, global, ctx.directory, ctx.worktree)
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        yield* loadSkills(s, yield* InstanceState.get(discovered), bus)
        yield* loadAddonSkills(s)
        yield* loadBuiltinSkills(s)
        return s
      }),
    )
    const unregisterInvalidator = registerAddonCapabilityInvalidator(() =>
      Effect.all([InstanceState.invalidateAll(discovered), InstanceState.invalidateAll(state)], { discard: true }),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregisterInvalidator))

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    // Drop the cached skill registry so the next read rebuilds it from disk +
    // addon skills (respecting the latest enabled/disabled config). Called when
    // an addon is toggled/installed so chat `/` skills reflect the change live.
    const invalidate = Effect.fn("Skill.invalidate")(function* () {
      yield* InstanceState.invalidate(discovered)
      yield* InstanceState.invalidate(state)
    })

    return Service.of({ get, all, dirs, available, invalidate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
)

export const appLayer = defaultLayer.pipe(Layer.provideMerge(Addon.defaultLayer))

export function fmt(list: Info[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          ...(skill.source ? [`    <source>${skill.source}</source>`] : []),
          ...(skill.source === "addon" && skill.addonName ? [`    <plugin>${skill.addonName}</plugin>`] : []),
          `    <location>${formattedLocation(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...list
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
