"""treening 命令行入口。"""
from __future__ import annotations

import click


@click.group()
def cli():
    """treening — 一棵会生长的知识树。"""


@cli.command()
@click.option("--no-browser", is_flag=True, help="不自动打开浏览器")
@click.option("--debug", "debug_mode", is_flag=True, help="以调试模式运行（可断点，无需手动重启）")
def serve(no_browser, debug_mode):
    """启动本地服务并打开浏览器。"""
    import threading
    import webbrowser

    from .app import app
    from .config import config

    config.ensure_dirs()
    url = f"http://{config.HOST}:{config.PORT}"
    if not no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"treening → {url}  (Ctrl+C 退出)")
    # debug 模式不开 reloader：reloader 会起子进程导致调试器挂不上，
    # 且浏览器刷新即可拿到最新模板/静态文件，本应用模板渲染均在请求期进行。
    app.run(host=config.HOST, port=config.PORT, debug=debug_mode, use_reloader=False)


@cli.command()
def status():
    """查看配置状态（不含密钥）。"""
    from .config import config

    print(f"数据库: {config.DATABASE_URL}")
    print(f"模型:   {config.API_URL} / {config.MODEL}")
    print(f"Key:    {'已配置' if config.API_KEY else '未配置（首次运行请用向导）'}")
    print(f"配额:   {'启用' if config.QUOTA_ENABLED else '不限额（BYO-Key）'}")

