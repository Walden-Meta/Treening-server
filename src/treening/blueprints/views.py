"""页面路由。"""
from pathlib import Path

from flask import Blueprint, current_app, redirect, render_template, request, send_file, session, url_for

from ..config import BASE_DIR, config

views_bp = Blueprint("views", __name__)


@views_bp.route("/")
def index():
    """主页面。已登录但未配置模型服务时自动跳转配置页。"""
    if config.API_KEY.strip() or request.args.get("skip") == "1":
        return render_template("tree.html")
    if session.get("role") == "admin":
        return redirect(url_for("views.setup_page"))
    return render_template("tree.html")


@views_bp.route("/login")
def login_page():
    """登录页。已登录用户访问时回主页面。"""
    if session.get("user_id"):
        return redirect(url_for("views.index"))
    return render_template("login.html")


@views_bp.route("/forgot")
def forgot_page():
    """忘记密码页（公开）。"""
    if session.get("user_id"):
        return redirect(url_for("views.index"))
    return render_template("forgot.html")


@views_bp.route("/reset")
def reset_page():
    """邮件里的重置链接落地页（公开）。token 来自 query 参数。

    注意：即使当前已登录也不重定向——拿到重置链接的人可能正需要
    重置自己（或另一个账号）的密码，链接本身就是一次性凭证。
    """
    return render_template("reset.html", token=request.args.get("token", ""))


@views_bp.route("/setup")
def setup_page():
    """首次运行配置页。"""
    return render_template("setup.html")


@views_bp.route("/admin")
def admin_page():
    """管理员面板页。访问守卫保证仅 admin 角色可进入。"""
    return render_template("admin.html")


@views_bp.route("/manual")
def manual_download():
    """下载操作手册 PDF（绑定到左上角 logo）。"""
    pdf = BASE_DIR / "docs" / "Treening-操作手册.pdf"
    if pdf.exists():
        return send_file(
            pdf,
            as_attachment=True,
            download_name="Treening-操作手册.pdf",
            mimetype="application/pdf",
        )
    return "操作手册尚未生成", 404


@views_bp.route("/api/health")
def health():
    """健康检查：供 Docker healthcheck 使用。带一次 DB 只读探测。

    DB 不可读时返回 503，避免「应用活着但数据库已坏」时健康检查仍显示绿。
    """
    try:
        current_app.extensions["tree_store"].health_check()
    except Exception:
        app_logger = current_app.logger
        app_logger.exception("health check failed: database probe error")
        return {"ok": False, "service": "treening", "database": "error"}, 503
    return {"ok": True, "service": "treening", "database": "ok"}

