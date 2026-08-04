"""首次运行向导 API（BYO-Key 配置）。"""
from __future__ import annotations

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from ..config import config
from ..services import settings
from ..services.provider import TreeProvider

setup_bp = Blueprint("setup", __name__, url_prefix="/api/setup")


def _mask_key(key: str) -> str:
    """掩码显示 Key：sk-…最后4位，不回传明文。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "sk-****"
    return f"{key[:3]}…{key[-4:]}"


@setup_bp.route("", methods=["GET"])
def get_setup():
    key = config.API_KEY.strip()
    return jsonify({
        "configured": bool(key),
        "key_hint": _mask_key(key),
        "api_url": config.API_URL,
        "model": config.MODEL,
        "timeout": config.PROVIDER_TIMEOUT_SECONDS,
    })


@setup_bp.route("/test", methods=["POST"])
def test():
    data = request.get_json(silent=True) or {}
    api_key = str(data.get("api_key", "")).strip()
    api_url = str(data.get("api_url") or config.API_URL).strip()
    model = str(data.get("model") or config.MODEL).strip()
    if not api_key:
        # 留空则用现有已配置的 Key（改模型/地址时无需重输）
        api_key = config.API_KEY.strip()
    if not api_key:
        return jsonify({"ok": False, "error": "API Key 不能为空"}), 400
    if not api_url.startswith(("http://", "https://")):
        return jsonify({"ok": False, "error": "接口地址需要以 http:// 或 https:// 开头"}), 400
    ok, error = TreeProvider.test_connection(
        api_key, api_url, model, int(config.PROVIDER_TIMEOUT_SECONDS)
    )
    if ok:
        return jsonify({"ok": True, "model": model, "api_url": api_url})
    return jsonify({"ok": False, "error": error}), 400


@setup_bp.route("/save", methods=["POST"])
def save():
    data = request.get_json(silent=True) or {}
    api_key = str(data.get("api_key", "")).strip()
    api_url = str(data.get("api_url") or config.API_URL).strip()
    model = str(data.get("model") or config.MODEL).strip()
    if not api_url.startswith(("http://", "https://")):
        return jsonify({"ok": False, "error": "接口地址需要以 http:// 或 https:// 开头"}), 400
    if not api_key:
        # 留空则保留现有 Key
        api_key = str(settings.load().get("api_key", "")).strip()
    if not api_key:
        return jsonify({"ok": False, "error": "API Key 不能为空"}), 400
    settings.save({
        "api_key": api_key,
        "api_url": api_url,
        "model": model,
        "configured_at": datetime.now(timezone.utc).isoformat(),
    })
    config.reload()
    return jsonify({"ok": True, "configured": True})

