# @opencode-ai/addon

Codex-compatible addon loader for opencode. Reads `.codex-plugin/plugin.json`
manifests (and `.claude-plugin/plugin.json` as a fallback) and exposes their
MCP servers, skills and hooks to opencode without rewriting them.

## Layout

opencode looks for addons in two roots, in order:

1. `~/.codex/plugins/cache/<marketplace>/<addon>/<version>/` — Codex's own
   cache (read-only compatibility).
2. `<opencode-data>/addons/cache/<marketplace>/<addon>/<version>/` — written
   by `opencode addon install`.

Extra paths can be added via `addon.paths` in `opencode.json`.

A single addon directory must contain a manifest at one of:

- `<root>/.codex-plugin/plugin.json` (preferred)
- `<root>/.claude-plugin/plugin.json` (fallback)

## Marketplace

A marketplace is a Git repository (or local directory) that holds a
`marketplace.json` manifest listing installable addons. The standard layout is:

```
<marketplace-root>/
  .agents/plugins/marketplace.json   # or .claude-plugin/marketplace.json
  plugins/
    hello/
      .codex-plugin/plugin.json
      .mcp.json
      hooks.json
      skills/...
```

`opencode addon marketplace add <source>` clones the marketplace into
`<opencode-data>/marketplaces/<name>/` and writes its config to
`opencode.json` under `marketplaces.<name>`. The plugins listed in
`marketplace.json` are **not** auto-loaded; they must be materialized into the
addon cache via `opencode addon install`.

Sources:

- `https://github.com/owner/repo[.git]` (sparse-checkout supported)
- `git@host:owner/repo.git`
- `owner/repo` shorthand → `https://github.com/owner/repo.git`
- absolute path / `./relative` / `file://` → local source

## Skill namespacing

Skills loaded from an addon are exposed in `Skill.Service` with their name
prefixed by the addon name: `<addon>:<skill-name>`. This matches Codex's
`namespaced_skill_name` so prompts written for one work in the other. User-home
skills keep their bare names.

## Hooks

The following Codex hook events are mapped to opencode events:

| Codex event           | opencode event                   |
| --------------------- | -------------------------------- |
| `PreToolUse`          | `tool.execute.before`            |
| `PostToolUse`         | `tool.execute.after`             |
| `PermissionRequest`   | `permission.ask`                 |
| `UserPromptSubmit`    | `command.execute.before`         |

`SessionStart` and `Stop` have no opencode equivalent and are skipped with a
warning. `prompt` and `agent` handler types are also skipped (v2).

## Configuration

`opencode.json` recognizes three top-level fields. Field names are kept in
Codex's `snake_case` for full config compatibility with the Codex CLI.

### `addon`

```json
{
  "addon": {
    "enabled": true,
    "paths": ["/extra/addons", "~/dev/my-addons"]
  }
}
```

### `plugins."<addon>@<marketplace>"`

Per-addon overrides, mirroring Codex's `[plugins.X]` section.

```json
{
  "plugins": {
    "hello@codex-curated": {
      "enabled": true,
      "mcp_servers": {
        "echo": {
          "enabled": true,
          "default_tools_approval_mode": "prompt",
          "enabled_tools": ["echo.run"],
          "disabled_tools": [],
          "tools": {
            "echo.run": { "approval": "auto" }
          }
        }
      }
    }
  }
}
```

`enabled: false` disables the addon entirely (skills, MCP servers, hooks all
turned off). Per-MCP-server `enabled: false` keeps the entry visible in
`/addon` but stops it from registering with `MCP.Service`.

### `marketplaces.<name>`

```json
{
  "marketplaces": {
    "codex-curated": {
      "source_type": "git",
      "source": "https://github.com/openai/codex-curated.git",
      "ref": "main",
      "sparse_paths": ["plugins/hello"],
      "last_revision": "abcdef1234567890",
      "last_updated": "2025-05-09T14:30:00Z"
    },
    "local-dev": {
      "source_type": "local",
      "source": "/abs/path/to/marketplace"
    }
  }
}
```

`last_revision` and `last_updated` are filled by
`opencode addon marketplace add/upgrade`. Hand-editing them is allowed but not
required.

## CLI

```
opencode addon paths                          # list addon search paths
opencode addon list                           # list loaded addons
opencode addon info <addon>@<marketplace>     # show manifest details
opencode addon install <addon>@<marketplace>  # materialize from marketplace
opencode addon uninstall <addon>@<marketplace>

opencode addon marketplace list
opencode addon marketplace info <name>
opencode addon marketplace add <source> [--ref REF] [--sparse PATH ...]
opencode addon marketplace upgrade [<name>]
opencode addon marketplace remove <name>
```

## HTTP API

The same operations are exposed over HTTP under `/addon` (always available,
not gated by `OPENCODE_EXPERIMENTAL_HTTPAPI`):

- `GET /addon` — list of `Addon.Info`
- `GET /addon/:key` — `Addon.Detail` for `<addon>@<marketplace>`
- `POST /addon/install` — body `{ "addon_key": "<addon>@<marketplace>" }`
- `POST /addon/uninstall` — body `{ "addon_key": "<addon>@<marketplace>" }`

The TUI `/addon` command and the desktop addon dialog both consume these
endpoints through the generated SDK.

## Known limitations (v1)

- `policy.authentication: "ON_INSTALL"` is surfaced via `outcome.auth_policy`
  but no OAuth flow is triggered. Tokens have to be provided manually
  through env vars or `mcp_servers.<server>.env_http_headers`.
- `default_tools_approval_mode` is recorded but not yet enforced in the
  permission layer.
- `prompt` and `agent` hook handler types are skipped.
- Versions are compared lexicographically (matches Codex behavior).

See [`codex-plugin-plan.md`](../../codex-plugin-plan.md) for the full design
and v2 follow-ups.
