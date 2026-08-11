---
name: skill-creator
description: Create or update WanlaiCode skills with a required SKILL.md, optional agents/wanlaicode.yaml interface metadata, and optional scripts, references, assets, examples, or templates. Use when WanlaiCode needs to scaffold a new local skill, adapt an existing Codex/OpenAI skill to WanlaiCode conventions, validate a skill folder, or add reusable resources for a skill workflow.
---

# Skill Creator

This skill creates standalone WanlaiCode skills. Keep plugins and skills separate:
plugins use `.wanlaicode-plugin/plugin.json`; skills are directories centered on `SKILL.md`.

> Path note: the default personal skill root lives under the wanlaicode data
> directory, at `$XDG_DATA_HOME/wanlaicode/personal` (root) - i.e.
> `~/.local/share/wanlaicode/personal` when `XDG_DATA_HOME` is unset, but on
> Desktop `XDG_DATA_HOME` points at the app's userData dir. The scaffold script
> resolves this from the environment, so rely on its defaults rather than
> hardcoding `~/.local/share`.

## Quick Start

1. Run the scaffold script from this skill root:

```bash
python3 scripts/init_skill.py <skill-name>
```

By default it creates
`$XDG_DATA_HOME/wanlaicode/personal/skills/<skill-name>` (or
`~/.local/share/wanlaicode/personal/skills/<skill-name>` when `XDG_DATA_HOME`
is unset).

Use `--path` only when the user asks for a repo, team, or test location:

```bash
python3 scripts/init_skill.py <skill-name> --path <skills-parent-directory>
```

2. Add only resource directories that are useful for the skill:

```bash
python3 scripts/init_skill.py my-skill --resources scripts,references,assets
```

Allowed resources are `scripts`, `references`, `assets`, `examples`, and
`templates`.

3. Edit the generated `SKILL.md`. Replace the placeholder description with a
specific trigger-oriented description. The description is the main trigger; put
when-to-use details there, not in a later body section.

4. Before handing back the skill, validate it:

```bash
python3 scripts/quick_validate.py <path/to/skill-folder>
```

## What this skill creates

- Default personal scaffolds use
  `$XDG_DATA_HOME/wanlaicode/personal/skills/<skill-name>`.
- Creates a skill root at `/<parent-skill-directory>/<skill-name>/`.
- Always creates `SKILL.md` and `agents/wanlaicode.yaml`.
- Supports optional creation of `scripts/`, `references/`, `assets/`,
  `examples/`, and `templates/`.

## WanlaiCode Metadata

Prefer WanlaiCode metadata at `agents/wanlaicode.yaml`:

```yaml
interface:
  display_name: "Skill Creator"
  short_description: "Create WanlaiCode skills"
  icon_small: "./assets/skill-creator.svg"
```

Use `agents/openai.yaml` only when preserving compatibility with an upstream
Codex/OpenAI skill. WanlaiCode loaders read `agents/wanlaicode.yaml` first and
fall back to `agents/openai.yaml`.

## Skill Shape

Every skill must have:

- `SKILL.md` with YAML frontmatter containing only `name` and `description`
  unless an existing runtime explicitly supports more.
- A folder name matching the normalized skill name.
- A lowercase hyphen-case name using only letters, digits, and hyphens.

Optional directories:

- `scripts/` for deterministic executable helpers.
- `references/` for detailed documentation that Codex should load only when
  needed.
- `assets/` for files used as output inputs, such as icons, templates, images,
  or boilerplate.
- `examples/` for compact sample prompts or expected output artifacts when they
  materially help validation.
- `templates/` for reusable artifact skeletons.

Do not create README, installation guide, changelog, or other auxiliary docs
unless the user explicitly asks. Keep instructions in `SKILL.md` and move bulky
variant-specific material into directly linked files under `references/`.

## Writing Guidance

- Keep `SKILL.md` concise and imperative.
- Include only non-obvious procedural knowledge, domain constraints, and
  resource routing.
- Prefer concrete examples over long explanations.
- Put detailed APIs, schemas, or policy material in `references/`.
- Add scripts when the same code would otherwise be rewritten repeatedly or the
  workflow is fragile.
- Test any script added to a skill by running it.
- Remove placeholder files when they are not needed.

## Updating Existing Skills

When adapting an existing Codex/OpenAI skill:

1. Preserve the workflow and useful resources.
2. Rename `agents/openai.yaml` to `agents/wanlaicode.yaml` only when the skill is
   becoming WanlaiCode-specific; otherwise keep both if compatibility matters.
3. Replace product names, default paths, and CLI examples with WanlaiCode
   equivalents.
4. Validate with `scripts/quick_validate.py`.

## Validation Checklist

- `SKILL.md` exists and parses.
- Frontmatter has `name` and `description`.
- Name is lowercase hyphen-case and no longer than 64 characters.
- Description explains both what the skill does and when to use it.
- `agents/wanlaicode.yaml` is valid enough for the current loader: quoted string
  values under `interface`.
- Optional directories contain real useful content, not stale placeholders.
