import { parseKeybind } from "@/context/command"

export function keybindSignatures(config: string | undefined) {
  if (!config) return []

  return parseKeybind(config)
    .map((keybind) => {
      const parts: string[] = []
      if (keybind.ctrl) parts.push("ctrl")
      if (keybind.alt) parts.push("alt")
      if (keybind.shift) parts.push("shift")
      if (keybind.meta) parts.push("meta")
      if (keybind.key) parts.push(keybind.key)
      return parts.join("+")
    })
    .filter(Boolean)
}

export function matchesKeybindSearch(config: string | undefined, search: string | undefined) {
  const target = new Set(keybindSignatures(search))
  return keybindSignatures(config).some((signature) => target.has(signature))
}
