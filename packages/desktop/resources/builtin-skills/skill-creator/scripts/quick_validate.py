#!/usr/bin/env python3
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64


def parse_frontmatter(text):
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", text)
    if not match:
        return None
    data = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            return None
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def validate(path):
    skill_dir = Path(path)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    frontmatter = parse_frontmatter(skill_md.read_text())
    if frontmatter is None:
        return False, "Invalid or missing YAML frontmatter"

    unexpected = sorted(set(frontmatter) - {"name", "description"})
    if unexpected:
        return False, f"Unexpected frontmatter key(s): {', '.join(unexpected)}"

    name = frontmatter.get("name", "").strip()
    description = frontmatter.get("description", "").strip()
    if not name:
        return False, "Missing 'name' in frontmatter"
    if not description:
        return False, "Missing 'description' in frontmatter"
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        return False, "Name must be lowercase hyphen-case using letters, digits, and hyphens"
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return False, f"Name is too long ({len(name)} characters). Maximum is {MAX_SKILL_NAME_LENGTH}."
    if "[TODO:" in description:
        return False, "Description still contains a TODO placeholder"
    if len(description) > 1024:
        return False, "Description is too long. Maximum is 1024 characters."

    if skill_dir.name != name:
        return False, f"Skill folder name '{skill_dir.name}' should match frontmatter name '{name}'"

    return True, "Skill is valid!"


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 quick_validate.py <skill-directory>")
        sys.exit(1)
    ok, message = validate(sys.argv[1])
    print(message)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
