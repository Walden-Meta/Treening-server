#!/usr/bin/env python3
"""Validate Textbook Skill Markdown notes without third-party dependencies."""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path


REQUIRED_FIELDS = {"id", "type", "level", "status", "title"}
OPTIONAL_FIELDS = {"orientation", "confidence", "source_scope", "tags", "created", "updated", "review_due"}
REQUIRED_SECTIONS = {
    "concept": {
        "Practice and Need",
        "Concrete Conditions",
        "Contradiction",
        "Abstraction and Mechanism",
        "Worked Case",
        "Boundary and Development",
        "Verification",
    },
    "research": {
        "Research Question",
        "Original Path",
        "Failure or Limit Under Changed Conditions",
        "New Path and Claimed Benefit",
        "Evidence",
        "Bounded Conclusion",
    },
    "project": {  # legacy alias for project-chain
        "Goal and Boundary",
        "Concrete Constraints",
        "Existing Chain",
        "Contradiction or Bottleneck",
        "Design Decision",
        "Code/Data/Runtime Links",
        "Validation",
        "Next Action",
    },
    "project-chain": {
        "Goal and Boundary",
        "Concrete Constraints",
        "Existing Chain",
        "Contradiction or Bottleneck",
        "Design Decision",
        "Code/Data/Runtime Links",
        "Validation",
        "Next Question",
    },
    "decision": {
        "Situation",
        "Goal",
        "Bottleneck",
        "Options Considered",
        "Chosen Path and Rationale",
        "What Was Sacrificed",
        "Verification Plan",
        "Stop",
    },
    "action": {
        "Starting State",
        "Goal",
        "Action Taken",
        "Verification Method",
        "Result Observed",
    },
    "intervention": {
        "Problem and Root Cause",
        "Fix Options",
        "Chosen Fix and Rationale",
        "Implementation",
        "Validation",
        "Deployment Status",
        "Rollback Condition and Readiness",
        "Next Action",
    },
    "review": {"Review Target", "Source Note", "Recall Prompt", "Result"},
    "question": {"Question", "Context", "Next Action"},
}

VALID_LEVELS = {"L1", "L2", "L3", "L4", "D1", "D2", "D3", "D4"}
VALID_STATUSES = {"draft", "verified", "superseded"}
VALID_ORIENTATIONS = {"E", "P"}


def parse_note(text: str) -> tuple[dict[str, str], set[str], list[str]]:
    errors: list[str] = []
    if not text.startswith("---\n"):
        return {}, set(), ["missing YAML frontmatter opening delimiter"]

    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, set(), ["missing YAML frontmatter closing delimiter"]

    frontmatter: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if not match:
            errors.append(f"invalid frontmatter line: {line}")
            continue
        key, value = match.groups()
        frontmatter[key] = value.strip().strip('"\'')

    sections = {
        match.group(1).strip()
        for match in re.finditer(r"^##\s+(.+?)\s*$", text[end + 6 :], re.MULTILINE)
    }
    return frontmatter, sections, errors


def validate(path: Path, expected_type: str | None = None) -> list[str]:
    if not path.is_file():
        return [f"file not found: {path}"]
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        return [f"file is not valid UTF-8: {exc}"]

    frontmatter, sections, errors = parse_note(text)
    missing_fields = REQUIRED_FIELDS - frontmatter.keys()
    errors.extend(f"missing frontmatter field: {field}" for field in sorted(missing_fields))

    note_type = frontmatter.get("type", "")
    if note_type not in REQUIRED_SECTIONS:
        errors.append(f"unsupported note type: {note_type or '<empty>'}")
    elif expected_type and note_type != expected_type:
        errors.append(f"expected type {expected_type}, got {note_type}")
    else:
        missing_sections = REQUIRED_SECTIONS[note_type] - sections
        errors.extend(f"missing section: {section}" for section in sorted(missing_sections))

    if frontmatter.get("level") not in VALID_LEVELS:
        errors.append(f"level must be one of {sorted(VALID_LEVELS)}")
    if frontmatter.get("status") not in VALID_STATUSES:
        errors.append(f"status must be one of {sorted(VALID_STATUSES)}")
    orientation = frontmatter.get("orientation", "")
    if orientation and orientation not in VALID_ORIENTATIONS:
        errors.append(f"orientation must be one of {sorted(VALID_ORIENTATIONS)}")
    return errors


def self_test() -> int:
    tests = [
        ("concept", """---
id: sample-concept
type: concept
orientation: E
level: L2
status: verified
title: Sample Concept
---
# Sample Concept
## Practice and Need
## Concrete Conditions
## Contradiction
## Abstraction and Mechanism
## Worked Case
## Boundary and Development
## Verification
"""),
        ("decision", """---
id: sample-decision
type: decision
orientation: P
level: D2
status: verified
title: Sample Decision
---
# Sample Decision
## Situation
## Goal
## Bottleneck
## Options Considered
## Chosen Path and Rationale
## What Was Sacrificed
## Verification Plan
## Stop
"""),
    ]
    with tempfile.TemporaryDirectory() as directory:
        for expected_type, content in tests:
            path = Path(directory) / f"{expected_type}.md"
            path.write_text(content, encoding="utf-8")
            errors = validate(path, expected_type)
            if errors:
                print(f"SELF_TEST_FAILED ({expected_type})")
                print("\n".join(errors))
                return 1
    print("SELF_TEST_PASSED")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path)
    parser.add_argument("--kind", choices=sorted(REQUIRED_SECTIONS))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if not args.path:
        parser.error("path is required unless --self-test is used")

    errors = validate(args.path, args.kind)
    if errors:
        print("INVALID")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("VALID")
    return 0


if __name__ == "__main__":
    sys.exit(main())
