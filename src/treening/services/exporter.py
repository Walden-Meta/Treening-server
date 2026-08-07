"""Portable exports for textbook-learning quiz sessions."""

from __future__ import annotations

import re
from io import BytesIO
from typing import Any


BRANCH_LABELS = {
    "question": "起点问题",
    "check": "验收",
    "followup": "追问",
    "custom": "其他",
    "correction": "其他",
}


def _branch(node: dict[str, Any]) -> str:
    value = node.get("branch_type") or "question"
    return "custom" if value == "correction" else value


def _selected_nodes(
    nodes: list[dict[str, Any]],
    scope: str,
    node_id: str | None,
) -> list[dict[str, Any]]:
    if scope not in {"tree", "path", "subtree"}:
        raise ValueError("invalid export scope")
    if not nodes:
        return []

    node_map = {node["id"]: node for node in nodes}
    target_id = node_id or nodes[-1]["id"]
    if scope == "tree":
        return nodes
    if target_id not in node_map:
        raise ValueError("export node not found")
    if scope == "path":
        result: list[dict[str, Any]] = []
        current_id: str | None = target_id
        seen: set[str] = set()
        while current_id and current_id not in seen:
            seen.add(current_id)
            current = node_map.get(current_id)
            if not current:
                break
            result.append(current)
            current_id = current.get("parent_id")
        result.reverse()
        return result

    descendants = {target_id}
    changed = True
    while changed:
        changed = False
        for node in nodes:
            if node.get("parent_id") in descendants and node["id"] not in descendants:
                descendants.add(node["id"])
                changed = True
    return [node for node in nodes if node["id"] in descendants]


def _depths(nodes: list[dict[str, Any]]) -> dict[str, int]:
    node_map = {node["id"]: node for node in nodes}
    memo: dict[str, int] = {}

    def depth(node_id: str, trail: set[str] | None = None) -> int:
        if node_id in memo:
            return memo[node_id]
        trail = trail or set()
        if node_id in trail:
            return 0
        node = node_map[node_id]
        parent_id = node.get("parent_id")
        value = depth(parent_id, trail | {node_id}) + 1 if parent_id in node_map else 0
        memo[node_id] = value
        return value

    return {node["id"]: depth(node["id"]) for node in nodes}


def _tree_lines(nodes: list[dict[str, Any]]) -> list[str]:
    depths = _depths(nodes)
    return [
        f"{'  ' * depths[node['id']]}- [{BRANCH_LABELS.get(_branch(node), '学习')}] "
        f"{node.get('role', 'unknown')}: {str(node.get('content', '')).strip()}"
        for node in nodes
    ]


def _mermaid(nodes: list[dict[str, Any]]) -> str:
    lines = ["```mermaid", "flowchart TD"]
    for index, node in enumerate(nodes, start=1):
        node_key = f"N{index}"
        label = re.sub(r"[\r\n]+", " ", str(node.get("content", ""))).strip()
        label = label.replace('"', "'")[:72] or "空节点"
        lines.append(f'  {node_key}["{label}"]')
    id_to_key = {node["id"]: f"N{index}" for index, node in enumerate(nodes, start=1)}
    for node in nodes:
        parent_id = node.get("parent_id")
        if parent_id in id_to_key:
            lines.append(f"  {id_to_key[parent_id]} -->|{BRANCH_LABELS.get(_branch(node), '学习')}| {id_to_key[node['id']]}")
    lines.append("```")
    return "\n".join(lines)


_DECON_LABELS = (
    ("contradiction", "矛盾论 · 认识拆解"),
    ("practice", "实践论 · 行动指向"),
    ("check_question", "问题 · 验收"),
    ("reflect_question", "问题 · 反思"),
    ("inspire_question", "问题 · 启发"),
)


def _deconstruction_blocks(node: dict[str, Any]) -> list[tuple[str, str]]:
    """Extract non-empty 拆解 blocks (矛盾论/实践论/三问) from a node.

    Blocks live in assistant node metadata. Empty or missing entries are
    skipped so honest "现阶段不需要行动" responses do not leave a bare label.
    """
    metadata = node.get("metadata")
    if not isinstance(metadata, dict):
        return []
    return [
        (label, str(metadata.get(key, "")).strip())
        for key, label in _DECON_LABELS
        if metadata.get(key)
    ]


def _title(session: dict[str, Any]) -> str:
    return (session.get("title") or session.get("root_question") or "未命名学习主题").strip()[:120]


def render_markdown(session: dict[str, Any], nodes: list[dict[str, Any]], scope: str) -> str:
    title = _title(session)
    lines = [
        f"# {title}",
        "",
        f"- 创建时间：{session.get('created_at', '')}",
        f"- 最近更新：{session.get('updated_at', '')}",
        f"- 导出范围：{scope}",
        f"- 节点数量：{len(nodes)}",
        "",
        "## 知识树",
        "",
        _mermaid(nodes),
        "",
        "## 节点内容",
        "",
    ]
    depths = _depths(nodes)
    for index, node in enumerate(nodes, start=1):
        branch = BRANCH_LABELS.get(_branch(node), "学习")
        role = "提问" if node.get("role") == "user" else "回答"
        lines.extend([
            f"### {index}. {role} · {branch}",
            "",
            f"> 深度 {depths[node['id']] + 1} · 节点 ID `{node['id']}`",
            "",
            str(node.get("content", "")).strip(),
            "",
        ])
        blocks = _deconstruction_blocks(node)
        if blocks:
            lines.extend(["**拆解**", ""])
            for label, text in blocks:
                lines.append(f"- **{label}**：{text}")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_text(session: dict[str, Any], nodes: list[dict[str, Any]], scope: str) -> str:
    lines = [
        _title(session),
        "=" * len(_title(session)),
        f"创建时间：{session.get('created_at', '')}",
        f"最近更新：{session.get('updated_at', '')}",
        f"导出范围：{scope}",
        "",
        "知识树：",
        *_tree_lines(nodes),
        "",
    ]
    lines.append("")
    for node in nodes:
        blocks = _deconstruction_blocks(node)
        if not blocks:
            continue
        branch = BRANCH_LABELS.get(_branch(node), "学习")
        lines.append(f"[拆解 · {branch}]")
        for label, text in blocks:
            lines.append(f"  {label}：{text}")
        lines.append("")
    return "\n".join(lines)


def render_docx(session: dict[str, Any], nodes: list[dict[str, Any]], scope: str) -> bytes:
    from docx import Document
    from docx.shared import Pt

    document = Document()
    title = _title(session)
    document.add_heading(title, 0)
    document.add_paragraph(f"创建时间：{session.get('created_at', '')}")
    document.add_paragraph(f"最近更新：{session.get('updated_at', '')}")
    document.add_paragraph(f"导出范围：{scope} · 节点数量：{len(nodes)}")
    document.add_heading("知识树", level=1)
    for line in _tree_lines(nodes):
        paragraph = document.add_paragraph(line)
        paragraph.paragraph_format.left_indent = Pt(12)
    document.add_heading("节点内容", level=1)
    depths = _depths(nodes)
    for index, node in enumerate(nodes, start=1):
        branch = BRANCH_LABELS.get(_branch(node), "学习")
        role = "提问" if node.get("role") == "user" else "回答"
        document.add_heading(f"{index}. {role} · {branch}", level=min(9, depths[node["id"]] + 2))
        document.add_paragraph(str(node.get("content", "")).strip())
        blocks = _deconstruction_blocks(node)
        if blocks:
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Pt(12)
            run = paragraph.add_run("拆解")
            run.bold = True
            for label, text in blocks:
                item = document.add_paragraph(style="List Bullet")
                item.paragraph_format.left_indent = Pt(24)
                label_run = item.add_run(f"{label}：")
                label_run.bold = True
                item.add_run(text)
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def render_export(
    session: dict[str, Any],
    nodes: list[dict[str, Any]],
    fmt: str,
    scope: str,
    node_id: str | None = None,
) -> tuple[bytes, str, str]:
    selected = _selected_nodes(nodes, scope, node_id)
    if fmt == "md":
        return render_markdown(session, selected, scope).encode("utf-8"), "text/markdown; charset=utf-8", "md"
    if fmt == "txt":
        return render_text(session, selected, scope).encode("utf-8"), "text/plain; charset=utf-8", "txt"
    if fmt == "docx":
        return render_docx(session, selected, scope), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"
    raise ValueError("unsupported export format")
