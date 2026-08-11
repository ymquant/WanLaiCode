---
name: plugin-creator
description: Create and scaffold plugin directories for wanlaicode with a required `.wanlaicode-plugin/plugin.json`, optional plugin folders/files, valid manifest defaults, and a local marketplace entry by default. Use when wanlaicode needs to create a new local plugin (addon), add optional plugin structure, generate or update marketplace entries for plugin ordering and availability metadata, or update an existing local plugin during development so the user can install it from the wanlaicode plugins page.
---

# Plugin Creator

This skill scaffolds the plugin body **and** writes a local `marketplace.json` entry pointing at it.
For the **default personal marketplace**, wanlaicode auto-loads it — the user just refreshes the
plugins page and installs from the **Personal** category, no `marketplace add` needed. For a
**non-default** marketplace (repo/team path or a custom `--marketplace-name`), the user registers it
once with `wanlaicode addon marketplace add <marketplace-root>` before installing.

> Path note: the default personal marketplace lives under the wanlaicode data directory, at
> `$XDG_DATA_HOME/wanlaicode/personal` (root) — i.e. `~/.local/share/wanlaicode/personal` when
> `XDG_DATA_HOME` is unset, but on Desktop `XDG_DATA_HOME` points at the app's userData dir. The
> scaffold script resolves this from the environment, so always rely on its defaults rather than
> hardcoding `~/.local/share`. All `~/.local/share/wanlaicode/...` paths below are the unset-env
> shorthand for `$XDG_DATA_HOME/wanlaicode/...`.

## Quick Start

1. Run the scaffold script:

```bash
# Plugin names are normalized to lower-case hyphen-case and must be <= 64 chars.
# The generated folder and plugin.json name are always the same.
# Run from the skill root (the directory containing this `SKILL.md`).
# By default creates in `~/.local/share/wanlaicode/personal/plugins/<plugin-name>`.
python3 scripts/create_basic_plugin.py <plugin-name>
```

2. Edit `<plugin-path>/.wanlaicode-plugin/plugin.json` when the request gives specific metadata.
   The scaffold starts with valid defaults and must not contain `[TODO: ...]` placeholders.

3. Generate or update the personal marketplace entry so the plugin appears on the wanlaicode
   plugins page:

```bash
# Personal marketplace entries default to `~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`.
python3 scripts/create_basic_plugin.py my-plugin --with-marketplace
```

Only specify `--marketplace-name <name>` when the default `personal` marketplace name is already
taken or installed and you need to seed a different new marketplace file:

```bash
python3 scripts/create_basic_plugin.py my-plugin \
  --with-marketplace \
  --marketplace-name team-local
```

Only use a repo/team marketplace when the user specifically asks for that destination:

```bash
python3 scripts/create_basic_plugin.py my-plugin \
  --path <repo-root>/plugins \
  --marketplace-path <repo-root>/.agents/plugins/marketplace.json \
  --with-marketplace
```

The **default personal marketplace**
(`~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`) is auto-loaded by
wanlaicode — once the scaffold writes the entry, the user only refreshes the plugins page and the
plugin appears under the **Personal** category. No `marketplace add` is required.

For a **non-default** marketplace path (repo/team or `--marketplace-name`), make sure that
marketplace is actually registered with `wanlaicode addon marketplace add <marketplace-root>` before
telling the user to install from it. On Windows, use the equivalent path under the user profile.

4. Generate/adjust optional companion folders as needed:

```bash
python3 scripts/create_basic_plugin.py my-plugin \
  --path <parent-plugin-directory> \
  --marketplace-path <marketplace-json-path> \
  --with-skills --with-hooks --with-scripts --with-assets --with-mcp --with-apps --with-marketplace
```

`<parent-plugin-directory>` is the directory where the plugin folder `<plugin-name>` will be
created (for example `~/.local/share/wanlaicode/personal/plugins`).

5. Before handing back a generated plugin, run:

```bash
python3 scripts/validate_plugin.py <plugin-path>
```

See `references/installing-and-updating.md` for the install flow (registering a non-default
marketplace, installing from the wanlaicode plugins page) and the update loop while iterating on an
existing local plugin.

## What this skill creates

- Default marketplace-backed scaffolds use the personal marketplace file at
  `~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`, with plugins generally being stored in
  `~/.local/share/wanlaicode/personal/plugins/<plugin-name>/`.
- Creates plugin root at `/<parent-plugin-directory>/<plugin-name>/`.
- Always creates `/<parent-plugin-directory>/<plugin-name>/.wanlaicode-plugin/plugin.json`.
- Fills the manifest with the validated schema shape that the ingestion path accepts.
- Creates or updates `~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json` when `--with-marketplace` is set.
  - If the marketplace file does not exist yet, seed a personal marketplace root before adding the first plugin entry.
- `<plugin-name>` is normalized using plugin naming rules:
  - `My Plugin` → `my-plugin`
  - `My--Plugin` → `my-plugin`
  - underscores, spaces, and punctuation are converted to `-`
  - result is lower-case hyphen-delimited with consecutive hyphens collapsed
- Supports optional creation of:
  - `skills/`
  - `hooks/`
  - `scripts/`
  - `assets/`
  - `.mcp.json`
  - `.app.json`

## Marketplace workflow

- Personal-marketplace creation defaults to `~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`. Here,
  "personal marketplace" means the marketplace whose file is at that path.
- Repo/team marketplace creation is opt-in through both `--path` and `--marketplace-path`, only
  when the user specifically requests it.
- `--marketplace-name` is an exception path. Use it only when the default `personal` marketplace
  name is already taken and you need to seed a different new marketplace file.
- Do not use `--marketplace-name` to rename an existing marketplace file in place. If the file
  already exists, its top-level `name` must already match.
- If the user specifies a different marketplace path, treat that marketplace as needing explicit
  registration via `wanlaicode addon marketplace add <marketplace-root>`.
- Prefer `scripts/read_marketplace_name.py` when you need the marketplace name from any
  `marketplace.json` file. With no argument it reads the default personal marketplace; with an
  explicit path it works for repo/team marketplaces too.
- In either location, the generated source path remains `./plugins/<plugin-name>`.
- Marketplace root metadata supports top-level `name` plus optional `interface.displayName`.
- Treat plugin order in `plugins[]` as render order in wanlaicode. Append new entries unless a user explicitly asks to reorder the list.
- `displayName` belongs inside the marketplace `interface` object, not individual `plugins[]` entries.
- Each generated marketplace entry must include all of:
  - `policy.installation`
  - `policy.authentication`
  - `category`
- Default new entries to:
  - `policy.installation: "AVAILABLE"`
  - `policy.authentication: "ON_INSTALL"`
- Override defaults only when the user explicitly specifies another allowed value.
- Allowed `policy.installation` values:
  - `NOT_AVAILABLE`
  - `AVAILABLE`
  - `INSTALLED_BY_DEFAULT`
- Allowed `policy.authentication` values:
  - `ON_INSTALL`
  - `ON_USE`
- Treat `policy.products` as an override. Omit it unless the user explicitly requests product gating.
- The generated plugin entry shape is:

```json
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
```

- Use `--force` only when intentionally replacing an existing marketplace entry for the same plugin name.
- If the target marketplace file does not exist yet, create it with top-level `"name"`, an `"interface"` object containing `"displayName"`, and a `plugins` array, then add the new entry.

- For a brand-new marketplace file, the root object should look like:

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

## Installing a scaffolded plugin

After scaffolding (and validating) a marketplace-backed plugin, the user installs it from the
wanlaicode app's plugins page.

1. **Registration depends on which marketplace**:

   - **Default personal marketplace**
     (`~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`): no registration
     needed. wanlaicode auto-loads this marketplace from the data directory, so the entry shows up
     automatically after a plugins-page refresh.

   - **Non-default marketplace file** (repo/team path, or a `--marketplace-name` file): register the
     marketplace root once so wanlaicode can read its plugins:

     ```bash
     wanlaicode addon marketplace add <marketplace-root>
     ```

   `<marketplace-root>` is the directory that contains `.agents/plugins/marketplace.json` (not the
   JSON file itself). Use `scripts/read_marketplace_name.py --marketplace-path <path>` to read the
   marketplace name when you need to reference it.

2. Open the wanlaicode plugins page (refresh it). For the default personal marketplace the new entry
   appears under the **Personal** category; the user clicks **Install**.
   The equivalent CLI is `wanlaicode addon install <plugin-name>` or
   `wanlaicode addon install <plugin-name>@<marketplace-name>` for a non-default marketplace —
   prefer pointing the user at the plugins page unless they ask for the CLI.

3. Prompt the user to start a new session after install so wanlaicode picks up the plugin's skills
   and tools.

## Required behavior

- Outer folder name and `plugin.json` `"name"` are always the same normalized plugin name.
- Do not remove required structure; keep `.wanlaicode-plugin/plugin.json` present.
- Do not leave `[TODO: ...]` placeholders in plugin manifests.
- Keep `apps` and `mcpServers` out of `plugin.json` unless their companion files are actually created.
- Omit unsupported plugin manifest fields that validation rejects.
- If creating files inside an existing plugin path, use `--force` only when overwrite is intentional.
- Preserve any existing marketplace `interface.displayName`.
- When generating marketplace entries, always write `policy.installation`, `policy.authentication`, and `category` even if their values are defaults.
- Add `policy.products` only when the user explicitly asks for that override.
- Keep marketplace `source.path` relative to the selected marketplace root as `./plugins/<plugin-name>`.
- Only use `--marketplace-name` when creating a new marketplace file whose name should not be
  `personal` because that name is already taken or installed elsewhere.
- If wanlaicode would need approval to write the marketplace file, ask for that approval before
  proceeding. If the user prefers to run the write themselves, provide the exact scaffold command
  and then continue from validation or subsequent plugin edits instead of leaving the workflow
  vague.
- For updates to an existing local plugin during development, edit the local plugin files directly
  and reinstall it from the plugins page (or via the CLI). Use the update flow documented in
  `references/installing-and-updating.md`.
- For the **default personal marketplace**
  (`~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`), do NOT instruct a
  `marketplace add` — wanlaicode auto-loads it. Tell the user to refresh the plugins page and
  install from the **Personal** category. (`marketplace add` still works but is unnecessary.)
- If the user provided a non-default `--marketplace-path`, make sure that marketplace is registered
  before giving install instructions. Use `wanlaicode addon marketplace add <marketplace-root>`
  when that explicit marketplace has not been configured yet.

## Reference to exact spec sample

For the exact canonical sample JSON for both plugin manifests and marketplace entries, use:

- `references/plugin-json-spec.md`
- `references/installing-and-updating.md` for install/update guidance while
  iterating on an existing local plugin, plus the new-session pickup behavior after install

## Validation

Before handing back a generated plugin, run:

```bash
python3 scripts/validate_plugin.py <plugin-path>
```
