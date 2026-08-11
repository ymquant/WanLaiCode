#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_RESOURCES = {"scripts", "references", "assets", "examples", "templates"}


def _xdg_data_home():
    env = os.environ.get("XDG_DATA_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".local" / "share"


DEFAULT_LOCAL_SKILL_ROOT = _xdg_data_home() / "wanlaicode" / "personal"
DEFAULT_SKILL_PARENT = DEFAULT_LOCAL_SKILL_ROOT / "skills"

SKILL_TEMPLATE = """---
name: {name}
description: [TODO: Explain what this skill does and when WanlaiCode should use it. Include concrete trigger contexts.]
---

# {title}

## Overview

[TODO: Describe the workflow this skill enables in 1-2 sentences.]

## Workflow

[TODO: Add concise imperative instructions for using the skill.]

## Resources

[TODO: List any scripts, references, assets, examples, or templates that should be loaded or used, and when.]
"""


def normalize_name(raw):
    normalized = re.sub(r"[^a-z0-9]+", "-", raw.strip().lower()).strip("-")
    return re.sub(r"-{2,}", "-", normalized)


def title_from_name(name):
    return " ".join(part.capitalize() for part in name.split("-"))


def yaml_quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def parse_resources(raw):
    if not raw:
        return []
    resources = [item.strip() for item in raw.split(",") if item.strip()]
    invalid = sorted(set(resources) - ALLOWED_RESOURCES)
    if invalid:
        print(f"[ERROR] Unknown resource type(s): {', '.join(invalid)}")
        print(f"[ERROR] Allowed: {', '.join(sorted(ALLOWED_RESOURCES))}")
        sys.exit(1)
    return list(dict.fromkeys(resources))


def write_interface(skill_dir, name, display_name, short_description, default_prompt):
    agents_dir = skill_dir / "agents"
    agents_dir.mkdir(exist_ok=True)
    (agents_dir / "wanlaicode.yaml").write_text(
        "\n".join(
            [
                "interface:",
                f"  display_name: {yaml_quote(display_name)}",
                f"  short_description: {yaml_quote(short_description)}",
                f"  default_prompt: {yaml_quote(default_prompt or f'Use ${name} to help with this task.')}",
            ],
        )
        + "\n",
    )


def create_placeholders(skill_dir, resources, include_examples):
    for resource in resources:
        resource_dir = skill_dir / resource
        resource_dir.mkdir(exist_ok=True)
        if not include_examples:
            print(f"[OK] Created {resource}/")
            continue
        if resource == "scripts":
            example = resource_dir / "example.py"
            example.write_text("#!/usr/bin/env python3\nprint('Replace this helper or delete it.')\n")
            example.chmod(0o755)
            print("[OK] Created scripts/example.py")
            continue
        (resource_dir / "placeholder.txt").write_text("Replace this placeholder or delete it.\n")
        print(f"[OK] Created {resource}/placeholder.txt")


def main():
    parser = argparse.ArgumentParser(description="Create a WanlaiCode skill directory.")
    parser.add_argument("skill_name", nargs="+", help="Skill name, normalized to lowercase hyphen-case")
    parser.add_argument(
        "--path",
        default=str(DEFAULT_SKILL_PARENT),
        help=(
            "Parent directory for skill creation (defaults to "
            "$XDG_DATA_HOME/wanlaicode/personal/skills, i.e. "
            "~/.local/share/wanlaicode/personal/skills when XDG_DATA_HOME is unset). "
            "Pass an explicit repo/team path only when that destination is intended."
        ),
    )
    parser.add_argument("--resources", help="Comma-separated resources: scripts,references,assets,examples,templates")
    parser.add_argument("--examples", action="store_true", help="Create small placeholder files in resource directories")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing skill scaffold")
    parser.add_argument("--display-name", help="agents/wanlaicode.yaml interface display name")
    parser.add_argument("--short-description", help="agents/wanlaicode.yaml interface short description")
    parser.add_argument("--default-prompt", help="agents/wanlaicode.yaml interface default prompt")
    args = parser.parse_args()

    name = normalize_name(" ".join(args.skill_name))
    if not name:
        print("[ERROR] Skill name is empty after normalization.")
        sys.exit(1)
    if len(name) > MAX_SKILL_NAME_LENGTH:
        print(f"[ERROR] Skill name is too long ({len(name)} characters). Maximum is {MAX_SKILL_NAME_LENGTH}.")
        sys.exit(1)

    skill_dir = Path(os.path.expanduser(args.path)).resolve() / name
    if skill_dir.exists() and not args.force:
        print(f"[ERROR] Skill already exists: {skill_dir}")
        print("[ERROR] Re-run with --force only when intentionally replacing the scaffold files.")
        sys.exit(1)

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(SKILL_TEMPLATE.format(name=name, title=title_from_name(name)))
    write_interface(
        skill_dir,
        name,
        args.display_name or title_from_name(name),
        args.short_description or f"Help with {title_from_name(name)} workflows",
        args.default_prompt,
    )
    create_placeholders(skill_dir, parse_resources(args.resources), args.examples)

    print(f"[OK] Created skill: {skill_dir}")
    print("[NEXT] Edit SKILL.md, then validate with scripts/quick_validate.py <skill-folder>.")


if __name__ == "__main__":
    main()
