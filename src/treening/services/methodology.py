"""加载 methodology/ 单一事实来源（rules + prompts）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class Methodology:
    """textbook-learning 方法论的机器可读入口。

    v1（决策①）只加载：分支规则（rules.yaml）、交互引导（interaction.yaml）、
    prompt 模板（prompts/*.md）、Obsidian note 映射（note-type-map.yaml）。
    完整 S×D 方法论（B 范围）预留，不实现。
    """

    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir)
        self._yaml_cache: dict[str, dict] = {}
        self._prompt_cache: dict[str, str] = {}

    def _load_yaml(self, rel: str) -> dict[str, Any]:
        if rel not in self._yaml_cache:
            path = self.base_dir / rel
            self._yaml_cache[rel] = (
                yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                if path.exists() else {}
            )
        return self._yaml_cache[rel]

    def branch_rules(self) -> dict[str, Any]:
        return self._load_yaml("rules.yaml")

    def max_branches(self) -> int:
        return int(self.branch_rules().get("max_branches", 3))

    def branch_order(self) -> list[str]:
        return list(self.branch_rules().get("branch_order", ["check", "followup", "custom"]))

    def branch_slots(self) -> dict[str, dict]:
        return {s["id"]: s for s in self.branch_rules().get("branch_slots", [])}

    def legacy_aliases(self) -> dict[str, str]:
        return self.branch_rules().get("legacy_aliases", {})

    def interaction_guidance(self) -> dict[str, str]:
        return self._load_yaml("prompts/interaction.yaml")

    def note_type_map(self) -> dict[str, Any]:
        return self._load_yaml("prompts/note-type-map.yaml")

    def prompt(self, name: str) -> str:
        if name not in self._prompt_cache:
            path = self.base_dir / "prompts" / name
            self._prompt_cache[name] = (
                path.read_text(encoding="utf-8") if path.exists() else ""
            )
        return self._prompt_cache[name]
