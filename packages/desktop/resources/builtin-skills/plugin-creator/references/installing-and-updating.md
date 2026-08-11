# Installing and Updating Local Plugins

Use this reference when a plugin already exists and the request is about installing it into
wanlaicode or updating it during local development.

All scripts here are specified relative to the skill root. Update the path when running from a
different working directory.

## Installing a Scaffolded Plugin

A scaffolded plugin is installed through a marketplace entry, then installed from the wanlaicode
plugins page.

> Path note: the default personal marketplace lives at `$XDG_DATA_HOME/wanlaicode/personal` (root).
> The `~/.local/share/wanlaicode/...` paths below are the shorthand for when `XDG_DATA_HOME` is
> unset; on Desktop `XDG_DATA_HOME` points at the app userData dir. The scaffold script resolves
> this from the environment — rely on its defaults rather than hardcoding `~/.local/share`.

1. After scaffolding and validating the plugin, confirm the marketplace entry exists. By default the
   scaffold writes the plugin to `~/.local/share/wanlaicode/personal/plugins/<plugin-name>/`
   and adds a `local` entry pointing at `./plugins/<plugin-name>` inside the personal marketplace
   file at `~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`.

2. Make the marketplace visible to wanlaicode:

   - **Default personal marketplace** (`~/.local/share/wanlaicode/personal/.agents/plugins/marketplace.json`):
     no action needed. wanlaicode auto-loads this marketplace from the data directory, so the entry
     appears automatically after a plugins-page refresh.

   - **Non-default marketplace** (a repo/team path, or a marketplace created with
     `--marketplace-name`): register its root once so wanlaicode can read its plugins:

     ```bash
     wanlaicode addon marketplace add <marketplace-root>
     ```

     `<marketplace-root>` is the directory that contains `.agents/plugins/marketplace.json`, not the
     JSON file itself. Verify it was added:

     ```bash
     wanlaicode addon marketplace list
     ```

3. Open the wanlaicode app's plugins page (refresh it). For the default personal marketplace the
   plugin appears under the **Personal** category; for other marketplaces it appears under that
   marketplace's source. Click **Install** on the plugin.

   The equivalent CLI install is:

   ```bash
   # Default personal marketplace (auto-loaded, no `marketplace add` needed):
   wanlaicode addon install <plugin-name>

   # Non-default marketplace, addressed by `<plugin>@<marketplace-name>`:
   wanlaicode addon install <plugin-name>@<marketplace-name>
   ```

   Use `scripts/read_marketplace_name.py --marketplace-path <path>` to read `<marketplace-name>` when
   constructing a non-default install command.

4. Start a new wanlaicode session so it picks up the newly installed plugin's skills and tools.

5. List installed addons to confirm:

   ```bash
   wanlaicode addon list
   ```

## Update Loop

Use this flow when the plugin already exists locally and its marketplace entry is already in place.

1. Edit the local plugin files in place (manifest, skills, scripts, MCP/app companion files). The
   marketplace `local` source points back at the plugin directory, so no marketplace edit is needed
   for content changes.

2. Reinstall the plugin so wanlaicode re-reads the updated files. From the plugins page, reinstall
   the entry, or via the CLI:

   ```bash
   wanlaicode addon uninstall <plugin-name>
   wanlaicode addon install <plugin-name>
   ```

3. Start a new session so wanlaicode loads the updated plugin. A fresh session is the safe boundary;
   wanlaicode does not hot-reload installed plugins mid-session.

## After Installing

After the plugin is installed and a new session is started, its skills and MCP tools are available
immediately. Prompt the user to start a new session whenever they install or update plugin content.
