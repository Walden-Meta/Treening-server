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

    def deconstruction_blocks(self) -> dict[str, str]:
        """deconstruction.md 按 '## ' 标题分节，供拆解模块开关使用。

        返回 dict：
          - 'header'：文件开头的总览（标题 + 说明）
          - 'contradiction' / 'practice' / 'check_question' /
            'reflect_question' / 'inspire_question'：五个拆解字段各一节
            （节内保留原标题行，便于原样回拼）
          - 'footer'：末尾「约束」段
        缺文件时返回空 dict，调用方自行兜底。
        """
        text = self.prompt("deconstruction.md")
        if not text:
            return {}
        sections: dict[str, list[str]] = {}
        current = "header"
        for line in text.splitlines():
            if line.startswith("## "):
                raw = line[3:].split(" — ")[0].strip()
                current = "footer" if raw == "约束" else (raw or "section")
                sections.setdefault(current, []).append(line)
                continue
            sections.setdefault(current, []).append(line)
        return {k: "\n".join(v).strip() for k, v in sections.items() if v}
