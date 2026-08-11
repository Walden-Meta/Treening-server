"""管理员面板 API：用户管理 + 系统/邮件设置（仅 admin 角色可访问）。"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify, request, session

from ..config import config
from ..services import auth, mail, settings

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")

USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-一-龥]{2,20}$")

# 最近 5 分钟有活跃请求视为在线
ONLINE_WINDOW_SECONDS = 5 * 60


def _is_online(user: dict) -> bool:
    last_seen = user.get("last_seen_at")
    if not last_seen:
        return False
    try:
        ts = datetime.fromisoformat(last_seen)
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    return (now - ts).total_seconds() < ONLINE_WINDOW_SECONDS


def _store():
    return current_app.extensions["tree_store"]


def _admin_required():
    if session.get("role") != "admin":
        return jsonify({"ok": False, "error": "仅管理员可访问"}), 403
    return None


def _user_stats(user_id: str) -> dict:
    store = _store()
    sessions = store.list_sessions(user_id, limit=100000, include_drafts=True, include_archived=True)
    node_count = sum(int(s.get("node_count") or 0) for s in sessions)
    return {"session_count": len(sessions), "node_count": node_count}


def _effective_quota_max(user: dict) -> int | None:
    """用户每日提问上限（None=不限额）。管理员恒不限额。"""
    if user.get("role") == "admin":
        return None
    limit = user.get("quota_limit")
    if isinstance(limit, int) and limit > 0:
        return int(limit)
    if isinstance(limit, int) and limit == 0:
        return None
    return int(config.MAX_QUESTIONS)


def _public_users() -> list[dict]:
    store = _store()
    users = []
    for u in store.list_users():
        stats = _user_stats(u["id"])
        users.append({
            "id": u["id"],
            "username": u["username"],
            "role": u["role"],
            "is_active": bool(u["is_active"]),
            "email": u.get("email") or "",
            "created_at": u.get("created_at") or "",
            "last_login_at": u.get("last_login_at") or "",
            "last_login_ip": u.get("last_login_ip") or "",
            "last_seen_at": u.get("last_seen_at") or "",
            "last_seen_ip": u.get("last_seen_ip") or "",
            "online": _is_online(u),
            "quota_limit": u.get("quota_limit"),  # None=默认; 0=不限; N=每日N次
            "quota_max": _effective_quota_max(u),
            "quota_used": store.quota_used_today(u["id"]),
            **stats,
        })
    return users


@admin_bp.route("/users", methods=["GET"])
def list_users():
    guard = _admin_required()
    if guard:
        return guard
    return jsonify({"ok": True, "users": _public_users()})


@admin_bp.route("/users", methods=["POST"])
def create_user():
    guard = _admin_required()
    if guard:
        return guard
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    email = str(data.get("email", "")).strip().lower()
    role = "admin" if data.get("role") == "admin" else "user"
    if not USERNAME_RE.fullmatch(username):
        return jsonify({"ok": False, "error": "用户名需为 2-20 位字母、数字、下划线、连字符或中文"}), 400
    pwd_err = auth.validate_password(password)
    if pwd_err:
        return jsonify({"ok": False, "error": pwd_err}), 400
    email_err = auth.validate_email(email)
    if email_err:
        return jsonify({"ok": False, "error": email_err}), 400
    user = _store().create_user(
        username, auth.hash_password(password), role=role, email=email
    )
    if not user:
        return jsonify({"ok": False, "error": "用户名已存在"}), 409
    # 新账号默认第一个样例：「你是谁」主题
    _store().seed_welcome_session(user["id"])
    return jsonify({"ok": True, "users": _public_users()}), 201


@admin_bp.route("/users/<user_id>", methods=["PATCH"])
def update_user(user_id: str):
    guard = _admin_required()
    if guard:
        return guard
    store = _store()
    target = store.get_user_by_id(user_id)
    if not target:
        return jsonify({"ok": False, "error": "用户不存在"}), 404
    data = request.get_json(silent=True) or {}
    me = session.get("user_id")

    # 改密
    if "password" in data:
        password = str(data.get("password", ""))
        pwd_err = auth.validate_password(password)
        if pwd_err:
            return jsonify({"ok": False, "error": pwd_err}), 400
        store.set_user_password(user_id, auth.hash_password(password))

    # 改邮箱
    if "email" in data:
        email = str(data.get("email", "")).strip().lower()
        email_err = auth.validate_email(email)
        if email_err:
            return jsonify({"ok": False, "error": email_err}), 400
        store.set_user_email(user_id, email)

    # 改角色
    if "role" in data:
        role = "admin" if data.get("role") == "admin" else "user"
        if role != target["role"] and role != "admin":
            # 防止把自己或唯一管理员降级成普通用户（导致无人可管）
            admins = [u for u in store.list_users() if u["role"] == "admin" and u["is_active"]]
            if target["role"] == "admin" and len(admins) <= 1:
                return jsonify({"ok": False, "error": "不能降级最后一个管理员"}), 400
        store.set_user_role(user_id, role)

    # 启/禁用
    if "is_active" in data:
        is_active = bool(data.get("is_active"))
        if not is_active:
            if user_id == me:
                return jsonify({"ok": False, "error": "不能禁用自己"}), 400
            admins = [u for u in store.list_users() if u["role"] == "admin" and u["is_active"]]
            if target["role"] == "admin" and len(admins) <= 1:
                return jsonify({"ok": False, "error": "不能禁用最后一个管理员"}), 400
        store.set_user_active(user_id, is_active)

    # 改每日配额（quota_limit：null/省略=用全局默认，0=不限额，N=每日 N 次）
    if "quota_limit" in data:
        ql = data.get("quota_limit")
        if ql is None or ql == "":
            store.set_user_quota(user_id, None)
        else:
            try:
                ql_int = int(ql)
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "配额需为 0（不限）、数字或留空（默认）"}), 400
            if ql_int < 0 or ql_int > 100000:
                return jsonify({"ok": False, "error": "配额需在 0-100000 之间"}), 400
            store.set_user_quota(user_id, ql_int)

    return jsonify({"ok": True, "users": _public_users()})


@admin_bp.route("/users/<user_id>", methods=["DELETE"])
def delete_user(user_id: str):
    guard = _admin_required()
    if guard:
        return guard
    store = _store()
    target = store.get_user_by_id(user_id)
    if not target:
        return jsonify({"ok": False, "error": "用户不存在"}), 404
    if user_id == session.get("user_id"):
        return jsonify({"ok": False, "error": "不能删除自己"}), 400
    admins = [u for u in store.list_users() if u["role"] == "admin" and u["is_active"]]
    if target["role"] == "admin" and len(admins) <= 1:
        return jsonify({"ok": False, "error": "不能删除最后一个管理员"}), 400
    store.delete_user(user_id)
    return jsonify({"ok": True, "users": _public_users()})


@admin_bp.route("/settings", methods=["GET"])
def get_settings():
    guard = _admin_required()
    if guard:
        return guard
    return jsonify({
        "ok": True,
        "open_registration": settings.open_registration(),
        "registration_mode": settings.registration_mode(),
        "quota_enabled": bool(config.QUOTA_ENABLED),
        "max_questions": int(config.MAX_QUESTIONS),
        "api_configured": bool(config.API_KEY.strip()),
        "api_url": config.API_URL,
        "model": config.MODEL,
        "user_count": _store().count_users(),
    })


@admin_bp.route("/registration", methods=["GET"])
def get_registration():
    """读取注册策略：模式 + 剩余邀请码。"""
    guard = _admin_required()
    if guard:
        return guard
    return jsonify({
        "ok": True,
        "mode": settings.registration_mode(),
        "codes": settings.registration_invite_codes(),
        "user_count": _store().count_users(),
    })


@admin_bp.route("/registration", methods=["POST"])
def update_registration():
    """保存注册策略。

    body: { "mode": "open"|"invite"|"closed",
            "add_codes": ["A", "B"], "remove_codes": ["C"] }
    add/remove 均可省略；mode 必填。
    """
    guard = _admin_required()
    if guard:
        return guard
    data = request.get_json(silent=True) or {}
    mode = str(data.get("mode", "")).strip()
    if mode not in {"open", "invite", "closed"}:
        return jsonify({"ok": False, "error": "注册模式必须是 open / invite / closed 之一"}), 400
    codes = list(settings.registration_invite_codes())
    add_codes = data.get("add_codes")
    if isinstance(add_codes, list):
        for code in add_codes:
            code = str(code).strip()
            if code and code not in codes:
                codes.append(code)
    remove_codes = data.get("remove_codes")
    if isinstance(remove_codes, list):
        remove_set = {str(code).strip() for code in remove_codes}
        codes = [code for code in codes if code not in remove_set]
    settings.save_registration(mode, codes)
    return jsonify({
        "ok": True,
        "mode": settings.registration_mode(),
        "codes": settings.registration_invite_codes(),
    })


@admin_bp.route("/settings", methods=["POST"])
def update_settings():
    guard = _admin_required()
    if guard:
        return guard
    data = request.get_json(silent=True) or {}
    if "open_registration" in data and isinstance(data.get("open_registration"), bool):
        settings.save({"open_registration": data["open_registration"]})
    return jsonify({"ok": True, "open_registration": settings.open_registration()})


# ── SMTP 发信配置（用于忘记密码发邮件） ──

def _mask_email(email: str) -> str:
    """掩码邮箱：1827…@qq.com。"""
    if "@" not in email:
        return email
    local, domain = email.rsplit("@", 1)
    if len(local) <= 2:
        return f"{local[0]}…@{domain}"
    return f"{local[:4]}…@{domain}"


@admin_bp.route("/smtp", methods=["GET"])
def get_smtp():
    guard = _admin_required()
    if guard:
        return guard
    cfg = settings.smtp_config()
    return jsonify({
        "ok": True,
        "configured": settings.smtp_configured(),
        "host": cfg.get("host", ""),
        "port": int(cfg.get("port") or 465),
        "use_ssl": bool(cfg.get("use_ssl")),
        "username": cfg.get("username", ""),
        "password": "已保存" if cfg.get("password") else "",
        "from_email": cfg.get("from_email", ""),
        "from_name": cfg.get("from_name", ""),
        # 已配置账号的脱敏显示（供表单占位）
        "username_hint": _mask_email(str(cfg.get("username", ""))),
    })


@admin_bp.route("/smtp", methods=["POST"])
def save_smtp():
    guard = _admin_required()
    if guard:
        return guard
    data = request.get_json(silent=True) or {}
    host = str(data.get("host", "")).strip()
    if not host:
        return jsonify({"ok": False, "error": "SMTP 服务器地址不能为空"}), 400
    try:
        port = int(data.get("port") or 465)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "端口必须是数字"}), 400
    use_ssl = bool(data.get("use_ssl"))
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    if not username:
        return jsonify({"ok": False, "error": "邮箱账号不能为空"}), 400
    # 留空的密码表示沿用已保存值
    if not password:
        password = settings.smtp_config().get("password", "")
    if not password:
        return jsonify({"ok": False, "error": "请填写邮箱授权码"}), 400
    settings.save_smtp({
        "host": host,
        "port": port,
        "use_ssl": use_ssl,
        "username": username,
        "password": password,
        "from_email": str(data.get("from_email", "")).strip() or username,
        "from_name": str(data.get("from_name", "")).strip() or "Treening",
    })
    return jsonify({"ok": True, "configured": settings.smtp_configured()})


@admin_bp.route("/smtp/test", methods=["POST"])
def test_smtp():
    guard = _admin_required()
    if guard:
        return guard
    data = request.get_json(silent=True) or {}
    host = str(data.get("host", "")).strip()
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    to_email = str(data.get("to_email", "")).strip()
    if not host or not username:
        return jsonify({"ok": False, "error": "请先完整填写 SMTP 配置再测试"}), 400
    if not password:
        # 授权码留空 = 沿用已保存值（改单项/重新测试时无需重输）
        password = settings.smtp_config().get("password", "")
    if not password:
        return jsonify({"ok": False, "error": "请填写邮箱授权码"}), 400
    if not to_email:
        return jsonify({"ok": False, "error": "请填写测试收件邮箱"}), 400
    email_err = auth.validate_email(to_email)
    if email_err:
        return jsonify({"ok": False, "error": email_err}), 400
    try:
        port = int(data.get("port") or 465)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "端口必须是数字"}), 400
    use_ssl = bool(data.get("use_ssl"))
    ok, message = mail.test_smtp(
        host, port, use_ssl, username, password, to_email,
        str(data.get("from_email", "")).strip(),
    )
    return jsonify({"ok": ok, "message": message})
