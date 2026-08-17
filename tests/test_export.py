"""导出：render_export 的 md/text/docx/vault 格式与 API 导出端点。"""
from __future__ import annotations

import io
import json
import zipfile
from urllib.parse import unquote

import pytest

from treening.services.exporter import export_basename, render_export


def _nodes(store, user_id: str, session_id: str) -> list[dict]:
    return store.list_nodes(session_id, user_id)


def _make_tree(store, user_id: str):
    session = store.create_session(user_id)
    root = store.add_node(session["id"], user_id, role="user", content="Docker 是什么？", branch_type="question")
    answer = store.add_node(
        session["id"], user_id, role="assistant",
        content="Docker 是一个容器运行时……", parent_id=root["id"], branch_type="question",
        metadata={
            "summary": "Docker 容器运行时",
            "contradiction": "宿主机与隔离环境之间的张力",
            "practice": "安装并运行一个容器",
            "check_question": "Docker 与虚拟机的区别是什么？",
            "reflect_question": "它解决了你哪类部署痛点？",
            "inspire_question": "Kubernetes 如何编排容器？",
        },
    )
    check = store.add_node(
        session["id"], user_id, role="user", content="验收一下", parent_id=answer["id"], branch_type="check",
    )
    store.add_node(
        session["id"], user_id, role="assistant", content="Docker 与虚拟机的区别在于共享内核……",
        parent_id=check["id"], branch_type="check",
    )
    return session


def _unzip(content: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return {name: archive.read(name).decode("utf-8") for name in archive.namelist()}


class TestExportBasename:
    def test_strips_punctuation_and_whitespace(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        session["title"] = "Docker 入门 / 速成【第1课】#?"
        assert export_basename(session, "tree") == "Docker-入门-速成-第1课"

    def test_adds_scope_suffix_for_partial_export(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        session["title"] = "Docker 入门"
        assert export_basename(session, "tree") == "Docker-入门"
        assert export_basename(session, "path") == "Docker-入门-路径"
        assert export_basename(session, "subtree") == "Docker-入门-子树"

    def test_vault_folder_matches_download_basename(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "path")
        names = _unzip(content).keys()
        expected = export_basename(session, "path")
        assert any(name.startswith(f"{expected}/") for name in names)


class TestRenderMarkdown:
    def test_tree_scope_includes_question_and_answer(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, mimetype, ext = render_export(session, _nodes(store, alice["id"], session["id"]), "md", "tree")
        md = content.decode("utf-8")  # render_export 返回 UTF-8 bytes
        assert "Docker 是什么？" in md
        assert "Docker 是一个容器运行时……" in md
        assert mimetype.startswith("text/markdown")
        assert ext == "md"

    def test_empty_tree_does_not_crash(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        md, _, _ = render_export(session, [], "md", "tree")
        assert isinstance(md, bytes)


class TestRenderText:
    def test_text_export_contains_content(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, mimetype, ext = render_export(session, _nodes(store, alice["id"], session["id"]), "txt", "tree")
        assert "Docker 是什么？" in content.decode("utf-8")
        assert ext == "txt"


class TestRenderDocx:
    def test_docx_export_returns_bytes(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, mimetype, ext = render_export(session, _nodes(store, alice["id"], session["id"]), "docx", "tree")
        assert isinstance(content, bytes)
        assert len(content) > 0
        assert mimetype == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        assert ext == "docx"

    def test_invalid_format_raises(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        with pytest.raises(ValueError):
            render_export(session, _nodes(store, alice["id"], session["id"]), "pdf", "tree")


class TestRenderVault:
    def test_vault_returns_zip_bytes(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, mimetype, ext = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        assert isinstance(content, bytes)
        assert len(content) > 0
        assert mimetype == "application/zip"
        assert ext == "zip"

    def test_obsidian_alias(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, mimetype, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "obsidian", "tree")
        assert mimetype == "application/zip"
        assert content[:2] == b"PK"

    def test_vault_contains_moc_and_notes(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        files = _unzip(content)
        names = list(files.keys())
        assert any(name.endswith("MOC.md") for name in names)
        assert any(name.endswith(".md") and "MOC" not in name for name in names)

    def test_note_frontmatter_has_contract_fields(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        files = _unzip(content)
        note = next(text for name, text in files.items() if "MOC" not in name and name.endswith(".md"))
        for field in ("id:", "type: concept", "level: L2", "status:", "title:"):
            assert field in note

    def test_verified_status_when_check_child_exists(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        files = _unzip(content)
        notes = {name: text for name, text in files.items() if "MOC" not in name}
        # 有验收分支的回答应被标记为 verified
        assert any("status: verified" in text for text in notes.values())

    def test_wikilinks_connect_related_concepts(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        files = _unzip(content)
        note = next(text for name, text in files.items() if "MOC" not in name and name.endswith(".md"))
        assert "## 关联" in note
        assert "[[" in note and "]]" in note

    def test_question_answer_are_packaged_together(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        files = _unzip(content)
        note = next(text for name, text in files.items() if "MOC" not in name and name.endswith(".md"))
        # 问答对必须清晰成对出现，且排在拆解/关联之前
        assert "## 问题" in note
        assert "## 回答" in note
        assert note.index("## 问题") < note.index("## 回答")
        assert "Docker 是什么？" in note
        assert "Docker 是一个容器运行时……" in note

    def test_deconstruction_uses_chinese_labels(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        files = _unzip(content)
        note = next(text for name, text in files.items() if "MOC" not in name and name.endswith(".md"))
        assert "## 拆解" in note
        assert "矛盾论 · 认识拆解" in note
        assert "实践论 · 行动指向" in note
        assert "问题 · 验收" in note
        assert "问题 · 反思" in note
        assert "问题 · 启发" in note
        # 英文模板节名应已不再出现
        assert "Abstraction and Mechanism" not in note
        assert "Practice and Need" not in note

    def test_empty_tree_still_yields_moc(self, store, create_user):
        alice = create_user("alice")
        session = store.create_session(alice["id"])
        content, _, _ = render_export(session, [], "vault", "tree")
        files = _unzip(content)
        assert any(name.endswith("MOC.md") for name in files)


class TestRenderCanvas:
    def _canvas(self, store, user_id, session):
        content, _, _ = render_export(session, _nodes(store, user_id, session["id"]), "vault", "tree")
        files = _unzip(content)
        canvas_name = next(name for name in files if name.endswith(".canvas"))
        return canvas_name, files, json.loads(files[canvas_name])

    def test_vault_contains_canvas(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        content, _, _ = render_export(session, _nodes(store, alice["id"], session["id"]), "vault", "tree")
        names = _unzip(content).keys()
        assert any(name.endswith(".canvas") for name in names)

    def test_canvas_has_file_nodes_and_edges(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        _, _, canvas = self._canvas(store, alice["id"], session)
        file_nodes = [n for n in canvas["nodes"] if n["type"] == "file"]
        assert len(file_nodes) >= 2  # 根回答 + 验收回答
        assert any(n["type"] == "text" for n in canvas["nodes"])
        assert len(canvas["edges"]) >= 2

    def test_canvas_file_refs_point_to_real_notes(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        _, files, canvas = self._canvas(store, alice["id"], session)
        # 每个 file 节点引用的相对路径在 zip 里都能找到（去掉 vault 前缀后按 basename 匹配）
        basenames = {name.split("/")[-1] for name in files}
        for node in canvas["nodes"]:
            if node["type"] == "file":
                assert node["file"].split("/")[-1] in basenames

    def test_canvas_edges_connect_existing_nodes(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        _, _, canvas = self._canvas(store, alice["id"], session)
        node_ids = {n["id"] for n in canvas["nodes"]}
        for edge in canvas["edges"]:
            assert edge["fromNode"] in node_ids
            assert edge["toNode"] in node_ids

    def test_canvas_defaults_color_and_label_edges(self, store, create_user):
        alice = create_user("alice")
        session = _make_tree(store, alice["id"])
        _, _, canvas = self._canvas(store, alice["id"], session)
        # 每个 file 节点都带着色预设（1..6）
        for node in canvas["nodes"]:
            if node["type"] == "file":
                assert node.get("color") in {"1", "2", "3", "4", "5", "6"}
        # 除标题边外，每条边都带分支标签与箭头方向
        tree_edges = [e for e in canvas["edges"] if e["fromNode"] != "canvas-title"]
        assert tree_edges, "expected at least one parent-child edge"
        for edge in tree_edges:
            assert edge["toEnd"] == "arrow"
            assert edge.get("label") in {"起点问题", "验收", "追问", "其他"}


class TestExportAPI:
    def test_export_requires_login(self, client, store_of, create_user):
        alice = create_user("alice")
        session = _make_tree(store_of, alice["id"])
        assert client.get(f"/api/quiz/sessions/{session['id']}/export").status_code == 401

    def test_export_markdown_download(self, client, store_of, alice_headers):
        alice = store_of.get_user_by_username("alice")
        session = _make_tree(store_of, alice["id"])
        resp = client.get(f"/api/quiz/sessions/{session['id']}/export?format=md", headers=alice_headers)
        assert resp.status_code == 200
        assert resp.mimetype == "text/markdown"
        assert "Docker 是什么？" in resp.get_data(as_text=True)

    def test_export_vault_download(self, client, store_of, alice_headers):
        alice = store_of.get_user_by_username("alice")
        session = _make_tree(store_of, alice["id"])
        resp = client.get(f"/api/quiz/sessions/{session['id']}/export?format=vault", headers=alice_headers)
        assert resp.status_code == 200
        assert resp.mimetype == "application/zip"
        assert resp.data[:2] == b"PK"

    def test_download_name_is_standardized(self, client, store_of, alice_headers):
        alice = store_of.get_user_by_username("alice")
        session = _make_tree(store_of, alice["id"])
        resp = client.get(
            f"/api/quiz/sessions/{session['id']}/export?format=md&scope=subtree",
            headers=alice_headers,
        )
        disposition = resp.headers["Content-Disposition"]
        # Flask 用 RFC 5987 的 filename* 传输中文名，浏览器端解码后即标准文件名
        assert "filename*=UTF-8''" in disposition
        encoded = disposition.split("filename*=UTF-8''", 1)[1]
        assert unquote(encoded) == "Docker-是什么-子树.md"

    def test_export_unknown_session_404(self, client, alice_headers):
        resp = client.get("/api/quiz/sessions/missing/export", headers=alice_headers)
        assert resp.status_code == 404

    def test_export_cannot_read_other_users_session(self, client, store_of, alice_headers, create_user):
        bob = create_user("bob")
        bob_session = _make_tree(store_of, bob["id"])
        resp = client.get(f"/api/quiz/sessions/{bob_session['id']}/export", headers=alice_headers)
        assert resp.status_code == 404
