"""treening Flask 应用工厂。入口：treening serve 或 python -m treening"""
from __future__ import annotations

import hashlib
import secrets
import time
from pathlib import Path

from flask import Flask, jsonify, redirect, request, session, url_for

from .config import BASE_DIR, config
from .services.methodology import Methodology
from .services.store import TreeStore

# 在线状态活跃写入节流：同一用户 60 秒内至多写一次库
_ACTIVITY_THROTTLE_SECONDS = 60
_last_activity_write: dict[str, float] = {}


def _persistent_secret() -> str:
    """本地持久化随机 secret，保证重启后 session（登录态/当前主题）不失效。

    v2：改用 secrets 随机生成。旧版固定为 sha256(b"treening-local")，值公开可预测，
    攻击者可伪造 session cookie；检测到旧值会重新生成。
    """
    secret_path = BASE_DIR / "data" / ".secret"
    legacy = hashlib.sha256(b"treening-local").hexdigest()
    try:
        existing = secret_path.read_text(encoding="utf-8").strip()
        if existing and existing != legacy:
            return existing
    except OSError:
        pass
    generated = secrets.token_hex(32)
    try:
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(generated, encoding="utf-8")
    except OSError:
        pass
    return generated


# 无需登录即可访问的路径前缀
_PUBLIC_PREFIXES = (
    "/static/", "/api/auth/", "/favicon.ico", "/api/health",
    "/login", "/forgot", "/reset", "/manual",
)


def _touch_activity(store: TreeStore, user_id: str, ip: str) -> None:
    """节流式写入用户活跃时间/IP（每用户每 60 秒至多一次）。"""
    now = time.time()
    if now - _last_activity_write.get(user_id, 0.0) < _ACTIVITY_THROTTLE_SECONDS:
        return
    _last_activity_write[user_id] = now
    store.touch_user_activity(user_id, ip)


def _seed_legacy_user_configs(store: TreeStore) -> None:
    """把单用户时代的全局配置播种到无用户级配置的既有账号。

    只对「尚无 user_configs 记录」的用户执行一次；已配置过的账号保持不动，
    避免重复写入覆盖用户自己的设置。
    """
    for user in store.list_users():
        if store.has_user_config(user["id"]):
            continue
        store.save_user_config(
            user["id"],
            persona=config.persona(),
            branch_labels=config.branch_labels(),
            deconstruction_enabled=config.DECONSTRUCTION_ENABLED,
        )


def create_app() -> Flask:
    config.ensure_dirs()

    app = Flask(
        __name__,
        template_folder=str(Path(__file__).resolve().parent / "templates"),
        static_folder=str(Path(__file__).resolve().parent / "static"),
    )
    app.config["SECRET_KEY"] = _persistent_secret()
    app.config["TREENING"] = config
    # P1 加固：会话 Cookie 标记 HttpOnly + SameSite=Lax（防 XSS 窃取、CSRF）
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    store = TreeStore(config.DATABASE_URL)
    app.extensions["tree_store"] = store
    app.extensions["methodology"] = Methodology(config.METHODOLOGY_DIR)

    # 一次性迁移：把旧版全局配置（data/persona.md + settings.json）播种到
    # 每个尚无用户级配置的账号，保证既有用户升级后不丢人设/命名/拆解开关。
    _seed_legacy_user_configs(store)

    from .blueprints import blueprints
    for bp in blueprints:
        app.register_blueprint(bp)

    @app.before_request
    def _guard():
        """访问守卫：首启引导（无用户建号）→ 登录墙 → 管理员配置页限制。"""
        path = request.path
        if path.startswith(_PUBLIC_PREFIXES):
            return None
        # 无任何用户：引导到配置页创建首个管理员账号
        if store.count_users() == 0:
            if path == "/setup":
                return None
            if path.startswith("/api/"):
                return jsonify({"ok": False, "error": "需要先创建管理员账号", "code": "no_users"}), 503
            return redirect(url_for("views.setup_page"))
        # 登录墙
        if not session.get("user_id"):
            if path.startswith("/api/"):
                return jsonify({"ok": False, "error": "未登录", "code": "auth_required"}), 401
            return redirect(url_for("views.login_page"))
        # 账号可能已被删除/禁用：会话失效
        if not store.get_user_by_id(session["user_id"]):
            session.clear()
            if path.startswith("/api/"):
                return jsonify({"ok": False, "error": "账号已失效，请重新登录", "code": "auth_required"}), 401
            return redirect(url_for("views.login_page"))
        # 记录在线活跃（节流，60 秒/人至多写一次）
        _touch_activity(store, session["user_id"], request.remote_addr or "")
        # /admin 仅管理员可见；普通用户访问返回 403
        if path == "/admin" and session.get("role") != "admin":
            if path.startswith("/api/"):
                return jsonify({"ok": False, "error": "仅管理员可访问", "code": "forbidden"}), 403
            return jsonify({"ok": False, "error": "仅管理员可访问", "code": "forbidden"}), 403
        # /setup 对所有登录用户开放（每人配置自己的 persona/命名/拆解）；
        # API Key 等全局配置仅在 setup 蓝图中校验管理员权限。
        return None

    @app.after_request
    def _security_headers(resp):
        """正式站安全头：MIME 嗅探 / 点击劫持 / 信息泄漏 / CSP 收紧。

        HSTS 由 nginx（TLS 终止层）设置；这里管应用层。CSP 允许内联样式
        （admin/setup 页面有 <style> 与 style=""），脚本仅允许同源。
        """
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "font-src 'self' data:; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'",
        )
        return resp

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=False)

