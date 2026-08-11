# Plugin JSON sample spec

```json
{
  "name": "plugin-name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "keywords": ["keyword1", "keyword2"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "interface": {
    "displayName": "Plugin Display Name",
    "shortDescription": "Short description for subtitle",
    "longDescription": "Long description for details page",
    "developerName": "Local developer",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "websiteURL": "https://example.com/",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "Summarize my inbox and draft replies for me.",
      "Find open bugs and turn them into tickets.",
      "Review today's meetings and flag scheduling gaps."
    ],
    "brandColor": "#3B82F6",
    "composerIcon": "./assets/icon.svg",
    "logo": "./assets/logo.png",
    "screenshots": [
      "./assets/screenshot1.png",
      "./assets/screenshot2.png",
      "./assets/screenshot3.png"
    ],
    "defaultLocale": "en",
    "locales": {
      "zh-Hans": {
        "displayName": "插件显示名",
        "shortDescription": "简短副标题",
        "longDescription": "详情页较长描述"
      }
    }
  }
}
```

## Field guide

### Top-level fields

These are the fields wanlaicode reads from `plugin.json` (see `packages/addon/src/manifest.ts`):

- `name` (`string`): Plugin identifier (kebab-case, no spaces). Used as the manifest name and
  component namespace.
- `version` (`string`): Plugin semantic version.
- `description` (`string`): Short purpose summary.
- `keywords` (`array` of `string`): Search/discovery tags.
- `skills` (`string`): Relative path to skill directories/files.
- `mcpServers` (`string` or `object`): MCP config path, or an object whose keys are MCP server names
  and whose values are MCP server config objects.
- `apps` (`string`): App manifest path for plugin integrations.
- `composerIcon` (`string`): Top-level relative path to a small composer/chip icon (also accepted
  inside `interface`).
- `hooks` (`string`, `array`, or inline object): Hook config path(s). Paths must be relative and
  must not escape the plugin root.
- `interface` (`object`): Interface/UX metadata block for plugin presentation.

`mcpServers` may be declared as a companion file path:

```json
{
  "mcpServers": "./.mcp.json"
}
```

Or as an object directly in `plugin.json`:

```json
{
  "mcpServers": {
    "counter": {
      "type": "http",
      "url": "https://sample.example/counter/mcp"
    }
  }
}
```

### `interface` fields

These map to `AddonInterfaceInfo` in wanlaicode:

- `displayName` (`string`): User-facing title shown for the plugin.
- `shortDescription` (`string`): Brief subtitle used in compact views.
- `longDescription` (`string`): Longer description used on details screens.
- `developerName` (`string`): Human-readable publisher name.
- `category` (`string`): Plugin category bucket.
- `capabilities` (`array` of `string`): Capability list from implementation.
- `websiteURL` (`string`): Public website for the plugin.
- `privacyPolicyURL` (`string`): Privacy policy URL.
- `termsOfServiceURL` (`string`): Terms of service URL.
- `defaultPrompt` (`string` or `array` of `string`): Starter prompts shown in composer/UX context.
  - Include at most 3 strings. Entries after the first 3 are ignored and will not be included.
  - Each string is capped at 128 characters. Longer entries are truncated.
  - Prefer short starter prompts around 50 characters so they scan well in the UI.
- `brandColor` (`string`): Theme color for the plugin card (`#RRGGBB`).
- `composerIcon` (`string`): Path to a small composer/chip icon asset (often a single-color SVG).
- `logo` (`string`): Path to logo asset.
- `screenshots` (`array` of `string`): List of screenshot asset paths.
  - Screenshot entries must be PNG filenames and stored under `./assets/`.
  - Keep file paths relative to plugin root.
- `defaultLocale` (`string`, optional): BCP-47 locale declaring which language the **top-level**
  `interface` text (`displayName`/`shortDescription`/`longDescription`) is written in (e.g. `"en"`).
- `locales` (`object`, optional): BCP-47 locale → `{ displayName?, shortDescription?, longDescription? }`
  translations for **other** languages.

### Localization (wanlaicode-specific)

wanlaicode chooses the display text by negotiating the app's UI language against this manifest:

- The top-level `displayName`/`shortDescription`/`longDescription` are the **default-language** copy;
  `defaultLocale` says which language that is.
- `locales` holds the **non-default** translations, keyed by BCP-47 locale (e.g. `"zh-Hans"`,
  `"zh-Hant"`, `"ja"`). Each entry may override any of `displayName`/`shortDescription`/`longDescription`;
  omitted fields fall back to the top-level default.
- At runtime wanlaicode shows the entry matching the app locale, falling back to the top-level
  default when there is no match.

```json
"interface": {
  "displayName": "Plugin Display Name",
  "shortDescription": "Short subtitle",
  "defaultLocale": "en",
  "locales": {
    "zh-Hans": { "displayName": "插件显示名", "shortDescription": "简短副标题" },
    "ja": { "displayName": "プラグイン表示名" }
  }
}
```

### Path conventions and defaults

- Path values should be relative and begin with `./`.
- Absolute paths (`/…`, `~…`) and path traversal (`..`) are rejected.
- `skills`, `hooks`, and string-valued `mcpServers` are supplemented on top of default component
  discovery; they do not replace defaults.
- Custom path values must follow the plugin root convention and naming/namespacing rules.
- wanlaicode's scaffold writes `.wanlaicode-plugin/plugin.json`; treat that as the canonical manifest
  location. New plugins must use `.wanlaicode-plugin/`.

### Plugin validation notes

- The validator mirrors the wanlaicode plugin ingestion schema so generated plugins follow the same
  manifest contract from the start.
- Plugin manifests must include real values for `name`, `version`, `description`, and the required
  `interface` fields.
- `version` must use strict semver.
- `websiteURL`, `privacyPolicyURL`, and `termsOfServiceURL` must be absolute `https://` URLs when
  present.
- `composerIcon`, `logo`, and `screenshots` must point to real files inside the plugin directory
  when present.
- `apps` should appear in `plugin.json` only when `.app.json` actually exists.
- `mcpServers` may point to `.mcp.json` or contain the MCP server object directly in `plugin.json`.
- Run `scripts/validate_plugin.py <plugin-path>` before handing back a generated plugin. It adds one
  intentional preflight check that rejects leftover `[TODO: ...]` placeholders.

## Marketplace JSON sample spec

A marketplace file lists the plugins wanlaicode can install. The scaffold writes this to the
personal marketplace at `$XDG_DATA_HOME/wanlaicode/personal/.agents/plugins/marketplace.json`
by default (`~/.local/share/wanlaicode/...` when `XDG_DATA_HOME` is unset). Its parsed shape mirrors
`packages/addon/src/marketplace.ts`.

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "plugin-name",
      "source": {
        "source": "local",
        "path": "./plugins/plugin-name"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

### Marketplace fields

- `name` (`string`, required): Marketplace identifier. The default personal marketplace uses
  `"personal"` and is **auto-loaded** by wanlaicode from
  `$XDG_DATA_HOME/wanlaicode/personal` (`~/.local/share/wanlaicode/personal` when `XDG_DATA_HOME` is
  unset) — no `marketplace add` is needed; the user just refreshes the plugins page and installs from
  the **Personal** category. Non-default marketplace roots (repo/team paths, or a custom
  `--marketplace-name`) must still be registered once with
  `wanlaicode addon marketplace add <marketplace-root>` before wanlaicode can read their plugins.
- `interface` (`object`, optional): Marketplace presentation metadata. Currently only
  `interface.displayName` (`string`) is read.
- `plugins` (`array`, required): Ordered list of plugin entries. Order in `plugins[]` is treated as
  render order on the wanlaicode plugins page; append new entries rather than reordering unless the
  user asks.

### Marketplace plugin entry fields

- `name` (`string`, required): Must match the plugin's normalized `plugin.json` `name`.
- `source` (`object`, required): For local development use the `local` source:
  - `source` (`string`): `"local"`.
  - `path` (`string`): Relative path from the marketplace root to the plugin directory. Must start
    with `./`, stay inside the marketplace root (no `..`), and is conventionally
    `./plugins/<plugin-name>`.
- `policy` (`object`, required): Availability and auth gating.
  - `installation` (`string`): one of `NOT_AVAILABLE`, `AVAILABLE`, `INSTALLED_BY_DEFAULT`
    (default `AVAILABLE`).
  - `authentication` (`string`): one of `ON_INSTALL`, `ON_USE` (default `ON_INSTALL`).
  - `products` (`array` of `string`, optional): Product gating override. Omit unless the user
    explicitly requests it.
- `category` (`string`, optional): Plugin category bucket shown in the plugins page.
- `interface` (`object`, optional): Per-entry interface overrides; same shape as the plugin
  manifest `interface`.

### Marketplace validation notes

- A new marketplace file must include a non-empty top-level `name` before any plugin entry is added.
- Each generated entry must carry `policy.installation`, `policy.authentication`, and `category`,
  even when their values are the defaults.
- Keep `source.path` relative to the marketplace root (`./plugins/<plugin-name>`).
- Use `scripts/read_marketplace_name.py` to read the top-level marketplace `name` from any
  marketplace file when constructing install commands.
