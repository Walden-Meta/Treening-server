"""treening 树状学习 API。

单用户本地模式：无登录墙，身份固定为 local-owner。
服务端持有会话历史、图边、配额（可选）与 provider 任务。
"""
from __future__ import annotations

import logging
import math
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from typing import Any

from flask import Blueprint, current_app, jsonify, request, send_file, session

from ..config import config
from ..services.exporter import render_export
from ..services.methodology import Methodology
from ..services.provider import TreeProvider, TreeProviderError
from ..services.store import TreeStore

logger = logging.getLogger(__name__)
api_bp = Blueprint("tree", __name__, url_prefix="/api/quiz")

INTERACTION_TYPES = {"question", "followup", "check", "custom", "correction"}
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tree-provider")
_submit_lock = threading.Lock()


def _store() -> TreeStore:
    return current_app.extensions["tree_store"]


def _methodology() -> Methodology:
    return current_app.extensions["methodology"]


def _identity() -> str:
    # 单用户固定身份；顺带把旧 quiz.db 中随机 user_id 的历史主题并入
    _store().claim_legacy_sessions(config.OWNER_ID)
    return config.OWNER_ID


def _client_ip() -> str:
    return request.remote_addr or "unknown"


def _max_branches() -> int:
    return _methodology().max_branches()


def _quota(user_id: str, ip_address: str) -> dict[str, Any]:
    max_questions = int(config.MAX_QUESTIONS)
    if not config.QUOTA_ENABLED:
        return {"used": 0, "remaining": None, "max": max_questions, "unlimited": True}
    return _store().get_quota(user_id, ip_address, max_questions)


def _branch_slot(interaction_type: str, parent_id: str | None) -> str:
    """把自由入口映射到三个可见分支槽位。"""
    if not parent_id:
        return "question"
    if interaction_type in {"followup", "check"}:
        return interaction_type
    return "custom"


def _session_payload(session_id: str, user_id: str) -> dict[str, Any]:
    store = _store()
    quiz_session = store.get_session(session_id, user_id)
    if not quiz_session:
        raise LookupError("tree session not found")
    return {
        "session": quiz_session,
        "nodes": store.list_nodes(session_id, user_id),
        "active_jobs": store.list_active_jobs(session_id, user_id),
        "quota": _quota(user_id, _client_ip()),
        "max_branches": _max_branches(),
    }


def _run_job(app, job_id: str, user_id: str) -> None:
    """在线程池中执行一次 provider 调用。"""
    with app.app_context():
        store = _store()
        job = store.get_job(job_id, user_id)
        if not job or job["status"] not in {"pending", "running"}:
            return
        store.update_job(job_id, user_id, status="running")
        try:
            path = store.get_path(job["session_id"], user_id, job["user_node_id"])
            path_ids = {node["id"] for node in path}
            context_limit = max(1, int(config.MAX_CONTEXT_MESSAGES))
            side_context = store.get_recent_context(
                job["session_id"],
                user_id,
                path_ids,
                limit=min(4, context_limit),
            )
            provider = TreeProvider(
                _methodology(),
                config.API_KEY,
                config.API_URL,
                config.MODEL,
                int(config.PROVIDER_TIMEOUT_SECONDS),
                context_limit,
            )
            result = provider.answer_with_summaries(
                path,
                side_context,
                job["interaction_type"],
            )
            if len(result) == 2:
                answer, legacy_summary = result
                question_summary = answer_summary = legacy_summary
            else:
                answer, question_summary, answer_summary = result
            user_metadata = {}
            if question_summary:
                user_metadata["summary"] = question_summary
            store.update_node_metadata(
                job["session_id"],
                user_id,
                job["user_node_id"],
                user_metadata,
            )
            assistant_metadata = {
                "job_id": job_id,
                "model": config.MODEL,
            }
            if answer_summary:
                assistant_metadata["summary"] = answer_summary
            assistant = store.add_node(
                job["session_id"],
                user_id,
                role="assistant",
                content=answer,
                parent_id=job["user_node_id"],
                branch_type=_branch_slot(job["interaction_type"], job["parent_id"]),
                metadata=assistant_metadata,
            )
            store.update_job(
                job_id,
                user_id,
                status="completed",
                answer=answer,
                assistant_node_id=assistant["id"],
            )
        except TreeProviderError as exc:
            if config.QUOTA_ENABLED:
                store.release_quota(user_id, job["ip_address"])
            store.update_job(
                job_id,
                user_id,
                status="failed",
                error=str(exc),
            )
        except Exception:
            logger.exception("Tree job %s failed", job_id)
            if config.QUOTA_ENABLED:
                store.release_quota(user_id, job["ip_address"])
            store.update_job(
                job_id,
                user_id,
                status="failed",
                error="unexpected tree processing error",
            )


# ── 会话 ──

@api_bp.route("/session", methods=["GET"])
def get_session():
    user_id = _identity()
    session_id = session.get("tree_session_id")
    if not isinstance(session_id, str) or not _store().get_session(session_id, user_id):
        quiz_session = _store().create_session(user_id)
        session_id = quiz_session["id"]
        session["tree_session_id"] = session_id
    return jsonify({"ok": True, **_session_payload(session_id, user_id)})


@api_bp.route("/session", methods=["POST"])
def create_session():
    user_id = _identity()
    quiz_session = _store().create_session(user_id)
    session["tree_session_id"] = quiz_session["id"]
    return jsonify({
        "ok": True,
        "session": quiz_session,
        "nodes": [],
        "quota": _quota(user_id, _client_ip()),
        "max_branches": _max_branches(),
    }), 201


@api_bp.route("/sessions", methods=["GET"])
def list_sessions():
    include_archived = request.args.get("include_archived", "0").lower() in {"1", "true", "yes"}
    return jsonify({"sessions": _store().list_sessions(_identity(), include_archived=include_archived)})


@api_bp.route("/sessions/<session_id>", methods=["GET"])
def get_session_by_id(session_id: str):
    user_id = _identity()
    if not _store().get_session(session_id, user_id):
        return jsonify({"error": "主题不存在", "code": "tree_session_not_found"}), 404
    session["tree_session_id"] = session_id
    return jsonify({"ok": True, **_session_payload(session_id, user_id)})


@api_bp.route("/sessions/<session_id>", methods=["PATCH"])
def update_session(session_id: str):
    data = request.get_json(silent=True) or {}
    updated = _store().update_session(
        session_id,
        _identity(),
        title=data.get("title") if isinstance(data.get("title"), str) else None,
        summary=data.get("summary") if isinstance(data.get("summary"), str) else None,
    )
    if not updated:
        return jsonify({"error": "主题不存在", "code": "tree_session_not_found"}), 404
    return jsonify({"session": updated})


@api_bp.route("/sessions/<session_id>", methods=["DELETE"])
def delete_session(session_id: str):
    if not _store().delete_session(session_id, _identity()):
        return jsonify({"error": "主题不存在", "code": "tree_session_not_found"}), 404
    if session.get("tree_session_id") == session_id:
        session.pop("tree_session_id", None)
    return jsonify({"deleted": True, "session_id": session_id})


@api_bp.route("/sessions/<session_id>/archive", methods=["POST"])
def archive_session(session_id: str):
    if not _store().archive_session(session_id, _identity()):
        return jsonify({"error": "主题不存在或已经归档", "code": "tree_session_not_found"}), 404
    if session.get("tree_session_id") == session_id:
        session.pop("tree_session_id", None)
    return jsonify({"archived": True, "session_id": session_id})


# ── 节点 ──

@api_bp.route("/sessions/<session_id>/nodes/<node_id>/summary", methods=["POST"])
def summarize_node(session_id: str, node_id: str):
    """按需为旧节点生成并持久化语义摘要。"""
    user_id = _identity()
    store = _store()
    node = store.get_node(node_id, session_id, user_id)
    if not node:
        return jsonify({"error": "节点不存在", "code": "tree_node_not_found"}), 404
    metadata = node.get("metadata")
    existing = metadata.get("summary") if isinstance(metadata, dict) else None
    existing = TreeProvider._normalize_summary(existing)
    if existing:
        return jsonify({"summary": existing, "node": node})
    if not config.API_KEY:
        return jsonify({"error": "学习服务尚未配置", "code": "tree_provider_unconfigured"}), 503
    provider = TreeProvider(
        _methodology(),
        config.API_KEY,
        config.API_URL,
        config.MODEL,
        int(config.PROVIDER_TIMEOUT_SECONDS),
        1,
    )
    try:
        summary = provider.summarize_node(
            node["content"], node["role"], node["branch_type"]
        )
    except TreeProviderError as exc:
        return jsonify({"error": str(exc), "code": "tree_summary_failed"}), 502
    updated = store.update_node_metadata(
        session_id, user_id, node_id, {"summary": summary}
    )
    return jsonify({"summary": summary, "node": updated})


@api_bp.route("/sessions/<session_id>/nodes/<node_id>/layout", methods=["PATCH"])
def update_node_layout(session_id: str, node_id: str):
    data = request.get_json(silent=True) or {}
    node = _store().get_node(node_id, session_id, _identity())
    if not node:
        return jsonify({"error": "节点不存在", "code": "tree_node_not_found"}), 404
    current = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
    current_layout = current.get("layout") if isinstance(current.get("layout"), dict) else {}
    layout: dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        value = data.get(key, current_layout.get(key))
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return jsonify({"error": "节点布局数据无效", "code": "tree_layout_invalid"}), 400
        layout[key] = round(float(value), 2)
    if not 220 <= layout["width"] <= 640 or not 90 <= layout["height"] <= 640:
        return jsonify({"error": "节点尺寸超出允许范围", "code": "tree_layout_invalid"}), 400
    updated = _store().update_node_layout(
        session_id, _identity(), node_id, layout
    )
    return jsonify({"node": updated, "layout": layout})


@api_bp.route("/sessions/<session_id>/nodes/<node_id>", methods=["DELETE"])
def delete_node(session_id: str, node_id: str):
    user_id = _identity()
    store = _store()
    node = store.get_node(node_id, session_id, user_id)
    if not node:
        return jsonify({"error": "节点不存在", "code": "tree_node_not_found"}), 404
    if node.get("role") != "user":
        return jsonify({
            "error": "只能删除发问节点",
            "code": "tree_delete_user_only",
        }), 400
    try:
        result = store.delete_node_subtree(session_id, user_id, node_id)
    except ValueError as exc:
        if str(exc) == "tree_delete_user_only":
            return jsonify({
                "error": "只能删除发问节点",
                "code": "tree_delete_user_only",
            }), 400
        raise
    if result is None:
        return jsonify({"error": "节点不存在", "code": "tree_node_not_found"}), 404
    if result.get("blocked"):
        return jsonify({
            "error": "该分支仍有学习请求处理中，请稍后再删除",
            "code": "tree_delete_busy",
        }), 409
    return jsonify({
        "deleted_node_ids": result["deleted_node_ids"],
        "parent_id": result["parent_id"],
        "branch_type": result["branch_type"],
        "nodes": store.list_nodes(session_id, user_id),
    })


# ── 提问与任务 ──

@api_bp.route("/ask", methods=["POST"])
def ask():
    user_id = _identity()
    ip_address = _client_ip()
    data = request.get_json(silent=True) or {}
    question = data.get("question")
    session_id = data.get("session_id") or session.get("tree_session_id")
    parent_id = data.get("parent_node_id")
    interaction_type = data.get("interaction_type", "question")

    if not isinstance(question, str) or not question.strip():
        return jsonify({"error": "问题不能为空", "code": "tree_question_required"}), 400
    question = question.strip()
    if len(question) > int(config.MAX_QUESTION_CHARS):
        return jsonify({"error": "问题过长，请缩短后重试", "code": "tree_question_too_long"}), 413
    if interaction_type not in INTERACTION_TYPES:
        return jsonify({"error": "不支持的交互类型", "code": "tree_interaction_invalid"}), 400
    if not config.API_KEY:
        return jsonify({"error": "学习服务尚未配置", "code": "tree_provider_unconfigured"}), 503

    store = _store()
    if not isinstance(session_id, str) or not store.get_session(session_id, user_id):
        quiz_session = store.create_session(user_id)
        session_id = quiz_session["id"]
        session["tree_session_id"] = session_id
    if parent_id is not None:
        parent = store.get_node(parent_id, session_id, user_id) if isinstance(parent_id, str) else None
        if not parent:
            return jsonify({"error": "目标节点不存在", "code": "tree_parent_not_found"}), 404
        if parent["role"] != "assistant":
            return jsonify({"error": "只能从回答节点继续", "code": "tree_parent_not_branchable"}), 400

    branch_slot = _branch_slot(interaction_type, parent_id)
    if parent_id:
        used_slots = store.get_child_branch_types(session_id, user_id, parent_id)
        max_branches = _max_branches()
        if branch_slot in used_slots:
            return jsonify({
                "error": "这个分支已经存在，请换一个入口",
                "code": "tree_branch_slot_used",
                "branch_slot": branch_slot,
                "used_slots": sorted(used_slots),
                "max_branches": max_branches,
            }), 409
        if len(used_slots) >= max_branches:
            return jsonify({
                "error": "这个回答下的分支已满",
                "code": "tree_branch_limit_reached",
                "used_slots": sorted(used_slots),
                "max_branches": max_branches,
            }), 409

    if store.active_job_count(user_id) >= int(config.MAX_INFLIGHT):
        return jsonify({"error": "已有学习请求处理中，请稍后", "code": "tree_busy"}), 429

    if not config.QUOTA_ENABLED:
        reservation = {"allowed": True, "remaining": None, "unlimited": True}
    else:
        reservation = store.reserve_quota(
            user_id,
            ip_address,
            int(config.MAX_QUESTIONS),
        )
    if not reservation["allowed"]:
        return jsonify({
            "error": "今日提问次数已用完",
            "code": "tree_quota_exhausted",
            **_quota(user_id, ip_address),
        }), 429

    try:
        user_node = store.add_node(
            session_id,
            user_id,
            role="user",
            content=question,
            parent_id=parent_id,
            branch_type=branch_slot,
        )
        job = store.create_job(
            session_id,
            user_id,
            ip_address,
            user_node["id"],
            parent_id,
            interaction_type,
            question,
        )
        app = current_app._get_current_object()
        with _submit_lock:
            _executor.submit(_run_job, app, job["id"], user_id)
    except ValueError as exc:
        if config.QUOTA_ENABLED:
            store.release_quota(user_id, ip_address)
        if str(exc) == "quiz branch slot used":
            return jsonify({
                "error": "这个分支已经存在，请换一个入口",
                "code": "tree_branch_slot_used",
                "branch_slot": branch_slot,
                "max_branches": _max_branches(),
            }), 409
        logger.exception("Failed to enqueue tree job")
        return jsonify({"error": "学习请求创建失败", "code": "tree_enqueue_failed"}), 500
    except Exception:
        if config.QUOTA_ENABLED:
            store.release_quota(user_id, ip_address)
        logger.exception("Failed to enqueue tree job")
        return jsonify({"error": "学习请求创建失败", "code": "tree_enqueue_failed"}), 500

    session["tree_session_id"] = session_id
    return jsonify({
        "ok": True,
        "job_id": job["id"],
        "session_id": session_id,
        "user_node": user_node,
        "branch_slot": branch_slot,
        "max_branches": _max_branches(),
        "quota": {
            "remaining": reservation["remaining"],
            "max": config.MAX_QUESTIONS,
            "unlimited": reservation.get("unlimited", False),
        },
    }), 202


@api_bp.route("/jobs/<job_id>", methods=["GET"])
def get_job(job_id: str):
    job = _store().get_job(job_id, _identity())
    if not job:
        return jsonify({"error": "任务不存在", "code": "tree_job_not_found"}), 404
    assistant_node = (
        _store().get_node(job["assistant_node_id"], job["session_id"], _identity())
        if job.get("assistant_node_id")
        else None
    )
    return jsonify({
        "id": job["id"],
        "status": job["status"],
        "answer": job["answer"],
        "error": job["error"],
        "assistant_node_id": job["assistant_node_id"],
        "assistant_node": assistant_node,
        "session_id": job["session_id"],
        "user_node_id": job["user_node_id"],
        "interaction_type": job["interaction_type"],
        "branch_slot": _branch_slot(job["interaction_type"], job["parent_id"]),
        "quota": _quota(_identity(), _client_ip()),
    })


# ── 配额与导出 ──

@api_bp.route("/quota", methods=["GET"])
def quota():
    user_id = _identity()
    return jsonify(_quota(user_id, _client_ip()))


@api_bp.route("/sessions/<session_id>/export", methods=["GET"])
def export_session(session_id: str):
    user_id = _identity()
    store = _store()
    quiz_session = store.get_session(session_id, user_id)
    if not quiz_session:
        return jsonify({"error": "主题不存在", "code": "tree_session_not_found"}), 404
    fmt = request.args.get("format", "md").lower()
    scope = request.args.get("scope", "tree").lower()
    node_id = request.args.get("node_id") or None
    try:
        content, mimetype, extension = render_export(
            quiz_session,
            store.list_nodes(session_id, user_id),
            fmt,
            scope,
            node_id,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "tree_export_invalid"}), 400
    except ImportError:
        return jsonify({"error": "DOCX 导出依赖未安装", "code": "tree_docx_unavailable"}), 503
    title = quiz_session.get("title") or quiz_session.get("root_question") or "tree-session"
    filename = re.sub(r"[^\w\-一-鿿]+", "-", title).strip("-")[:70] or "tree-session"
    return send_file(
        BytesIO(content),
        mimetype=mimetype,
        as_attachment=True,
        download_name=f"{filename}.{extension}",
        max_age=0,
    )
