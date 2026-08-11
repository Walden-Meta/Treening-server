"""统一入参校验。

替代各接口零散的手写 if 判断：必填、类型、长度、范围、枚举、正则，
按字段声明式配置，错误信息统一中文，返回首条错误（None=通过）。

用法：
    from ..services.validation import validate
    err = validate(data, {
        "mode":   {"required": True, "choices": ["open", "invite", "closed"], "label": "注册模式"},
        "port":   {"type": "int", "min": 1, "max": 65535},
        "codes":  {"type": "list", "allow_empty": True},
        "detail": {"type": "string", "max_len": 2000},
    })
    if err:
        return jsonify({"ok": False, "error": err}), 400

字段规则：
  required    必填（缺字段或纯空白视为未填）
  label       错误提示里的字段名（默认用字段名）
  type        "string" | "int" | "bool" | "list"（string 会先 strip）
  min_len / max_len   字符串长度（含 strip 后）
  min / max   数值范围
  choices     枚举白名单（int/str 均可）
  pattern + pattern_msg   正则（re.fullmatch）
  allow_empty list 允许空数组（默认非空 list 才算填了）
"""
from __future__ import annotations

import re
from typing import Any


def validate(data: Any, rules: dict[str, dict]) -> str | None:
    if not isinstance(data, dict):
        data = {}
    for name, spec in rules.items():
        label = spec.get("label", name)
        raw = data.get(name)

        # 必填判定：缺字段 / 纯空白 / 空 list 都视为未填
        missing = raw is None
        if isinstance(raw, str) and not raw.strip():
            missing = True
        if isinstance(raw, list) and not raw and not spec.get("allow_empty"):
            missing = True
        if missing:
            if spec.get("required"):
                return f"请填写{label}"
            continue

        # 类型校验（string 会 strip，返回值直接用于后续规则）
        t = spec.get("type")
        if t == "string":
            if not isinstance(raw, str):
                return f"{label}必须是文本"
            raw = raw.strip()
        elif t == "int":
            try:
                raw = int(raw)
            except (TypeError, ValueError):
                return f"{label}必须是整数"
        elif t == "bool":
            if not isinstance(raw, bool):
                return f"{label}必须是布尔值"
        elif t == "list":
            if not isinstance(raw, list):
                return f"{label}必须是数组"

        # 长度 / 范围 / 枚举 / 正则
        if isinstance(raw, str):
            max_len = spec.get("max_len")
            if max_len is not None and len(raw) > max_len:
                return f"{label}不能超过 {max_len} 字符"
            min_len = spec.get("min_len")
            if min_len is not None and len(raw) < min_len:
                return f"{label}至少需要 {min_len} 字符"
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            if "min" in spec and raw < spec["min"]:
                return f"{label}不能小于 {spec['min']}"
            if "max" in spec and raw > spec["max"]:
                return f"{label}不能大于 {spec['max']}"
        choices = spec.get("choices")
        if choices is not None and raw not in choices:
            return f"{label}必须是{'/'.join(str(c) for c in choices)}之一"
        pattern = spec.get("pattern")
        if pattern:
            if not re.fullmatch(pattern, str(raw)):
                return spec.get("pattern_msg") or f"{label}格式不正确"
    return None
