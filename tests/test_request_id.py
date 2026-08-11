"""A+B：错误响应统一带 request_id（回查日志用）+ 请求日志业务关联字段（job/session）。"""
from __future__ import annotations

import logging

import pytest

FAKE_BLOCKS = {
    "answer": "答案是：A+B。",
    "question_summary": "A+B",
    "answer_summary": "A+B 要点",
    "contradiction": "可以",
    "practice": "动手",
    "check_question": "检查问题",
    "reflect_question": "反思问题",
    "inspire_question": "启发问题",
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


def _rid_ok(caplog, rid: str):
    """从 caplog 里找回带该 rid 的请求日志记录。"""
    return [r for r in caplog.records if rid in r.getMessage()]


class TestRequestIdInBody:
    def test_error_body_contains_request_id_matching_header(self, client, alice_headers):
        resp = client.post("/api/quiz/ask", json={"question": ""}, headers=alice_headers)
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["code"] == "tree_question_required"
        assert data["request_id"]
        assert resp.headers["X-Request-Id"] == data["request_id"]

    def test_success_body_has_no_request_id_but_header_does(self, client, alice_headers, sync_provider):
        resp = client.post("/api/quiz/ask", json={"question": "什么是 A+B？"}, headers=alice_headers)
        assert resp.status_code == 202
        assert resp.headers["X-Request-Id"]
        assert "request_id" not in resp.get_json()

    def test_quota_exhausted_429_injects_request_id(self, client, store_of, alice_headers, sync_provider):
        # 配额=1：第一次 ask 消耗掉，第二次触发 429（0 在语义里是"不限"，不能用）
        store_of.set_user_quota(store_of.get_user_by_username("alice")["id"], 1)
        first = client.post("/api/quiz/ask", json={"question": "q", "idempotency_key": "k"}, headers=alice_headers)
        assert first.status_code == 202
        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        assert resp.status_code == 429
        assert resp.get_json()["request_id"]


class TestLogCorrelation:
    def test_ask_log_carries_job_id_and_session_id(self, client, app, alice_headers, sync_provider, caplog):
        with caplog.at_level(logging.INFO, logger="treening.app"):
            resp = client.post("/api/quiz/ask", json={"question": "日志关联测试"}, headers=alice_headers)
            assert resp.status_code == 202
        rid = resp.headers["X-Request-Id"]
        job_id = resp.get_json()["job_id"]
        session_id = resp.get_json()["session_id"]
        records = _rid_ok(caplog, rid)
        assert records, "没有找到带该 rid 的请求日志"
        line = records[0].getMessage()
        assert f"job={job_id}" in line
        assert f"sess={session_id}" in line

    def test_get_job_log_carries_job_id(self, client, app, alice_headers, sync_provider, caplog):
        resp = client.post("/api/quiz/ask", json={"question": "q"}, headers=alice_headers)
        job_id = resp.get_json()["job_id"]
        with caplog.at_level(logging.INFO, logger="treening.app"):
            r2 = client.get(f"/api/quiz/jobs/{job_id}", headers=alice_headers)
            assert r2.status_code == 200
        rid = r2.headers["X-Request-Id"]
        records = _rid_ok(caplog, rid)
        assert records, "没有找到带该 rid 的轮询日志"
        assert f"job={job_id}" in records[0].getMessage()

    def test_error_log_still_well_formed(self, client, alice_headers, caplog):
        with caplog.at_level(logging.INFO, logger="treening.app"):
            client.post("/api/quiz/ask", json={"question": ""}, headers=alice_headers)
        # 400 错误也照常打日志行（带 rid），不能因注入 request_id 把日志打崩
        error_records = [r for r in caplog.records if "-> 400" in r.getMessage()]
        assert error_records and "rid=" in error_records[0].getMessage()

