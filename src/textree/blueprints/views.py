"""页面路由。"""
from flask import Blueprint, redirect, render_template, request, url_for

from ..config import config

views_bp = Blueprint("views", __name__)


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

