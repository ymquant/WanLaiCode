import { app } from "electron"
import log from "electron-log/main.js"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CHANNEL, type Channel } from "./constants"
import { getStore } from "./store"

const TAURI_MIGRATED_KEY = "tauriMigrated"

// Resolve the directory where Tauri stored its .dat files for the given app identifier.
// Mirrors Tauri's AppLocalData / AppData resolution per OS.
function tauriDir(id: string) {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", id)
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id)
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), id)
  }
}

// The Tauri app identifier changes between dev/beta/prod builds.
// canary 与 prod 是同一个 App，沿用 prod 的迁移路径。
const TAURI_APP_IDS: Record<Channel, string[]> = {
  dev: ["ai.wanlaicode.desktop.dev", "ai.opencode.desktop.dev"],
  beta: ["ai.wanlaicode.desktop.beta", "ai.opencode.desktop.beta"],
  prod: ["ai.wanlaicode.desktop", "ai.opencode.desktop"],
  canary: ["ai.wanlaicode.desktop", "ai.opencode.desktop"],
}
function tauriDirs() {
  const ids = app.isPackaged ? TAURI_APP_IDS[CHANNEL] : TAURI_APP_IDS.dev
  return ids.map((id) => tauriDir(id))
}

// Migrate a single Tauri .dat file into the corresponding electron-store.
// `wanlaicode.settings.dat` / `opencode.settings.dat` map to the `wanlaicode.settings` store.
// All other .dat files keep their full filename as the store name so they match what the
// renderer already passes via IPC (e.g. `"default.dat"`, `"wanlaicode.global.dat"`).
function migrateFile(datPath: string, filename: string) {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(readFileSync(datPath, "utf-8"))
  } catch (err) {
    log.warn("tauri migration: failed to parse", filename, err)
    return
  }

  // wanlaicode.settings.dat / opencode.settings.dat → the electron settings store ("wanlaicode.settings").
  // All other .dat files keep their full filename as the store name so they match
  // what the renderer passes via IPC (e.g. "default.dat", "wanlaicode.global.dat").
  const storeName =
    filename === "wanlaicode.settings.dat" || filename === "opencode.settings.dat" ? "wanlaicode.settings" : filename
  const target = getStore(storeName)
  const migrated: string[] = []
  const skipped: string[] = []

  for (const [key, value] of Object.entries(data)) {
    // Don't overwrite values the user has already set in the Electron app.
    if (target.has(key)) {
      skipped.push(key)
      continue
    }
    target.set(key, value)
    migrated.push(key)
  }

  log.log("tauri migration: migrated", filename, "→", storeName, { migrated, skipped })
}

function migrateLegacySettingsStore() {
  const target = getStore()
  const legacy = getStore("opencode.settings")
  const migrated: string[] = []
  const skipped: string[] = []

  for (const key of Object.keys(legacy.store)) {
    if (target.has(key)) {
      skipped.push(key)
      continue
    }
    target.set(key, legacy.get(key))
    migrated.push(key)
  }

  if (migrated.length) log.log("settings migration: opencode.settings → wanlaicode.settings", { migrated, skipped })
}

export function migrate() {
  if (getStore().get(TAURI_MIGRATED_KEY)) {
    log.log("tauri migration: already done, skipping")
    return
  }

  const dirs = tauriDirs().filter((dir) => existsSync(dir))
  log.log("tauri migration: starting", { dirs })

  for (const dir of dirs) {
    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith(".dat")) continue
      migrateFile(join(dir, filename), filename)
    }
  }

  migrateLegacySettingsStore()

  log.log("tauri migration: complete")
  getStore().set(TAURI_MIGRATED_KEY, true)
}
