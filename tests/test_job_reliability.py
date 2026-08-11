"""任务可靠性：幂等键去重、自动重试+退避、租约回收、幂等完成、全局并发上限。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from treening.services.provider import TreeProviderError

FAKE_BLOCKS = {
    "answer": "答案是：可靠性让任务可重试且不重复。",
    "question_summary": "任务可靠性",
    "answer_summary": "可靠性要点",
    "contradiction": "可以",
    "practice": "动手",
    "check_question": "重试会重复扣费吗？",
    "reflect_question": "幂等的作用？",
    "inspire_question": "还能怎样？",
}


@pytest.fixture
def sync_provider(monkeypatch):
    """provider 返回固定回答，job 提交同步执行。"""
    from treening.blueprints import api as api_module

    monkeypatch.setattr(
        api_module.TreeProvider,
        "answer_with_blocks",
        lambda self, path, side_context, interaction_type: dict(FAKE_BLOCKS),
    )

    class _SyncExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(api_module, "_executor", _SyncExecutor())


def _past_iso() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()


# ---- store 层：幂等键 ----

class TestIdempotencyKeyStore:
    def test_create_job_stores_idempotency_key(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        root = store.add_node(session["id"], alice["id"], role="user", content="根", branch_type="question")
        job = store.create_job(session["id"], alice["id"], "ip", root["id"], None, "question", "q", idempotency_key="key-1")
        assert job["idempotency_key"] == "key-1"

    def test_duplicate_idempotency_key_returns_none(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        root = store.add_node(session["id"], alice["id"], role="user", content="根", branch_type="question")
        store.create_job(session["id"], alice["id"], "ip", root["id"], None, "question", "q", idempotency_key="dup")
        dup = store.create_job(session["id"], alice["id"], "ip", root["id"], None, "question", "q", idempotency_key="dup")
        assert dup is None

    def test_get_job_by_idempotency(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        root = store.add_node(session["id"], alice["id"], role="user", content="根", branch_type="question")
        job = store.create_job(session["id"], alice["id"], "ip", root["id"], None, "question", "q", idempotency_key="find-me")
        found = store.get_job_by_idempotency(alice["id"], "find-me")
        assert found["id"] == job["id"]

    def test_idempotency_scoped_per_user(self, store, create_user):
        alice = create_user("alice")
        bob = create_user("bob")
        sa = store.create_session(alice["id"])
        ra = store.add_node(sa["id"], alice["id"], role="user", content="根a", branch_type="question")
        store.create_job(sa["id"], alice["id"], "ip", ra["id"], None, "question", "qa", idempotency_key="shared-key")
        # 同一键在不同 user 下不冲突
        sb = store.create_session(bob["id"])
        rb = store.add_node(sb["id"], bob["id"], role="user", content="根b", branch_type="question")
        job_b = store.create_job(sb["id"], bob["id"], "ip", rb["id"], None, "question", "qb", idempotency_key="shared-key")
        assert job_b is not None


# ---- store 层：重试排程 / 租约回收 / 完成权 ----

class TestRetryAndLeaseStore:
    def _make_job(self, store, user_id, question="q"):
        session = store.create_session(user_id)
        root = store.add_node(session["id"], user_id, role="user", content="根", branch_type="question")
        return store.create_job(session["id"], user_id, "ip", root["id"], None, "question", question), session, root

    def test_sweep_returns_only_due_retries(self, store, create_user):
        alice = create_user("alice")
        future_job, _, _ = self._make_job(store, alice["id"])
        store.update_job(future_job["id"], alice["id"], status="failed", retryable=1,
                         next_attempt_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
        due_job, _, _ = self._make_job(store, alice["id"])
        store.update_job(due_job["id"], alice["id"], status="failed", retryable=1, next_attempt_at=_past_iso())

        due = store.sweep_due_jobs()
        ids = {row["id"] for row in due}
        assert due_job["id"] in ids
        assert future_job["id"] not in ids
        # 领取后回到 pending，等待执行器重跑
        assert store.get_job(due_job["id"], alice["id"])["status"] == "pending"

    def test_sweep_reclaims_expired_lease(self, store, create_user):
        alice = create_user("alice")
        job, _, _ = self._make_job(store, alice["id"])
        store.update_job(job["id"], alice["id"], status="running", lease_expires_at=_past_iso())
        due = store.sweep_due_jobs()
        assert any(row["id"] == job["id"] for row in due)
        assert store.get_job(job["id"], alice["id"])["status"] == "pending"

    def test_fresh_lease_not_reclaimed(self, store, create_user):
        alice = create_user("alice")
        job, _, _ = self._make_job(store, alice["id"])
        store.update_job(job["id"], alice["id"], status="running", lease_expires_at=(
            datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat())
        assert store.sweep_due_jobs() == []

    def test_begin_completion_single_winner(self, store, create_user):
        alice = create_user("alice")
        job, _, _ = self._make_job(store, alice["id"])
        store.update_job(job["id"], alice["id"], status="running")
        assert store.begin_completion(job["id"], alice["id"], "worker-A") is True
        assert store.begin_completion(job["id"], alice["id"], "worker-B") is False

    def test_requeue_failed_job(self, store, create_user):
        alice = create_user("alice")
        job, _, _ = self._make_job(store, alice["id"])
        store.update_job(job["id"], alice["id"], status="failed", error="boom", retryable=0)
        assert store.requeue_failed_job(job["id"]) is True
        recovered = store.get_job(job["id"], alice["id"])
        assert recovered["status"] == "pending"
        assert recovered["error"] is None

    def test_list_failed_jobs_includes_user_and_title(self, store, create_user):
        alice = create_user("alice")
        job, session, _ = self._make_job(store, alice["id"])
        store.update_job(job["id"], alice["id"], status="failed", error="boom")
        failed = store.list_failed_jobs()
        assert any(j["id"] == job["id"] and j["user_name"] == "alice" for j in failed)


# ---- API：幂等去重 ----

class TestAskIdempotency:
    def test_duplicate_key_returns_existing_job(self, client, store_of, alice_headers, sync_provider):
        first = client.post("/api/quiz/ask", json={
            "question": "什么是可靠性？", "idempotency_key": "stable-key",
        }, headers=alice_headers)
        assert first.status_code == 202, first.get_json()
        first_data = first.get_json()

        second = client.post("/api/quiz/ask", json={
            "question": "什么是可靠性？", "idempotency_key": "stable-key",
        }, headers=alice_headers)
        assert second.status_code == 200, second.get_json()
        second_data = second.get_json()
        assert second_data["idempotent"] is True
        assert second_data["job_id"] == first_data["job_id"]
        assert second_data["status"] == "completed"

    def test_duplicate_key_does_not_double_charge_quota(self, client, store_of, alice_headers, sync_provider):
        store_of.set_user_quota(store_of.get_user_by_username("alice")["id"], 1)
        first = client.post("/api/quiz/ask", json={"question": "q", "idempotency_key": "k1"}, headers=alice_headers)
        assert first.status_code == 202
        second = client.post("/api/quiz/ask", json={"question": "q", "idempotency_key": "k1"}, headers=alice_headers)
        assert second.status_code == 200
        alice = store_of.get_user_by_username("alice")
        assert store_of.quota_used_today(alice["id"]) == 1

    def test_duplicate_key_no_new_user_node(self, client, store_of, alice_headers, sync_provider):
        first = client.post("/api/quiz/ask", json={"question": "q", "idempotency_key": "k2"}, headers=alice_headers)
        session_id = first.get_json()["session_id"]
        nodes = store_of.list_nodes(session_id, store_of.get_user_by_username("alice")["id"])
        user_nodes_before = sum(1 for n in nodes if n["role"] == "user")

        client.post("/api/quiz/ask", json={"question": "q", "idempotency_key": "k2"}, headers=alice_headers)
        nodes = store_of.list_nodes(session_id, store_of.get_user_by_username("alice")["id"])
        assert sum(1 for n in nodes if n["role"] == "user") == user_nodes_before


# ---- API：自动重试 ----

def _patch_provider(monkeypatch, failures):
    """provider 前 failures 次抛可重试错误，之后返回固定回答。"""
    from treening.blueprints import api as api_module
    calls = {"n": 0}

    def _answer(self, path, side_context, interaction_type):
        calls["n"] += 1
        if calls["n"] <= failures:
            raise TreeProviderError("provider timeout")
        return dict(FAKE_BLOCKS)

    monkeypatch.setattr(api_module.TreeProvider, "answer_with_blocks", _answer)


class TestAutoRetry:
    def test_retryable_failure_schedules_retry_and_keeps_quota(self, client, store_of, alice_headers, monkeypatch):
        _patch_provider(monkeypatch, failures=1)
        from treening.blueprints import api as api_module

        class _SyncExecutor:
            def submit(self, fn, *args, **kwargs):
                fn(*args, **kwargs)
        monkeypatch.setattr(api_module, "_executor", _SyncExecutor())

        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        assert resp.status_code == 202, resp.get_json()
        job_id = resp.get_json()["job_id"]
        alice = store_of.get_user_by_username("alice")

        job = store_of.get_job(job_id, alice["id"])
        assert job["status"] == "failed"
        assert job["retryable"] == 1
        assert job["attempts"] == 2
        assert job["next_attempt_at"]
        # 可重试失败不释放配额（重试复用同一预留）
        assert store_of.quota_used_today(alice["id"]) == 1

    def test_sweep_retries_and_completes_with_single_answer(self, client, app, store_of, alice_headers, monkeypatch):
        _patch_provider(monkeypatch, failures=1)
        from treening.blueprints import api as api_module

        class _SyncExecutor:
            def submit(self, fn, *args, **kwargs):
                fn(*args, **kwargs)
        monkeypatch.setattr(api_module, "_executor", _SyncExecutor())

        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        job_id = resp.get_json()["job_id"]
        alice = store_of.get_user_by_username("alice")
        # 把重试时间拨到过去，让清扫器立即领取
        store_of.update_job(job_id, alice["id"], next_attempt_at=_past_iso())

        with app.app_context():
            api_module._sweep_tick(app)

        job = store_of.get_job(job_id, alice["id"])
        assert job["status"] == "completed"
        assert job["retryable"] == 0
        # 幂等完成：只生成一个回答节点
        assistant_nodes = [n for n in store_of.list_nodes(job["session_id"], alice["id"]) if n["role"] == "assistant"]
        assert len(assistant_nodes) == 1
        assert store_of.quota_used_today(alice["id"]) == 1

    def test_expired_lease_reclaim_completes_with_node(self, client, app, store_of, alice_headers, monkeypatch):
        """worker 抢到完成权但未插入节点就崩溃：租约回收后新 worker 能补齐回答节点。"""
        _patch_provider(monkeypatch, failures=0)
        from treening.blueprints import api as api_module

        class _SyncExecutor:
            def submit(self, fn, *args, **kwargs):
                fn(*args, **kwargs)
        monkeypatch.setattr(api_module, "_executor", _SyncExecutor())

        alice = store_of.get_user_by_username("alice")
        session = store_of.create_session(alice["id"])
        root = store_of.add_node(session["id"], alice["id"], role="user", content="根", branch_type="question")
        job = store_of.create_job(session["id"], alice["id"], "ip", root["id"], None, "question", "q")

        # 模拟崩溃窗口：租约已过期、完成权被前一 worker 占用、尚未插入回答节点
        store_of.update_job(job["id"], alice["id"], status="running",
                            lease_expires_at=_past_iso(), completion_owner="worker-A")

        with app.app_context():
            api_module._sweep_tick(app)

        finished = store_of.get_job(job["id"], alice["id"])
        assert finished["status"] == "completed"
        # 回答节点确实存在（不是误标 completed）
        assistant_nodes = [n for n in store_of.list_nodes(job["session_id"], alice["id"]) if n["role"] == "assistant"]
        assert len(assistant_nodes) == 1

    def test_exhausted_retries_release_quota(self, client, app, store_of, alice_headers, monkeypatch):
        _patch_provider(monkeypatch, failures=99)
        from treening.blueprints import api as api_module
        from treening.config import config

        monkeypatch.setenv("TREENING_JOB_MAX_ATTEMPTS", "2")
        config.reload()

        class _SyncExecutor:
            def submit(self, fn, *args, **kwargs):
                fn(*args, **kwargs)
        monkeypatch.setattr(api_module, "_executor", _SyncExecutor())

        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        job_id = resp.get_json()["job_id"]
        alice = store_of.get_user_by_username("alice")

        # 第一次失败 → 排程（attempts=2），拨到过去后清扫重跑
        store_of.update_job(job_id, alice["id"], next_attempt_at=_past_iso())
        with app.app_context():
            api_module._sweep_tick(app)

        job = store_of.get_job(job_id, alice["id"])
        assert job["status"] == "failed"
        assert job["retryable"] == 0
        # 重试耗尽 → 最终失败释放配额
        assert store_of.quota_used_today(alice["id"]) == 0


# ---- API：全局并发上限 ----

class TestGlobalInflight:
    def test_global_inflight_returns_429(self, client, store_of, alice_headers, monkeypatch):
        from treening.config import config
        from treening.blueprints import api as api_module

        monkeypatch.setenv("TREENING_MAX_GLOBAL_INFLIGHT", "2")
        config.reload()
        class _NeverExecutor:
            def submit(self, fn, *args, **kwargs):
                pass
        monkeypatch.setattr(api_module, "_executor", _NeverExecutor())

        # 直接用 store 造 2 个 pending 任务（不同用户，避免触发每用户上限）
        for name in ("u1", "u2"):
            user = store_of.create_user(name, "h")
            session = store_of.create_session(user["id"])
            root = store_of.add_node(session["id"], user["id"], role="user", content="根", branch_type="question")
            store_of.create_job(session["id"], user["id"], "ip", root["id"], None, "question", "q")

        busy = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        assert busy.status_code == 429
        assert busy.get_json()["code"] == "tree_busy_global"


# ---- API：管理员重放 ----

class TestAdminRetry:
    def test_admin_can_retry_failed_job(self, client, store_of, alice_headers, sync_provider):
        # 造一个失败任务
        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        job_id = resp.get_json()["job_id"]
        alice = store_of.get_user_by_username("alice")
        store_of.update_job(job_id, alice["id"], status="failed", error="boom", retryable=0)

        # 登录管理员
        from treening.services.auth import hash_password
        store_of.create_user("admin", hash_password("password123"), role="admin")
        client.post("/api/auth/login", json={"username": "admin", "password": "password123"})

        retry = client.post(f"/api/admin/jobs/{job_id}/retry")
        assert retry.status_code == 200, retry.get_json()
        assert retry.get_json()["ok"] is True
        assert store_of.get_job(job_id, alice["id"])["status"] == "completed"

    def test_retry_requires_admin(self, client, store_of, alice_headers):
        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        job_id = resp.get_json()["job_id"]
        denied = client.post(f"/api/admin/jobs/{job_id}/retry")
        assert denied.status_code == 403

