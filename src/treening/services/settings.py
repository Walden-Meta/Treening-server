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
    """是否开放自助注册（登录页显示注册表单）。closed 之外均为开放。"""
    return registration_mode() != "closed"


def registration_mode() -> str:
    """注册三态：open（自由注册）/ invite（需邀请码）/ closed（关闭）。

    settings.json 优先，其次 TREENING_REGISTRATION_MODE 环境变量兜底。
    """
    value = load().get("registration_mode")
    if value in {"open", "invite", "closed"}:
        return value
    env_mode = os.environ.get("TREENING_REGISTRATION_MODE", "")
    if env_mode in {"open", "invite", "closed"}:
        return env_mode
    # 向后兼容：旧版用 open_registration 布尔控制注册开关
    legacy = load().get("open_registration")
    if isinstance(legacy, bool):
        return "open" if legacy else "closed"
    return "open"  # 缺省向后兼容：建好首管理员后即可自助注册


def registration_invite_codes() -> list[str]:
    """当前可用的邀请码列表（一次性：注册成功即消费移除）。"""
    codes = load().get("registration_invite_codes")
    if isinstance(codes, list):
        return [str(code).strip() for code in codes if str(code).strip()]
    return []


def consume_invite_code(code: str) -> bool:
    """消费一个邀请码（成功返回 True 并从列表移除）。幂等：不在列表时返回 False。"""
    codes = registration_invite_codes()
    code = code.strip()
    if code not in codes:
        return False
    save({"registration_invite_codes": [c for c in codes if c != code]})
    return True


def save_registration(mode: str, codes: list[str] | None = None) -> dict:
    """保存注册模式与邀请码列表。codes 传 None 表示不改动。"""
    patch: dict[str, Any] = {"registration_mode": mode}
    if codes is not None:
        patch["registration_invite_codes"] = [
            str(code).strip() for code in codes if str(code).strip()
        ]
    return save(patch)


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

