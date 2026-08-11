import type { LoadedAddon } from "@opencode-ai/addon"
import { addonKey, addonSkillPrefix, parseAddonKey } from "@opencode-ai/addon"
import { parsePluginMentionKeys } from "@opencode-ai/core/util/mention"

// 从文本里抽出所有被 @ 的插件 addonKey（<addonName>@<marketplaceName>），保持出现顺序、去重。
// 解析委托 @opencode-ai/core 的单一来源:必须是完整 [@name](plugin://addonKey) 链接形态,
// 正文里裸 (plugin://x) 不再被误判为提及。
export function parsePluginMentions(text: string): string[] {
  return parsePluginMentionKeys(text)
}

// 把一个被 @ 的已加载插件渲染成给模型看的能力说明块。只渲染存在的字段；
// 即便能力全空也保留首尾身份行，保证模型至少知道「该插件被引用且存在」。
export function renderPluginCapabilities(loaded: LoadedAddon): string {
  const info = loaded.manifest.interfaceInfo
  const displayName = info?.displayName?.trim() || loaded.manifest.name
  const lines: string[] = [`Capabilities from the \`${displayName}\` plugin:`]

  const description = info?.longDescription?.trim() || info?.shortDescription?.trim() || loaded.manifest.description?.trim()
  if (description) lines.push(description)

  if (loaded.skills && loaded.skills.length > 0) {
    lines.push(`- Skills from this plugin are prefixed with \`${addonSkillPrefix(loaded.addonId)}:\`.`)
  }

  const servers = loaded.mcpServers ? Object.keys(loaded.mcpServers) : []
  if (servers.length > 0) {
    lines.push(
      `- MCP servers this plugin provides: ${servers
        .map((s) => `\`${s}\``)
        .join(", ")}.`,
    )
  }

  const prompts = info?.defaultPrompt?.filter((p) => p.trim()) ?? []
  if (prompts.length > 0) {
    lines.push(`Suggested prompts: ${prompts.join("; ")}`)
  }

  lines.push(
    "- If using this plugin is blocked by a missing local dependency (e.g. Node.js, npm, or the plugin's own CLI), do not just report the problem and wait. Tell the user exactly what is missing, ask whether they would like you to install it, and run the installation once they agree.",
  )
  lines.push("Use these plugin-associated capabilities to help solve the task.")
  return lines.join("\n")
}

// 纯决策：给定已解析出的 mention addonKey 列表 + 已加载 addon 列表，返回应注入的能力块文本；
// 无 mention / 无命中（未装或 disabled）时返回 null。mention 解析由调用方先做(parsePluginMentions)，
// 避免重复解析、并让调用方走零开销快路径（无 mention 时不触碰 Addon service）。
export function buildCapabilityText(mentionKeys: string[], addons: LoadedAddon[]): string | null {
  if (mentionKeys.length === 0) return null
  const enabled = addons.filter((a) => !a.disabled)
  const matched = mentionKeys.flatMap((key) => {
    const exact = enabled.find((a) => addonKey(a.addonId) === key)
    if (exact) return [exact]

    const parsed = (() => {
      try {
        return parseAddonKey(key)
      } catch {
        return undefined
      }
    })()
    if (!parsed) return []

    const candidates = enabled.filter(
      (a) =>
        a.addonId.addonName === parsed.addonName &&
        a.addonId.marketplaceName === parsed.marketplaceName &&
        (!parsed.registryNamespace || a.addonId.registryNamespace === parsed.registryNamespace),
    )
    return candidates.length === 1 ? candidates : []
  })
  const unique = Array.from(new Map(matched.map((a) => [addonKey(a.addonId), a])).values())
  if (unique.length === 0) return null
  return unique.map(renderPluginCapabilities).join("\n\n")
}
