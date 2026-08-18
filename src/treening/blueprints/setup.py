"""首次运行向导 API（BYO-Key 配置）。

全局配置（API Key / 地址 / 模型）由管理员维护；
模型配置也支持按用户隔离（每个登录用户可用自己的 Key/地址/模型，
空字段回退全局默认）；人设 / 命名 / 拆解开关 / 布局同样按用户隔离。
"""
from __future__ import annotations

from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify, request, session

from ..config import (
    LAYOUT_ORIENTATIONS,
    LAYOUT_PREFS_RANGES,
    config,
    layout_prefs_for,
)
from ..services import auth, settings
from ..services.provider import TreeProvider

setup_bp = Blueprint("setup", __name__, url_prefix="/api/setup")


def _store():
    return current_app.extensions["tree_store"]


def _current_user() -> dict | None:
    """当前登录用户（访问守卫已保证 /api/setup* 需登录）。"""
    user_id = session.get("user_id")
    if not user_id:
        return None
    return _store().get_user_by_id(user_id)


def _mask_key(key: str) -> str:
    """掩码显示 Key：sk-…最后4位，不回传明文。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "sk-****"
    return f"{key[:3]}…{key[-4:]}"


def _branch_labels_for(user_cfg: dict) -> dict[str, str]:
    """用户命名覆盖 + rules.yaml 默认兜底（只合并非空覆盖）。"""
    overrides = {
        k: v.strip()
        for k, v in (user_cfg.get("branch_labels") or {}).items()
        if v and str(v).strip()
    }
    return {**config._default_branch_labels(), **overrides}


@setup_bp.route("", methods=["GET"])
def get_setup():
    user = _current_user()
    user_cfg = _store().get_user_config(user["id"]) if user else {}
    user_cfg = user_cfg or {}
    key = config.API_KEY.strip()
    user_key = str(user_cfg.get("api_key") or "").strip()
    user_api_url = str(user_cfg.get("api_url") or "").strip()
    user_model = str(user_cfg.get("model") or "").strip()
    return jsonify({
        "configured": bool(key),
        "key_hint": _mask_key(key),
        "api_url": config.API_URL,
        "model": config.MODEL,
        "timeout": config.PROVIDER_TIMEOUT_SECONDS,
        # 当前登录用户自己的模型配置（空 = 该字段跟随全局）
        "user_key_hint": _mask_key(user_key),
        "user_api_url": user_api_url,
        "user_model": user_model,
        "effective_key_configured": bool(user_key or key),
        "effective_api_url": user_api_url or config.API_URL,
        "effective_model": user_model or config.MODEL,
        "persona": user_cfg.get("persona", ""),
        "persona_slots": user_cfg.get("persona_slots") or [],
        "branch_labels": _branch_labels_for(user_cfg),
        "layout_prefs": layout_prefs_for(user_cfg),
        "deconstruction_enabled": (
            user_cfg.get("deconstruction_enabled")
            or list(config.ALL_DECONSTRUCTION_BLOCKS)
        ),
        "all_deconstruction_blocks": list(config.ALL_DECONSTRUCTION_BLOCKS),
        "has_users": _store().count_users() > 0,
        "role": (user or {}).get("role", ""),
        "is_admin": bool(user and user.get("role") == "admin"),
        "email": (user or {}).get("email") or "",
        "smtp_configured": settings.smtp_configured(),
    })


@setup_bp.route("/test", methods=["POST"])
def test():
    if not (_current_user() or {}).get("role") == "admin":
        return jsonify({"ok": False, "error": "仅管理员可测试全局模型配置"}), 403
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
    if not (_current_user() or {}).get("role") == "admin":
        return jsonify({"ok": False, "error": "仅管理员可修改全局模型配置"}), 403
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


def _validate_api_url(value: str) -> str | None:
    """校验接口地址，非法时返回错误信息。"""
    if value and not value.startswith(("http://", "https://")):
        return "接口地址需要以 http:// 或 https:// 开头"
    return None


@setup_bp.route("/model", methods=["POST"])
def save_user_model():
    """保存当前登录用户自己的模型配置（按用户隔离）。

    留空 = 该字段跟随全局默认（管理员配置）。为防 Key 外泄：
    一旦自定义接口地址或模型，就必须同时提供自己的 API Key。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    api_key = str(data.get("api_key", "")).strip()
    api_url = str(data.get("api_url", "")).strip()
    model = str(data.get("model", "")).strip()
    url_err = _validate_api_url(api_url)
    if url_err:
        return jsonify({"ok": False, "error": url_err}), 400
    if (api_url or model) and not api_key:
        return jsonify({
            "ok": False,
            "error": "自定义接口或模型时需要同时提供你自己的 API Key，否则会使用全局 Key",
        }), 400
    _store().save_user_config(
        user["id"], api_key=api_key, api_url=api_url, model=model,
    )
    return jsonify({
        "ok": True,
        "key_hint": _mask_key(api_key),
        "api_url": api_url,
        "model": model,
    })


@setup_bp.route("/test-model", methods=["POST"])
def test_user_model():
    """测试当前登录用户自己的模型配置（未保存，仅连通性测试）。

    覆盖值优先于用户已保存配置，用户已保存配置优先于全局默认。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    user_cfg = _store().get_user_config(user["id"]) or {}
    stored_key = str(user_cfg.get("api_key") or "").strip()
    stored_url = str(user_cfg.get("api_url") or "").strip()
    stored_model = str(user_cfg.get("model") or "").strip()
    api_key = str(data.get("api_key", "")).strip() or stored_key or config.API_KEY.strip()
    api_url = str(data.get("api_url", "")).strip() or stored_url or config.API_URL
    model = str(data.get("model", "")).strip() or stored_model or config.MODEL
    url_err = _validate_api_url(api_url)
    if url_err:
        return jsonify({"ok": False, "error": url_err}), 400
    if not api_key:
        return jsonify({"ok": False, "error": "API Key 不能为空"}), 400
    ok, error = TreeProvider.test_connection(
        api_key, api_url, model, int(config.PROVIDER_TIMEOUT_SECONDS)
    )
    if ok:
        return jsonify({"ok": True, "model": model, "api_url": api_url})
    return jsonify({"ok": False, "error": error}), 400


@setup_bp.route("/persona", methods=["POST"])
def save_persona():
    """保存当前登录用户的个性化人设（按用户隔离，保存即生效）。"""
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    persona = data.get("persona")
    if not isinstance(persona, str):
        return jsonify({"ok": False, "error": "人设内容格式不正确"}), 400
    persona = persona.strip()
    if len(persona) > int(config.PERSONA_MAX_CHARS):
        return jsonify({
            "ok": False,
            "error": f"人设内容过长，请控制在 {config.PERSONA_MAX_CHARS} 字以内",
        }), 400
    _store().save_user_config(user["id"], persona=persona)
    return jsonify({"ok": True, "persona": persona})


@setup_bp.route("/persona-slots", methods=["POST"])
def save_persona_slots():
    """保存当前登录用户的 3 个自定义人设槽位（按用户隔离，保存即生效）。

    每个槽位 {name, note, text}，可留空（隐藏该槽）。
    槽位会出现在学习空间「切换陪伴者」列表里（id 为 custom:1..3）。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    slots = data.get("slots")
    if not isinstance(slots, list) or len(slots) > 3:
        return jsonify({"ok": False, "error": "自定义人设最多 3 个"}), 400
    cleaned: list[dict[str, str]] = []
    for i, slot in enumerate(slots, start=1):
        if not isinstance(slot, dict):
            return jsonify({"ok": False, "error": f"第 {i} 个人设格式不正确"}), 400
        name = str(slot.get("name") or "").strip()
        note = str(slot.get("note") or "").strip()
        text = str(slot.get("text") or "").strip()
        if len(name) > 20:
            return jsonify({"ok": False, "error": f"第 {i} 个人设名称过长（最多 20 字）"}), 400
        if len(note) > 60:
            return jsonify({"ok": False, "error": f"第 {i} 个人设备注过长（最多 60 字）"}), 400
        if len(text) > int(config.PERSONA_MAX_CHARS):
            return jsonify({
                "ok": False,
                "error": f"第 {i} 个人设文字过长（最多 {config.PERSONA_MAX_CHARS} 字）",
            }), 400
        cleaned.append({"name": name, "note": note, "text": text})
    while len(cleaned) < 3:
        cleaned.append({"name": "", "note": "", "text": ""})
    _store().save_user_config(user["id"], persona_slots=cleaned)
    return jsonify({"ok": True, "slots": cleaned})


@setup_bp.route("/branch-labels", methods=["POST"])
def save_branch_labels():
    """保存当前登录用户的分支节点命名（按用户隔离，保存即生效）。

    只接受 check / followup / custom 三个分支槽位的命名；
    缺省的键保持 rules.yaml 默认，配置页与学习空间统一读取。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    labels = data.get("branch_labels")
    if not isinstance(labels, dict):
        return jsonify({"ok": False, "error": "命名格式不正确"}), 400
    cleaned: dict[str, str] = {}
    for slot in ("check", "followup", "custom"):
        value = labels.get(slot)
        if value is None:
            continue  # 缺省键保持默认，不清除已有配置
        if not isinstance(value, str):
            return jsonify({"ok": False, "error": f"「{slot}」命名格式不正确"}), 400
        value = value.strip()
        if len(value) > int(config.BRANCH_LABEL_MAX_CHARS):
            return jsonify({
                "ok": False,
                "error": f"「{slot}」命名过长，请控制在 {config.BRANCH_LABEL_MAX_CHARS} 字以内",
            }), 400
        cleaned[slot] = value
    _store().save_user_config(user["id"], branch_labels=cleaned)
    return jsonify({"ok": True, "branch_labels": _branch_labels_for(
        _store().get_user_config(user["id"]) or {}
    )})


@setup_bp.route("/deconstruction", methods=["POST"])
def save_deconstruction():
    """保存当前登录用户的拆解模块开关（按用户隔离，保存即生效）。

    传空列表 = 全部关闭；只传一部分 = 关闭其余模块；
    合法键之外的输入会被丢弃。缺省（无记录）为全部开启。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    enabled = data.get("enabled")
    if not isinstance(enabled, list):
        return jsonify({"ok": False, "error": "配置格式不正确"}), 400
    valid = set(config.ALL_DECONSTRUCTION_BLOCKS)
    cleaned = list(dict.fromkeys(k for k in enabled if k in valid))
    _store().save_user_config(user["id"], deconstruction_enabled=cleaned)
    return jsonify({"ok": True, "enabled": cleaned})


@setup_bp.route("/layout-prefs", methods=["POST"])
def save_layout_prefs():
    """保存当前登录用户的画布布局偏好（按用户隔离，全局作用于所有主题）。

    只接受 qa_gap / branch_gap / node_width / node_height 四个数值字段
    + orientation（vertical / horizontal）方向字段；
    数值字段做范围夹取后写入，缺省字段保持既有值。保存后前端重排立即生效。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("layout_prefs"), dict):
        return jsonify({"ok": False, "error": "配置格式不正确"}), 400
    current = _store().get_user_config(user["id"]) or {}
    merged = dict(current.get("layout_prefs") or {})
    incoming = data["layout_prefs"]
    for key in LAYOUT_PREFS_RANGES:
        if key not in incoming:
            continue  # 缺省键保持既有值
        try:
            value = float(incoming[key])
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": f"「{key}」需为数值"}), 400
        low, high = LAYOUT_PREFS_RANGES[key]
        merged[key] = max(low, min(high, value))
    # orientation 是非数值字符串字段：只认 vertical / horizontal
    if "orientation" in incoming:
        if incoming["orientation"] not in LAYOUT_ORIENTATIONS:
            return jsonify({"ok": False, "error": "「orientation」取值不合法"}), 400
        merged["orientation"] = incoming["orientation"]
    if not merged:
        return jsonify({"ok": False, "error": "没有可保存的布局参数"}), 400
    old_effective = layout_prefs_for(current)
    new_effective = layout_prefs_for({**current, "layout_prefs": merged})
    changed = (
        old_effective.get("orientation") != new_effective.get("orientation")
        or any(
            abs(float(old_effective[k]) - float(new_effective[k])) > 0.01
            for k in LAYOUT_PREFS_RANGES
        )
    )
    _store().save_user_config(user["id"], layout_prefs=merged)
    if changed:
        # 全局布局规则变了：清掉所有节点的已保存 layout，让知识树完全按新参数重排。
        cleared = _store().clear_user_layouts(user["id"])
    else:
        cleared = 0
    return jsonify({
        "ok": True,
        "layout_prefs": layout_prefs_for(
            _store().get_user_config(user["id"]) or {}
        ),
        "layout_reset": changed,
        "layout_reset_nodes": cleared,
    })


@setup_bp.route("/email", methods=["POST"])
def save_email():
    """绑定/更换当前登录用户的邮箱（用于忘记密码找回）。

    需要验证当前密码，防止被改绑到别人账号上；
    邮箱选填，不填则清空绑定。
    """
    user = _current_user()
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    password = str(data.get("password", ""))
    email = str(data.get("email", "")).strip().lower()
    if not auth.verify_password(user["password_hash"], password):
        return jsonify({"ok": False, "error": "当前密码不正确"}), 400
    email_err = auth.validate_email(email)
    if email_err:
        return jsonify({"ok": False, "error": email_err}), 400
    _store().set_user_email(user["id"], email)
    return jsonify({"ok": True, "email": email})

