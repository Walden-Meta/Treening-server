"""登录 / 登出 / 当前用户 / 注册 / 忘记密码（邮箱重置）。"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, jsonify, request, session, url_for

from ..services import auth, mail, settings
from ..services.validation import validate

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

# 用户名白名单：2-20 位字母/数字/下划线/连字符/中文，防止路径遍历等注入
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-一-龥]{2,20}$")


def _store():
    return current_app.extensions["tree_store"]


def _public_user(user: dict) -> dict:
    """去掉 password_hash 等敏感字段。"""
    return {"username": user["username"], "role": user["role"], "id": user["id"]}


@auth_bp.route("/status", methods=["GET"])
def status():
    """公开端点：登录页据此判断是否显示注册入口。

    0 用户 = 首启建管理员；有用户且开放注册 = 显示自助注册。
    """
    return jsonify({
        "has_users": _store().count_users() > 0,
        "open_registration": settings.open_registration(),
        "registration_mode": settings.registration_mode(),
    })


@auth_bp.route("/register", methods=["POST"])
def register():
    """注册新账号。

    - 首个用户：自动成为管理员，并认领单用户时代的 local-owner 数据；
    - 之后：仅在开放注册开启时允许，创建普通用户（按 IP 限频，防批量刷号）。
    """
    data = request.get_json(silent=True) or {}
    ip = request.remote_addr or "unknown"
    # 统一入参校验：必填 + 类型 + 用户名白名单正则
    err = validate(data, {
        "username": {
            "type": "string", "required": True,
            "pattern": USERNAME_RE.pattern,
            "pattern_msg": "用户名需为 2-20 位字母、数字、下划线、连字符或中文",
        },
        "password": {"type": "string", "required": True, "label": "密码"},
        "email": {"type": "string", "label": "邮箱"},  # 可空=未绑定，validate_email 校验格式
    })
    if err:
        return jsonify({"ok": False, "error": err}), 400
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    email = str(data.get("email", "")).strip().lower()
    pwd_err = auth.validate_password(password)
    if pwd_err:
        return jsonify({"ok": False, "error": pwd_err}), 400
    email_err = auth.validate_email(email)
    if email_err:
        return jsonify({"ok": False, "error": email_err}), 400
    is_first = _store().count_users() == 0
    invite_code = ""
    if not is_first:
        # 注册三态：open 自由 / invite 需邀请码 / closed 关闭
        mode = settings.registration_mode()
        if mode == "closed":
            return jsonify({"ok": False, "error": "注册未开放，请联系管理员"}), 403
        if mode == "invite":
            invite_code = str(data.get("invite_code", "")).strip()
            if not invite_code:
                return jsonify({"ok": False, "error": "请输入邀请码"}), 400
            if invite_code not in settings.registration_invite_codes():
                return jsonify({"ok": False, "error": "邀请码无效或已被使用"}), 400
        if not auth.registration_allowed(ip):
            return jsonify({
                "ok": False,
                "error": f"该 IP 每小时最多注册 {auth.MAX_REGISTRATIONS_PER_IP} 个账号，请稍后再试",
            }), 429
    role = "admin" if is_first else "user"
    user = _store().create_user(
        username, auth.hash_password(password), role=role, email=email
    )
    if not user:
        return jsonify({"ok": False, "error": "用户名已存在"}), 409
    # 邀请码只在建号成功后消费，避免「用户名冲突/校验失败」白烧一个码
    if invite_code:
        settings.consume_invite_code(invite_code)
    # 新账号默认第一个样例：「你是谁」主题，让春宁当场自介并演示三出口
    _store().seed_welcome_session(user["id"])
    auth.record_registration(ip)
    if is_first:
        # 把单用户时代的 local-owner 数据并入首个管理员
        _store().claim_legacy_sessions(user["id"])
    session.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"]
    # login_at 用于改密后旧会话失效判定（guard 里与 password_changed_at 比对）
    session["login_at"] = time.time()
    return jsonify({"ok": True, "user": _public_user(user)})


@auth_bp.route("/ping", methods=["GET"])
def ping():
    """心跳：登录用户在页面上定期调用，保持「在线」状态。"""
    user_id = session.get("user_id")
    user = _store().get_user_by_id(user_id) if user_id else None
    if not user or not user["is_active"]:
        session.clear()
        return jsonify({"ok": True, "authenticated": False})
    _store().touch_user_activity(user["id"], request.remote_addr or "")
    return jsonify({"ok": True, "authenticated": True})


@auth_bp.route("/password", methods=["POST"])
def change_password():
    """自助改密：需已登录，验证旧密码后设置新密码。"""
    user_id = session.get("user_id")
    user = _store().get_user_by_id(user_id) if user_id else None
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    data = request.get_json(silent=True) or {}
    err = validate(data, {
        "old_password": {"type": "string", "required": True, "label": "旧密码"},
        "new_password": {"type": "string", "required": True, "label": "新密码"},
    })
    if err:
        return jsonify({"ok": False, "error": err}), 400
    old_password = str(data.get("old_password", ""))
    new_password = str(data.get("new_password", ""))
    if not auth.verify_password(user["password_hash"], old_password):
        return jsonify({"ok": False, "error": "旧密码不正确"}), 400
    pwd_err = auth.validate_password(new_password)
    if pwd_err:
        return jsonify({"ok": False, "error": pwd_err}), 400
    _store().set_user_password(user["id"], auth.hash_password(new_password))
    return jsonify({"ok": True, "message": "密码已更新"})


@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    ip = request.remote_addr or "unknown"
    err = validate(data, {
        "username": {"type": "string", "required": True, "label": "用户名"},
        "password": {"type": "string", "required": True, "label": "密码"},
    })
    if err:
        return jsonify({"ok": False, "error": err}), 400
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if auth.is_locked(username, ip):
        return jsonify({"ok": False, "error": "登录失败次数过多，请 15 分钟后再试"}), 429
    user = _store().get_user_by_username(username)
    if not user or not user["is_active"] or not auth.verify_password(
        user["password_hash"], password
    ):
        auth.record_failure(username, ip)
        return jsonify({"ok": False, "error": "用户名或密码错误"}), 401
    auth.clear_failures(username, ip)
    # 会话轮换：清旧写新，防会话固定
    session.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"]
    # login_at 用于改密后旧会话失效判定（guard 里与 password_changed_at 比对）
    session["login_at"] = time.time()
    _store().touch_user_login(user["id"], ip)
    _store().touch_user_activity(user["id"], ip)
    return jsonify({"ok": True, "user": _public_user(user)})


@auth_bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.route("/me", methods=["GET"])
def me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"ok": False, "authenticated": False})
    user = _store().get_user_by_id(user_id)
    if not user or not user["is_active"]:
        session.clear()
        return jsonify({"ok": False, "authenticated": False})
    return jsonify({"ok": True, "authenticated": True, "user": _public_user(user)})


@auth_bp.route("/forgot", methods=["POST"])
def forgot_password():
    """忘记密码：用户名 + 邮箱匹配则发重置邮件。

    无论用户/邮箱是否匹配都返回同样提示（防探测账号是否存在）；
    只有匹配时才真正生成令牌并发信。
    """
    data = request.get_json(silent=True) or {}
    ip = request.remote_addr or "unknown"
    generic = {"ok": True, "message": "如果信息正确，重置邮件已发送，30 分钟内有效"}
    err = validate(data, {
        "username": {"type": "string", "required": True, "label": "用户名"},
        "email": {"type": "string", "required": True, "label": "邮箱"},
    })
    if err:
        return jsonify({"ok": False, "error": err}), 400
    username = str(data.get("username", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    if not auth.forgot_allowed(username, ip):
        return jsonify({"ok": False, "error": "请求过于频繁，请 1 小时后再试"}), 429
    auth.record_forgot(username, ip)
    if not settings.smtp_configured():
        return jsonify({
            "ok": False,
            "error": "管理员尚未配置邮件发送服务，请联系管理员重置密码",
            "code": "smtp_not_configured",
        }), 503
    user = _store().get_user_by_username(username)
    bound = (user or {}).get("email") or ""
    if not user or not user["is_active"] or bound.strip().lower() != email:
        return jsonify(generic)  # 不泄露用户/邮箱是否匹配
    raw_token, token_hash = auth.new_reset_token()
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=auth.RESET_TOKEN_TTL_SECONDS)).isoformat()
    _store().create_password_reset(user["id"], token_hash, expires_at, ip)
    reset_url = url_for("views.reset_page", token=raw_token, _external=True)
    try:
        mail.send_password_reset_email(email, reset_url)
    except Exception:
        current_app.logger.exception("发送密码重置邮件失败：%s", email)
        return jsonify({"ok": False, "error": "邮件发送失败，请稍后再试或联系管理员"}), 502
    return jsonify(generic)


@auth_bp.route("/reset", methods=["POST"])
def reset_password():
    """用邮件里的令牌设置新密码。令牌哈希比对、30 分钟有效、只能用一次。"""
    data = request.get_json(silent=True) or {}
    err = validate(data, {
        "token": {"type": "string", "required": True, "label": "重置令牌"},
        "password": {"type": "string", "required": True, "label": "密码"},
    })
    if err:
        return jsonify({"ok": False, "error": err}), 400
    token = str(data.get("token", "")).strip()
    password = str(data.get("password", ""))
    pwd_err = auth.validate_password(password)
    if pwd_err:
        return jsonify({"ok": False, "error": pwd_err}), 400
    row = _store().find_password_reset(auth.hash_token(token))
    if not row:
        return jsonify({"ok": False, "error": "重置链接无效或已使用"}), 400
    try:
        expires = datetime.fromisoformat(row["expires_at"])
    except ValueError:
        expires = datetime.min.replace(tzinfo=timezone.utc)
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if row.get("used_at") or expires < datetime.now(timezone.utc):
        return jsonify({"ok": False, "error": "重置链接已过期或已使用，请重新发起"}), 400
    _store().mark_password_reset_used(row["id"])
    _store().set_user_password(row["user_id"], auth.hash_password(password))
    _store().delete_expired_password_resets()
    return jsonify({"ok": True, "message": "密码已重置，请用新密码登录"})
