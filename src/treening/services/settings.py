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


def open_registration() -> bool:
    """是否开放自助注册（登录页显示注册表单）。默认开启。"""
    value = load().get("open_registration")
    if isinstance(value, bool):
        return value
    return True  # 缺省开放：建好首管理员后其他人即可自助注册


# ── SMTP 发信配置（管理员在后台填写，用于忘记密码发重置邮件） ──

def smtp_config() -> dict[str, Any]:
    cfg = load().get("smtp")
    return cfg if isinstance(cfg, dict) else {}


def smtp_configured() -> bool:
    """是否已配置可用的发信账号（host + 账号 + 授权码齐全）。"""
    cfg = smtp_config()
    return bool(cfg.get("host") and cfg.get("username") and cfg.get("password"))


def save_smtp(patch: dict[str, Any]) -> dict[str, Any]:
    """合并保存 SMTP 配置。传空字符串表示沿用旧值（改单项时无需重输授权码）。"""
    current = smtp_config()
    for key, value in patch.items():
        if value == "" and key in current:
            continue  # 留空 = 保持原有值
        current[key] = value
    save({"smtp": current})
    return current

