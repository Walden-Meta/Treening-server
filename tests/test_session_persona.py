"""人设 key 体系：树级 persona 存 key（chunyu/rational/emotional/custom:N），
worker 解析成文字；自定义槽位 CRUD；预设列表 = 3 内置 + 用户槽位。"""
from __future__ import annotations

import pytest

FAKE_BLOCKS = {
    "answer": "答案：先接住。",
    "question_summary": "树洞",
    "answer_summary": "接住",
    "contradiction": "",
    "practice": "",
    "check_question": "",
    "reflect_question": "",
    "inspire_question": "",
}

# 旧版自由文本人设（迁移前的存量数据形态，仍应被兼容）
LEGACY_VENTING = "角色设定：情绪树洞，先接住你再说。"
# 新版 key：理性春宁（研究搭档）
RATIONAL_KEY = "rational"
# 旧「情绪树洞」应迁移成 emotional
EMOTIONAL_KEY = "emotional"


@pytest.fixture
def sync_provider(monkeypatch):
    from treening.blueprints import api as api_module

    captured: list[str] = []

    def fake_answer(self, path, side_context, interaction_type):
        captured.append(self.persona)
        return dict(FAKE_BLOCKS)

    monkeypatch.setattr(api_module.TreeProvider, "answer_with_blocks", fake_answer)

    class _SyncExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(api_module, "_executor", _SyncExecutor())
    return captured


class TestSessionPersonaCRUD:
    def test_create_session_with_key(self, client, alice_headers):
        resp = client.post("/api/quiz/session", json={"persona": RATIONAL_KEY}, headers=alice_headers)
        assert resp.status_code == 201
        assert resp.get_json()["session"]["persona"] == RATIONAL_KEY

    def test_create_session_accepts_legacy_text(self, client, alice_headers):
        resp = client.post("/api/quiz/session", json={"persona": LEGACY_VENTING}, headers=alice_headers)
        assert resp.status_code == 201
        assert resp.get_json()["session"]["persona"] == LEGACY_VENTING

    def test_create_session_defaults_empty(self, client, alice_headers):
        resp = client.post("/api/quiz/session", json={}, headers=alice_headers)
        assert resp.status_code == 201
        assert resp.get_json()["session"]["persona"] == ""

    def test_create_session_persona_too_long(self, client, alice_headers):
        resp = client.post(
            "/api/quiz/session", json={"persona": "x" * 4001}, headers=alice_headers
        )
        assert resp.status_code == 400

    def test_update_persona_to_key(self, client, alice_headers):
        sid = client.post(
            "/api/quiz/session", json={"persona": LEGACY_VENTING}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.patch(f"/api/quiz/sessions/{sid}", json={"persona": RATIONAL_KEY}, headers=alice_headers)
        assert resp.status_code == 200
        assert resp.get_json()["session"]["persona"] == RATIONAL_KEY

    def test_update_persona_to_empty(self, client, alice_headers):
        sid = client.post(
            "/api/quiz/session", json={"persona": RATIONAL_KEY}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.patch(f"/api/quiz/sessions/{sid}", json={"persona": ""}, headers=alice_headers)
        assert resp.status_code == 200
        assert resp.get_json()["session"]["persona"] == ""

    def test_update_title_does_not_touch_persona(self, client, alice_headers):
        sid = client.post(
            "/api/quiz/session", json={"persona": RATIONAL_KEY}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.patch(f"/api/quiz/sessions/{sid}", json={"title": "我的树"}, headers=alice_headers)
        assert resp.status_code == 200
        updated = resp.get_json()["session"]
        assert updated["title"] == "我的树"
        assert updated["persona"] == RATIONAL_KEY


class TestWorkerUsesSessionPersona:
    def test_ask_uses_session_key_resolved_to_text(self, client, alice_headers, sync_provider):
        sid = client.post(
            "/api/quiz/session", json={"persona": RATIONAL_KEY}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "帮我拆解这个问题", "session_id": sid},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        # key 被解析成内置理性春宁的文字（角色设定：理性春宁）
        assert sync_provider and sync_provider[0].startswith("角色设定：理性春宁")

    def test_ask_uses_legacy_text_as_is(self, client, alice_headers, sync_provider):
        sid = client.post(
            "/api/quiz/session", json={"persona": LEGACY_VENTING}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "我今天真的好气", "session_id": sid},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        assert sync_provider and sync_provider[0] == LEGACY_VENTING

    def test_ask_auto_created_tree_picks_persona_key(self, client, alice_headers, sync_provider):
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "今天真的好气", "persona": EMOTIONAL_KEY},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        assert sync_provider[0].startswith("角色设定：感性春宁")

    def test_ask_falls_back_to_user_global_persona(self, client, store_of, alice_headers, sync_provider):
        alice = store_of.get_user_by_username("alice")
        store_of.save_user_config(alice["id"], persona="自定义用户人设")
        sid = client.post("/api/quiz/session", json={}, headers=alice_headers).get_json()["session"]["id"]
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "q", "session_id": sid},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        assert sync_provider[0] == "自定义用户人设"

    def test_ask_falls_back_to_default_persona(self, client, alice_headers, sync_provider):
        sid = client.post("/api/quiz/session", json={}, headers=alice_headers).get_json()["session"]["id"]
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "q", "session_id": sid},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        # 无树级/用户级人设 → 全局默认（default_persona.md 春宁，开头是「角色设定」）
        assert sync_provider[0].startswith("角色设定")

    def test_ask_custom_slot_resolves_to_user_text(self, client, store_of, alice_headers, sync_provider):
        alice = store_of.get_user_by_username("alice")
        store_of.save_user_config(
            alice["id"],
            persona_slots=[
                {"name": "老工程师", "note": "直说不绕弯", "text": "你是一名老工程师。"},
                {"name": "", "note": "", "text": ""},
                {"name": "", "note": "", "text": ""},
            ],
        )
        sid = client.post(
            "/api/quiz/session", json={"persona": "custom:1"}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "q", "session_id": sid},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        assert sync_provider[0] == "你是一名老工程师。"

    def test_ask_custom_slot_missing_falls_back(self, client, alice_headers, sync_provider):
        # 槽位从未配置 → custom:1 退回全局默认
        sid = client.post(
            "/api/quiz/session", json={"persona": "custom:1"}, headers=alice_headers
        ).get_json()["session"]["id"]
        resp = client.post(
            "/api/quiz/ask",
            json={"question": "q", "session_id": sid},
            headers=alice_headers,
        )
        assert resp.status_code == 202
        assert sync_provider[0].startswith("角色设定")


class TestPersonaPresets:
    def test_presets_list_has_three_builtins(self, client, alice_headers):
        resp = client.get("/api/quiz/persona-presets", headers=alice_headers)
        assert resp.status_code == 200
        presets = resp.get_json()["presets"]
        by_id = {p["id"]: p for p in presets}
        assert set(by_id) == {"chunyu", "rational", "emotional"}
        assert by_id["chunyu"]["name"] == "春宁"
        assert by_id["rational"]["name"] == "理性春宁"
        assert by_id["emotional"]["name"] == "感性春宁"
        assert "先接住" in by_id["emotional"]["text"]

    def test_presets_list_includes_custom_slots(self, client, store_of, alice_headers):
        alice = store_of.get_user_by_username("alice")
        store_of.save_user_config(
            alice["id"],
            persona_slots=[
                {"name": "老工程师", "note": "直说不绕弯", "text": "你是一名老工程师。"},
                {"name": "", "note": "", "text": ""},
                {"name": "深夜朋友", "note": "短句有温度", "text": "你是一个深夜朋友。"},
            ],
        )
        resp = client.get("/api/quiz/persona-presets", headers=alice_headers)
        assert resp.status_code == 200
        by_id = {p["id"]: p for p in resp.get_json()["presets"]}
        # 3 内置 + 2 非空槽（空槽隐藏）
        assert set(by_id) == {"chunyu", "rational", "emotional", "custom:1", "custom:3"}
        assert by_id["custom:1"]["name"] == "老工程师"
        assert by_id["custom:3"]["note"] == "短句有温度"


class TestPersonaSlotSetupEndpoint:
    def test_save_slots_pads_to_three(self, client, alice_headers):
        resp = client.post(
            "/api/setup/persona-slots",
            json={"slots": [{"name": "老工程师", "note": "直说", "text": "你是一名老工程师。"}]},
            headers=alice_headers,
        )
        assert resp.status_code == 200
        d = resp.get_json()
        assert d["ok"]
        assert len(d["slots"]) == 3
        assert d["slots"][0] == {"name": "老工程师", "note": "直说", "text": "你是一名老工程师。"}
        assert d["slots"][1] == {"name": "", "note": "", "text": ""}

    def test_save_slots_too_many_rejected(self, client, alice_headers):
        resp = client.post(
            "/api/setup/persona-slots",
            json={"slots": [{"name": "a"} for _ in range(4)]},
            headers=alice_headers,
        )
        assert resp.status_code == 400

    def test_save_slots_name_too_long(self, client, alice_headers):
        resp = client.post(
            "/api/setup/persona-slots",
            json={"slots": [{"name": "x" * 21}]},
            headers=alice_headers,
        )
        assert resp.status_code == 400

    def test_save_slots_persisted(self, client, store_of, alice_headers):
        client.post(
            "/api/setup/persona-slots",
            json={"slots": [{"name": "A", "note": "N", "text": "T"}]},
            headers=alice_headers,
        )
        alice = store_of.get_user_by_username("alice")
        cfg = store_of.get_user_config(alice["id"])
        assert cfg["persona_slots"][0] == {"name": "A", "note": "N", "text": "T"}
        assert len(cfg["persona_slots"]) == 3

    def test_setup_get_returns_slots(self, client, store_of, alice_headers):
        alice = store_of.get_user_by_username("alice")
        store_of.save_user_config(
            alice["id"], persona_slots=[{"name": "X", "note": "", "text": "T"}, {}, {}]
        )
        resp = client.get("/api/setup", headers=alice_headers)
        assert resp.status_code == 200
        slots = resp.get_json()["persona_slots"]
        assert slots[0]["name"] == "X"


class TestPersonaKeyMigration:
    def test_legacy_colearning_to_chunyu(self, store):
        user = store.create_user("mig1", "hash")
        sid = store.create_session(user["id"], persona="角色设定：春宁，共学搭档")["id"]
        migrated = store._migrate_session_persona_keys()
        assert migrated == 1
        assert store.get_session(sid, user["id"])["persona"] == "chunyu"

    def test_legacy_venting_to_emotional(self, store):
        user = store.create_user("mig2", "hash")
        sid = store.create_session(user["id"], persona="角色设定：情绪树洞，先接住你")["id"]
        store._migrate_session_persona_keys()
        assert store.get_session(sid, user["id"])["persona"] == "emotional"

    def test_already_keyed_left_alone(self, store):
        user = store.create_user("mig3", "hash")
        sid = store.create_session(user["id"], persona="rational")["id"]
        migrated = store._migrate_session_persona_keys()
        assert migrated == 0
        assert store.get_session(sid, user["id"])["persona"] == "rational"

    def test_unknown_legacy_text_kept(self, store):
        user = store.create_user("mig4", "hash")
        text = "角色设定：某个完全自定义的角色"
        sid = store.create_session(user["id"], persona=text)["id"]
        store._migrate_session_persona_keys()
        assert store.get_session(sid, user["id"])["persona"] == text
