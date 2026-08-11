"""Pytest fixtures for the treening backend test-suite.

隔离策略
--------
- 模块级：任何在 per-test fixture 运行前发生的 ``treening.app`` 导入，都会被指向
  一次性的临时 SQLite 文件（_collection.db），确保绝不会碰仓库里真实的
  ``data/tree.db``。
- 每个测试：``store`` / ``app`` fixture 用 ``tmp_path`` 生成全新的 SQLite 文件，
  ``config.reload()`` 重读 ``TREENING_*`` 环境变量，保证用例之间数据完全隔离。
- 环境变量统一用 ``TREENING_*`` 前缀，避免与真实 settings.json 交互。
"""
from __future__ import annotations

import os
import tempfile
from typing import Any, Iterator

import pytest

# ── 模块级安全网：任何早于 fixture 的导入都不允许指向真实数据库 ──
_TMP_ROOT = tempfile.mkdtemp(prefix="treening-pytest-")
os.environ["TREENING_DATABASE_URL"] = f"sqlite:///{_TMP_ROOT}/_collection.db"
os.environ["TREENING_API_KEY"] = "sk-pytest-safety-net"
# 测试环境关闭后台任务清扫器线程，避免 10s 轮询造成不确定性；需要时直接调 _sweep_tick
os.environ["TREENING_JOB_SWEEPER_ENABLED"] = "false"


def _point_config_at(db_path: Any) -> str:
    """把 TREENING_* 环境变量指向给定数据库文件，并让 config 重读。"""
    os.environ["TREENING_DATABASE_URL"] = f"sqlite:///{db_path}"
    os.environ["TREENING_API_KEY"] = "sk-pytest"
    os.environ["TREENING_JOB_SWEEPER_ENABLED"] = "false"
    from treening.config import config
    config.reload()
    return str(db_path)


@pytest.fixture
def db_path(tmp_path):
    """每个测试共享同一个数据库文件；store / app / client 全部读写它。"""
    db_file = tmp_path / "test.db"
    _point_config_at(db_file)
    return db_file


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """把 settings 模块的 SETTINGS_PATH 指向临时文件，绝不读写真实 data/settings.json。

    真实文件里含 SMTP 授权码、API Key 等敏感信息；测试必须与之完全隔离。
    """
    import treening.services.settings as settings_module
    fake_path = tmp_path / "settings.json"
    monkeypatch.setattr(settings_module, "SETTINGS_PATH", fake_path)
    return fake_path


@pytest.fixture
def store(db_path):
    """纯 store 层测试：指向测试库的 TreeStore，不启动 Flask。"""
    from treening.config import config
    from treening.services.store import TreeStore
    return TreeStore(config.DATABASE_URL)


@pytest.fixture
def app(db_path):
    """完整 Flask 应用：与 store 共享同一个测试库 + 真实 methodology 目录。"""
    from treening.app import create_app
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture
def client(app):
    """Flask 测试客户端。"""
    return app.test_client()


@pytest.fixture
def store_of(app):
    """从已创建的 Flask 应用取回 TreeStore 实例（与 client 共享同一库）。"""
    return app.extensions["tree_store"]


@pytest.fixture
def create_user(store):
    """工厂：store.create_user 的薄封装，测试内直接调用来造用户。"""
    def _create(username: str, role: str = "user", password: str = "password123", email: str = "") -> dict:
        from treening.services.auth import hash_password
        return store.create_user(username, hash_password(password), role=role, email=email)
    return _create


@pytest.fixture
def login(client):
    """工厂：登录一个用户，返回该用户的 JSON 请求头。"""
    def _login(username: str, password: str = "password123") -> dict:
        resp = client.post("/api/auth/login", json={"username": username, "password": password})
        assert resp.status_code == 200, resp.get_json()
        return {"Content-Type": "application/json"}
    return _login


@pytest.fixture
def alice_headers(store, client, login):
    """预置普通用户 alice 并登录，返回其请求头。"""
    from treening.services.auth import hash_password
    store.create_user("alice", hash_password("password123"), role="user", email="alice@example.com")
    return login("alice", "password123")


@pytest.fixture
def admin_headers(store, client, login):
    """预置管理员 admin 并登录，返回其请求头。"""
    from treening.services.auth import hash_password
    store.create_user("admin", hash_password("adminpass123"), role="admin")
    return login("admin", "adminpass123")


def make_tree(store, user_id: str) -> dict[str, Any]:
    """造一棵最小可用的树：根提问 → 模拟回答 → 一个分支。返回根会话。"""
    session = store.create_session(user_id)
    root = store.add_node(
        session["id"], user_id, role="user",
        content="什么是 Docker 的多阶段构建？", branch_type="question",
    )
    store.add_node(
        session["id"], user_id, role="assistant",
        content="多阶段构建让镜像更小……",
        parent_id=root["id"], branch_type="question",
    )
    return session
