#!/usr/bin/env python3
"""
Ensure all open beads in `.beads/issues.jsonl` include the mandatory
beads-code-reviewer instruction in their description.

This prevents the "bead lacks required code review instruction" failure mode
that blocks bead work.

Usage:
    python3 .agents/skills/beads/scripts/ensure-code-review-instruction.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

INSTRUCTION = (
    "\n\nBefore completing this bead, you MUST invoke the beads-code-reviewer sub-agent.\n"
    "You must continue fixing issues and re-invoking the beads-code-reviewer until the\n"
    "response is exactly: APPROVED.\n\n"
    "**IMPORTANT**: Before invoking the beads-code-reviewer, provide a full git diff of your changes:\n"
    "```bash\n"
    "git diff HEAD\n"
    "```\n"
    "Include the complete diff output in your invocation. The code reviewer needs this diff to\n"
    "accurately assess the changes made. Do not proceed with the code review until you have\n"
    "generated and provided this diff."
)

INSTRUCTION_MARKER = "beads-code-reviewer sub-agent"
TARGET_STATUSES = {"open", "in_progress", "blocked", "deferred", ""}


def main() -> int:
    issues_path = Path(".beads/issues.jsonl")
    if not issues_path.exists():
        print(f"ERROR: {issues_path} not found", file=sys.stderr)
        return 1

    with issues_path.open("r", encoding="utf-8") as f:
        lines = f.readlines()

    new_lines = []
    updated = 0
    for line in lines:
        stripped = line.rstrip("\n")
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            new_lines.append(line)
            continue

        if (
            obj.get("status", "") in TARGET_STATUSES
            and INSTRUCTION_MARKER not in obj.get("description", "")
        ):
            obj["description"] = obj.get("description", "") + INSTRUCTION
            updated += 1

        new_lines.append(json.dumps(obj) + "\n")

    with issues_path.open("w", encoding="utf-8") as f:
        f.writelines(new_lines)

    print(f"Updated {updated} beads with mandatory code review instruction")
    return 0


if __name__ == "__main__":
    sys.exit(main())
