"""P1：统一入参校验 + 管理操作审计日志。"""
from __future__ import annotations

import pytest

from treening.services.auth import hash_password
from treening.services.validation import validate


def _seed_admin(store_of) -> None:
    store_of.create_user("admin", hash_password("password123"), role="admin")


class TestValidationHelper:
    """validate() 声明式校验规则。"""

    def test_required_missing_and_blank(self):
        assert validate({}, {"a": {"required": True, "label": "字段"}}) == "请填写字段"
        assert validate({"a": "  "}, {"a": {"required": True, "label": "字段"}}) == "请填写字段"

    def test_optional_absent_is_ok(self):
        assert validate({}, {"a": {"type": "string", "max_len": 10}}) is None

    def test_int_coercion_and_range(self):
        assert validate({"n": "12"}, {"n": {"type": "int", "min": 1, "max": 65535}}) is None
        assert validate({"n": 70000}, {"n": {"type": "int", "min": 1, "max": 65535}}) == "n不能大于 65535"
        assert validate({"n": "abc"}, {"n": {"type": "int"}}) == "n必须是整数"

    def test_choices(self):
        err = validate({"m": "x"}, {"m": {"choices": ["open", "closed"], "label": "模式"}})
        assert err == "模式必须是open/closed之一"
        assert validate({"m": "open"}, {"m": {"choices": ["open", "closed"]}}) is None

    def test_pattern_with_msg(self):
        err = validate(
            {"u": "bad name!"},
            {"u": {"type": "string", "pattern": r"^[A-Za-z0-9]{2,20}$", "pattern_msg": "格式不对"}},
        )
        assert err == "格式不对"
        assert validate({"u": "okname"}, {"u": {"pattern": r"^[A-Za-z0-9]{2,20}$"}}) is None

    def test_list_empty_and_required_semantics(self):
        # 非必填 + 空 list = 跳过
        assert validate({"codes": []}, {"codes": {"type": "list"}}) is None
        # 必填 + 空 list = 视为未填
        assert validate({"codes": []}, {"codes": {"type": "list", "required": True}}) == "请填写codes"
        # 必填 + allow_empty = 空 list 合法
        assert validate({"codes": []}, {"codes": {"type": "list", "required": True, "allow_empty": True}}) is None

    def test_strict_type_rejects_non_string(self):
        assert validate({"u": 123}, {"u": {"type": "string"}}) == "u必须是文本"


class TestAuditLog:
    """管理操作被记录到审计日志，且可从 /api/admin/audit 读取。"""

    def test_admin_create_user_records_audit(self, client, store_of):
        _seed_admin(store_of)
        client.post("/api/auth/login", json={"username": "admin", "password": "password123"})
        resp = client.post("/api/admin/users", json={
            "username": "bob", "password": "password123", "email": "bob@example.com",
        })
        assert resp.status_code == 201
        audit = client.get("/api/admin/audit")
        assert audit.status_code == 200
        entries = audit.get_json()["entries"]
        assert any(
            e["action"] == "user.create" and e["target"] == "bob" and e["actor_name"] == "admin"
            for e in entries
        )

    def test_admin_update_user_records_audit(self, client, store_of):
        _seed_admin(store_of)
        store_of.create_user("bob", hash_password("password123"), role="user")
        client.post("/api/auth/login", json={"username": "admin", "password": "password123"})
        bob_id = store_of.get_user_by_username("bob")["id"]
        resp = client.patch(f"/api/admin/users/{bob_id}", json={"is_active": False})
        assert resp.status_code == 200
        entries = client.get("/api/admin/audit").get_json()["entries"]
        assert any(
            e["action"] == "user.update" and e["target"] == "bob" and "禁用" in e["detail"]
            for e in entries
        )

    def test_registration_change_records_audit(self, client, store_of):
        _seed_admin(store_of)
        client.post("/api/auth/login", json={"username": "admin", "password": "password123"})
        from treening.services.settings import save_registration
        try:
            resp = client.post("/api/admin/registration", json={"mode": "closed"})
            assert resp.status_code == 200
        finally:
            save_registration("open", [])
        entries = client.get("/api/admin/audit").get_json()["entries"]
        assert any(e["action"] == "registration.update" and e["target"] == "closed" for e in entries)

    def test_audit_requires_admin(self, client, store_of):
        store_of.create_user("alice", hash_password("password123"), role="user")
        client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
        resp = client.get("/api/admin/audit")
        assert resp.status_code == 403
