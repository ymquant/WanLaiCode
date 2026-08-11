import { expect, test } from "bun:test"
import { matchesKeybindSearch } from "./settings-keybinds-search"

test("matches every configured shortcut", () => {
  expect(matchesKeybindSearch("mod+k,mod+p", "mod+p")).toBe(true)
  expect(matchesKeybindSearch("mod+k,mod+p", "mod+shift+p")).toBe(false)
})
