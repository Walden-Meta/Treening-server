"""textree Flask 应用工厂。入口：textree serve 或 python -m textree"""
from __future__ import annotations

import hashlib
from pathlib import Path

from flask import Flask

from .config import BASE_DIR, config
from .services.methodology import Methodology
from .services.store import TreeStore


def _persistent_secret() -> str:
    """本地持久化 secret，保证重启后 session（当前主题）不失效。"""
    secret_path = BASE_DIR / "data" / ".secret"
    try:
        existing = secret_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass
    generated = hashlib.sha256(b"textree-local").hexdigest()
    try:
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(generated, encoding="utf-8")
    except OSError:
        pass
    return generated


def create_app() -> Flask:
    config.ensure_dirs()

    app = Flask(
        __name__,
        template_folder=str(Path(__file__).resolve().parent / "templates"),
        static_folder=str(Path(__file__).resolve().parent / "static"),
    )
    app.config["SECRET_KEY"] = _persistent_secret()
    app.config["TEXTREE"] = config

    app.extensions["tree_store"] = TreeStore(config.DATABASE_URL)
    app.extensions["methodology"] = Methodology(config.METHODOLOGY_DIR)

    from .blueprints import blueprints
    for bp in blueprints:
        app.register_blueprint(bp)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host=config.HOST, port=config.PORT, debug=False)

