"""treening Flask 应用工厂。入口：treening serve 或 python -m treening"""
from __future__ import annotations

import hashlib
import logging
import secrets
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, redirect, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import BASE_DIR, config
from .services.methodology import Methodology
from .services.store import TreeStore

# 在线状态活跃写入节流：同一用户 60 秒内至多写一次库
_ACTIVITY_THROTTLE_SECONDS = 60
_last_activity_write: dict[str, float] = {}

logger = logging.getLogger(__name__)

# 默认结构化请求日志格式：时间 / 级别 / 请求 / 状态 / 耗时 / request_id
_REQUEST_LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


def _configure_logging(app: Flask) -> None:
    """配置应用日志：输出到 stdout，级别由 TREENING_LOG_LEVEL 控制。

    只在根 logger 尚无 handler 时才添加，避免 gunicorn 等宿主重复叠加。
    """
    level_name = (config.LOG_LEVEL or "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(_REQUEST_LOG_FORMAT))
        root.addHandler(handler)
    app.logger.setLevel(level)


def _iso_to_ts(value: str | None) -> float | None:
    """把库里的 ISO 时间戳转成 epoch 秒；解析失败返回 None。"""
    if not value:
        return None
    try:
        ts = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.timestamp()


def _init_sentry() -> None:
    """配置 Sentry 错误聚合。无 DSN 或依赖未安装时静默跳过，不阻塞启动。"""
    if not config.SENTRY_DSN:
        return
    try:
        import sentry_sdk
    except ImportError:
        logger.warning("TREENING_SENTRY_DSN 已设置但未安装 sentry-sdk，错误聚合未启用")
        return
    sentry_sdk.init(
        dsn=config.SENTRY_DSN,
        environment=config.ENV,
        traces_sample_rate=0.05,
        send_default_pii=False,
    )
    logger.info("Sentry error aggregation enabled (env=%s)", config.ENV)


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
        # 不播种 persona：春宁是底座人设（用户空配置时由 config.persona() 兜底），
        # 文本框只承担"覆盖/重置"，不应把默认写死进用户配置。
        store.save_user_config(
            user["id"],
            branch_labels=config.branch_labels(),
            deconstruction_enabled=config.DECONSTRUCTION_ENABLED,
        )


# 旧版 settings.json 默认只开了三个提问模块（矛盾论/实践论关闭）的播种集合。
# 用于把这类「从未主动选择的旧默认」账号补全为全部五个拆解模块。
_LEGACY_DECONSTRUCTION_SEED = {"check_question", "reflect_question", "inspire_question"}


def _upgrade_user_deconstruction_defaults(store: TreeStore) -> None:
    """把旧版默认播种的账号补全为全部五个拆解模块（默认全开）。

    只处理「拆解开关恰好等于旧版三问集合」的配置，绝不覆盖用户自己的主动选择；
    幂等：升级完成后不再有匹配行。
    """
    all_blocks = list(config.ALL_DECONSTRUCTION_BLOCKS)
    for user in store.list_users():
        cfg = store.get_user_config(user["id"]) or {}
        enabled = cfg.get("deconstruction_enabled")
        if isinstance(enabled, list) and set(enabled) == _LEGACY_DECONSTRUCTION_SEED:
            store.save_user_config(user["id"], deconstruction_enabled=all_blocks)
            logger.info("upgraded user %s deconstruction to all modules", user["id"])


def create_app() -> Flask:
    config.ensure_dirs()

    app = Flask(
        __name__,
        template_folder=str(Path(__file__).resolve().parent / "templates"),
        static_folder=str(Path(__file__).resolve().parent / "static"),
    )
    app.config["SECRET_KEY"] = _persistent_secret()
    app.config["TREENING"] = config
    # 会话 Cookie：HttpOnly + SameSite=Lax（防 XSS 窃取、CSRF）；HTTPS 下再开 Secure
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = config.COOKIE_SECURE

    # 可信反向代理（nginx）之后：读取真实客户端 IP / 协议 / Host。
    # 只信任第一跳（x_for=1），杜绝客户端伪造 X-Forwarded-For 绕过配额/限流。
    if config.BEHIND_PROXY:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    _init_sentry()

    store = TreeStore(config.DATABASE_URL)
    app.extensions["tree_store"] = store
    app.extensions["methodology"] = Methodology(config.METHODOLOGY_DIR)

    # 一次性迁移：把旧版全局配置（data/persona.md + settings.json）播种到
    # 每个尚无用户级配置的账号，保证既有用户升级后不丢人设/命名/拆解开关。
    _seed_legacy_user_configs(store)
    # 拆解模块默认全开：旧版播种的「只开三问」账号补全矛盾论/实践论。
    _upgrade_user_deconstruction_defaults(store)

    from .blueprints import blueprints
    for bp in blueprints:
        app.register_blueprint(bp)

    _configure_logging(app)

    @app.before_request
    def _request_start():
        """为每个请求生成 request_id 并记录开始时间，用于日志关联与耗时统计。"""
        request.environ["request_id"] = uuid.uuid4().hex[:12]
        request.environ["_start_time"] = time.time()

    @app.after_request
    def _request_log(resp):
        """结构化请求日志：方法 / 路径 / 状态码 / 耗时 / request_id / 来源 IP。

        X-Request-Id 写回响应头，方便前端或下游在排查问题时带回同一 id。
        """
        request_id = request.environ.get("request_id", "-")
        start = request.environ.get("_start_time", time.time())
        elapsed_ms = int((time.time() - start) * 1000)
        resp.headers.setdefault("X-Request-Id", request_id)
        # 静态资源与健康检查不逐条打 INFO 日志，避免噪音
        if not request.path.startswith("/static/") and request.path != "/api/health":
            app.logger.info(
                "%s %s -> %d (%dms) rid=%s ip=%s",
                request.method,
                request.path,
                resp.status_code,
                elapsed_ms,
                request_id,
                request.remote_addr or "-",
            )
        return resp

    _MUTATING_METHODS = {"POST", "PATCH", "PUT", "DELETE"}
    _ALLOWED_ORIGIN_OVERRIDES = {
        origin.strip() for origin in config.ALLOWED_ORIGINS.split(",") if origin.strip()
    }

    @app.before_request
    def _origin_guard():
        """CSRF 加固：对写操作校验 Origin，拒绝跨站请求。

        浏览器跨站写请求必然携带 Origin，同源请求的 Origin 等于本机 scheme://host；
        无 Origin 的请求（curl/服务端调用）放行。比 SameSite=Lax 再兜一层。
        """
        if request.method not in _MUTATING_METHODS:
            return None
        origin = request.headers.get("Origin")
        if not origin:
            return None
        allowed = set(_ALLOWED_ORIGIN_OVERRIDES)
        if request.host:
            allowed.add(f"{request.scheme}://{request.host}")
        if origin not in allowed:
            return jsonify({
                "ok": False,
                "error": "跨站请求被拒绝",
                "code": "origin_forbidden",
            }), 403
        return None

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
        # 账号可能已被删除/禁用：会话失效（含 is_active，禁用按钮才能真正踢下线）
        user = store.get_user_by_id(session["user_id"])
        if not user or not user["is_active"]:
            session.clear()
            if path.startswith("/api/"):
                return jsonify({"ok": False, "error": "账号已失效或已被禁用，请重新登录", "code": "auth_required"}), 401
            return redirect(url_for("views.login_page"))
        # 改密/重置密码后，旧会话全部失效：登录时刻早于 password_changed_at 则踢出
        password_changed_at = user.get("password_changed_at")
        if password_changed_at:
            changed_ts = _iso_to_ts(password_changed_at)
            login_at = session.get("login_at")
            if changed_ts is not None and (
                not isinstance(login_at, (int, float)) or login_at < changed_ts
            ):
                session.clear()
                if path.startswith("/api/"):
                    return jsonify({"ok": False, "error": "密码已更新，请重新登录", "code": "auth_required"}), 401
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

