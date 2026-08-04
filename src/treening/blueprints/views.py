"""页面路由。"""
from flask import Blueprint, current_app, jsonify, redirect, render_template, request, url_for

from ..config import config

views_bp = Blueprint("views", __name__)


@views_bp.route("/api/health")
def health():
    """健康检查：进程存活 + SQLite 可读。

    供 Docker HEALTHCHECK / 外部探活使用，不做任何重活。
    """
    try:
        current_app.extensions["tree_store"].ping()
    except Exception:
        return jsonify({"status": "unhealthy"}), 503
    return jsonify({"status": "ok"})


@views_bp.route("/")
def index():
    """主页面。未配置模型服务时自动跳转首次配置页。"""
    if not config.API_KEY.strip() and request.args.get("skip") != "1":
        return redirect(url_for("views.setup_page"))
    return render_template("tree.html")


@views_bp.route("/setup")
def setup_page():
    """首次运行配置页。"""
    return render_template("setup.html")

