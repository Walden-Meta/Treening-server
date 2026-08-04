"""data/settings.json 读写（本地单用户配置）。

向导写入 api_key/api_url/model；config.py 读取它。原子写入防止并发读到半写。
"""
from __future__ import annotations

import json
import os
from typing import Any

from ..config import BASE_DIR

SETTINGS_PATH = BASE_DIR / "data" / "settings.json"


def load() -> dict[str, Any]:
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def save(patch: dict[str, Any]) -> dict[str, Any]:
    current = load()
    current.update(patch)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(SETTINGS_PATH.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SETTINGS_PATH)
    return current


def is_configured() -> bool:
    return bool((load().get("api_key") or "").strip())

