"""treening 树状学习 API。

单用户本地模式：无登录墙，身份固定为 local-owner。
服务端持有会话历史、图边、配额（可选）与 provider 任务。
"""
from __future__ import annotations

import logging
import math
import random
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any

from flask import Blueprint, current_app, jsonify, request, send_file, session

from ..config import config, layout_prefs_for
from ..persona_presets import (
    BUILTIN_PERSONA_KEYS,
    VALID_PERSONA_KEYS,
    persona_presets,
)
from ..services.exporter import export_basename, render_export
from ..services.methodology import Methodology
from ..services.provider import TreeProvider, TreeProviderError, is_retryable_provider_error
from ..services.store import TreeStore

logger = logging.getLogger(__name__)
api_bp = Blueprint("tree", __name__, url_prefix="/api/quiz")

INTERACTION_TYPES = {"question", "followup", "check", "custom", "correction"}
_executor = ThreadPoolExecutor(
    max_workers=int(config.JOB_EXECUTOR_WORKERS), thread_name_prefix="tree-provider"
)
_submit_lock = threading.Lock()


def _store() -> TreeStore:
    return current_app.extensions["tree_store"]


def _methodology() -> Methodology:
    return current_app.extensions["methodology"]


def _identity() -> str:
    """当前登录用户的 id（访问守卫已保证已登录，此处兜底）。"""
    user_id = session.get("user_id")
    if not user_id:
        raise TreeProviderError("auth required")
    return user_id


def _user_config() -> dict[str, Any]:
    """当前登录用户的个性化配置（persona/命名/拆解开关/模型）。无记录时返回空。"""
    cfg = _store().get_user_config(_identity())
    return cfg or {}


def _clean_persona(value: Any) -> str | None:
    """清洗树级人设输入。

    - 空 / 非 str → ''（= 春宁默认，树的 persona 留空即可）
    - 合法 key（chunyu / rational / emotional / custom:1..3）→ 原样返回
    - 旧版存的自由文本 → 保留（前端按「自定义人设」展示，后端可直用）
    - 超长 → None（调用方回 400）
    """
    if value is None or not isinstance(value, str):
        return ""
    persona = value.strip()
    if persona in VALID_PERSONA_KEYS:
        return persona
    if len(persona) > int(config.PERSONA_MAX_CHARS):
        return None
    return persona


def _persona_slots_of(user_cfg: dict[str, Any]) -> list[dict[str, str]]:
    """用户自定义人设槽位（最多 3 个，可空）。"""
    slots = user_cfg.get("persona_slots")
    if not isinstance(slots, list):
        return []
    cleaned: list[dict[str, str]] = []
    for s in slots[:3]:
        if isinstance(s, dict):
            cleaned.append({
                "name": str(s.get("name") or "").strip(),
                "note": str(s.get("note") or "").strip(),
                "text": str(s.get("text") or ""),
            })
    return cleaned


def _resolve_persona_text(persona: Any, user_cfg: dict[str, Any]) -> str:
    """把人设 key / 空值 / 旧文本 解析成实际给模型的文字。

    - 空 → 全局用户人设兜底 → 系统默认（春宁）
    - 内置 key → 对应预设文字
    - custom:N → 用户第 N 个自定义槽位文字（缺失则退回默认）
    - 其余 → 视为旧版自由文本，原样使用
    """
    text = persona.strip() if isinstance(persona, str) else ""
    if not text:
        global_persona = user_cfg.get("persona")
        if isinstance(global_persona, str) and global_persona.strip():
            return global_persona.strip()
        return config.persona()
    if text in BUILTIN_PERSONA_KEYS:
        for preset in persona_presets():
            if preset["id"] == text:
                return preset["text"]
        return config.persona()
    if text.startswith("custom:"):
        try:
            idx = int(text.split(":", 1)[1])
        except (ValueError, IndexError):
            idx = 0
        slots = _persona_slots_of(user_cfg)
        if 1 <= idx <= len(slots) and slots[idx - 1]["text"].strip():
            return slots[idx - 1]["text"].strip()
        return config.persona()
    return text


def _model_config_for(user_cfg: dict[str, Any]) -> tuple[str, str, str]:
    """解析用户实际生效的模型配置：用户自设字段优先，空字段回退全局默认。"""
    api_key = str(user_cfg.get("api_key") or "").strip() or config.API_KEY
    api_url = str(user_cfg.get("api_url") or "").strip() or config.API_URL
    model = str(user_cfg.get("model") or "").strip() or config.MODEL
    return api_key, api_url, model


def _branch_labels_for(user_cfg: dict[str, Any]) -> dict[str, str]:
    """用户命名覆盖 + rules.yaml 默认兜底（只合并非空覆盖）。"""
    overrides = {
        k: v.strip()
        for k, v in (user_cfg.get("branch_labels") or {}).items()
        if v and str(v).strip()
    }
    return {**config._default_branch_labels(), **overrides}


def _layout_prefs_for(user_cfg: dict[str, Any]) -> dict[str, float]:
    """用户布局偏好（qa_gap/branch_gap/node_width/node_height），默认兜底 + 范围夹取。"""
    return layout_prefs_for(user_cfg)


def _deconstruction_for(user_cfg: dict[str, Any]) -> list[str]:
    """用户拆解开关；未设置时默认全部开启。"""
    enabled = user_cfg.get("deconstruction_enabled")
    if isinstance(enabled, list) and enabled:
        valid = set(config.ALL_DECONSTRUCTION_BLOCKS)
        return [k for k in enabled if k in valid]
    return list(config.ALL_DECONSTRUCTION_BLOCKS)


def _client_ip() -> str:
    return request.remote_addr or "unknown"


def _max_branches() -> int:
    return _methodology().max_branches()


def _quota_max_for(user_id: str) -> int | None:
    """该用户的每日提问上限。None=不限额（管理员 / 单人无限配额）。"""
    user = _store().get_user_by_id(user_id)
    if user and user.get("role") == "admin":
        return None
    limit = (user or {}).get("quota_limit")
    if isinstance(limit, int) and limit > 0:
        return int(limit)
    if isinstance(limit, int) and limit == 0:
        return None  # 0 = 不限额
    return int(config.MAX_QUESTIONS)


def _quota(user_id: str, ip_address: str) -> dict[str, Any]:
    max_questions = _quota_max_for(user_id)
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
        "branch_labels": _branch_labels_for(_user_config()),
        "layout_prefs": _layout_prefs_for(_user_config()),
    }


def _worker_id() -> str:
    """执行线程的身份标识（租约/完成权归属）。"""
    return f"{threading.current_thread().name}:{uuid.uuid4().hex[:6]}"


def _lease_expiry() -> str:
    """本次执行的租约到期时间。"""
    return _after_iso(int(config.JOB_LEASE_TTL))


def _retry_delay_seconds(attempts: int) -> int:
    """指数退避 + 随机抖动：min(base * 2^(attempts-1), max) * (0.5 + rand())。
    attempts 为已完成尝试次数（重试排程时 = 当前 attempts）。"""
    base = max(1, int(config.JOB_RETRY_BASE_DELAY))
    cap = max(base, int(config.JOB_RETRY_MAX_DELAY))
    exponential = min(base * (2 ** max(0, attempts - 1)), cap)
    return max(1, int(exponential * (0.5 + random.random())))


def _after_iso(seconds: int) -> str:
    """now + seconds 的 ISO 时间（租约到期 / 重试排程）。"""
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _run_job(app, job_id: str, user_id: str) -> None:
    """在线程池中执行一次 provider 调用（带租约 / 自动重试 / 幂等完成）。"""
    with app.app_context():
        store = _store()
        job = store.get_job(job_id, user_id)
        if not job or job["status"] not in {"pending", "running"}:
            return
        current_attempt = int(job.get("attempts") or 1)
        worker = _worker_id()
        # 领取租约：标记 running 并刷新到期时间（清扫器据此刻收回挂起任务）
        store.update_job(job_id, user_id, status="running", lease_expires_at=_lease_expiry())
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
            # 后台线程无请求上下文，直接用传入的 user_id 读用户配置
            user_cfg = _store().get_user_config(user_id) or {}
            api_key, api_url, model = _model_config_for(user_cfg)
            # 人设优先级：本树 key > 用户全局人设（旧字段）> 系统默认（春宁）。
            # 树存的是 key（chunyu/rational/emotional/custom:N），
            # 生成时解析成对应文字（自定义槽位缺失则退回默认）。
            quiz_session = _store().get_session(job["session_id"], user_id) or {}
            persona = _resolve_persona_text(quiz_session.get("persona"), user_cfg)
            provider = TreeProvider(
                _methodology(),
                api_key,
                api_url,
                model,
                int(config.PROVIDER_TIMEOUT_SECONDS),
                context_limit,
                persona,
                _deconstruction_for(user_cfg),
                int(config.THINKING_BUDGET_TOKENS),
            )
            blocks = provider.answer_with_blocks(
                path,
                side_context,
                job["interaction_type"],
            )
            answer = blocks["answer"]
            question_summary = blocks["question_summary"] or TreeProvider.fallback_summary(job["question"])
            answer_summary = blocks["answer_summary"] or TreeProvider.fallback_summary(answer)
            user_metadata = {"summary": question_summary}
            store.update_node_metadata(
                job["session_id"],
                user_id,
                job["user_node_id"],
                user_metadata,
            )
            # 幂等完成：只有抢到「完成权」的执行者才能插入回答节点，
            # 防止租约过期重新领取后新旧 worker 同时完成生成重复节点。
            if not store.begin_completion(job_id, user_id, worker):
                # 赢家已插入回答节点；输家把 job 收尾为 completed，
                # 否则停在 running 会被清扫器无限重新领取（租约循环）。
                logger.warning("Tree job %s already completed by another worker, skip", job_id)
                store.update_job(
                    job_id,
                    user_id,
                    status="completed",
                    retryable=0,
                    lease_expires_at="",
                    next_attempt_at="",
                )
                return
            assistant_metadata = {
                "job_id": job_id,
                "model": model,
                "summary": answer_summary,
                "contradiction": blocks["contradiction"],
                "practice": blocks["practice"],
                "check_question": blocks["check_question"],
                "reflect_question": blocks["reflect_question"],
                "inspire_question": blocks["inspire_question"],
            }
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
                # 重试成功后清掉重试标记，避免「已完成但 retryable=1」的脏状态
                retryable=0,
                next_attempt_at="",
            )
        except TreeProviderError as exc:
            if is_retryable_provider_error(exc):
                next_attempt = current_attempt + 1
                if next_attempt <= int(config.JOB_MAX_ATTEMPTS):
                    # 可重试 + 未超上限：排程重试，保留配额预留（重试继续用同一预留）
                    store.update_job(
                        job_id,
                        user_id,
                        status="failed",
                        error=str(exc),
                        retryable=1,
                        attempts=next_attempt,
                        next_attempt_at=_after_iso(_retry_delay_seconds(current_attempt)),
                        lease_expires_at="",
                    )
                    return
                # 超过重试上限：按最终失败处理（释放配额）
                _finalize_failed(store, job_id, user_id, job, str(exc))
            else:
                _finalize_failed(store, job_id, user_id, job, str(exc))
        except Exception:
            logger.exception("Tree job %s failed", job_id)
            # 未预期异常按最终失败处理（不自动重试，避免掩盖 bug 反复扣 Provider 费）
            _finalize_failed(store, job_id, user_id, job, "unexpected tree processing error")


def _finalize_failed(
    store: TreeStore,
    job_id: str,
    user_id: str,
    job: dict[str, Any],
    error: str,
) -> None:
    """最终失败：标记 failed + 释放配额预留（只有最终失败才归还）。"""
    if config.QUOTA_ENABLED:
        store.release_quota(user_id, job["ip_address"])
    store.update_job(
        job_id,
        user_id,
        status="failed",
        error=error,
        retryable=0,
        lease_expires_at="",
        next_attempt_at="",
    )


def _sweep_tick(app) -> int:
    """清扫器单轮：领取到期重试/租约过期任务并重新提交，返回领取数。"""
    due = _store().sweep_due_jobs()
    for row in due:
        try:
            with _submit_lock:
                _executor.submit(_run_job, app, row["id"], row["user_id"])
        except RuntimeError:
            logger.warning("executor shut down, job %s not resubmitted", row["id"])
            break
    return len(due)


def start_job_sweeper(app) -> None:
    """启动后台清扫器：每 N 秒领取到期重试与租约过期的挂起任务。"""

    def _loop() -> None:
        interval = int(config.JOB_SWEEPER_INTERVAL)
        while True:
            time.sleep(interval)
            try:
                with app.app_context():
                    _sweep_tick(app)
            except Exception:
                logger.exception("job sweeper tick failed")

    thread = threading.Thread(target=_loop, daemon=True, name="tree-job-sweeper")
    thread.start()
    logger.info("job sweeper started (interval=%ss)", config.JOB_SWEEPER_INTERVAL)


# ── 会话 ──

@api_bp.route("/session", methods=["GET"])
def get_session():
    user_id = _identity()
    session_id = session.get("tree_session_id")
    if not isinstance(session_id, str) or not _store().get_session(session_id, user_id):
        # A read-only page visit must not create a permanent empty topic.
        # The first real question creates the session in ``ask`` instead.
        return jsonify({
            "ok": True,
            "session": None,
            "nodes": [],
            "active_jobs": [],
            "quota": _quota(user_id, _client_ip()),
            "max_branches": _max_branches(),
            "branch_labels": _branch_labels_for(_user_config()),
            "layout_prefs": _layout_prefs_for(_user_config()),
        })
    return jsonify({"ok": True, **_session_payload(session_id, user_id)})


@api_bp.route("/session", methods=["POST"])
def create_session():
    user_id = _identity()
    data = request.get_json(silent=True) or {}
    persona = _clean_persona(data.get("persona"))
    if persona is None:
        return jsonify({"error": "人设内容过长，请缩短后重试", "code": "tree_persona_too_long"}), 400
    quiz_session = _store().create_session(user_id, persona=persona)
    session["tree_session_id"] = quiz_session["id"]
    return jsonify({
        "ok": True,
        "session": quiz_session,
        "nodes": [],
        "quota": _quota(user_id, _client_ip()),
        "max_branches": _max_branches(),
        "branch_labels": _branch_labels_for(_user_config()),
        "layout_prefs": _layout_prefs_for(_user_config()),
    }), 201


@api_bp.route("/persona-presets", methods=["GET"])
def get_persona_presets():
    """可选人设列表 = 3 内置（春宁/理性/感性）+ 3 个用户自定义槽位（空槽隐藏）。

    前端按 id 匹配：id 是 key（chunyu/rational/emotional/custom:1..3），
    展示名与备注跟随编辑实时刷新。
    """
    user_cfg = _user_config()
    presets = persona_presets()
    for i, slot in enumerate(_persona_slots_of(user_cfg), start=1):
        if not slot["name"] and not slot["text"]:
            continue  # 空槽位不出现在选择列表
        presets.append({
            "id": f"custom:{i}",
            "name": slot["name"] or f"自定义人设 {i}",
            "note": slot["note"] or "我的自定义人设",
            "text": slot["text"],
        })
    return jsonify({"presets": presets})


@api_bp.route("/sessions", methods=["GET"])
def list_sessions():
    include_archived = request.args.get("include_archived", "0").lower() in {"1", "true", "yes"}
    include_drafts = request.args.get("include_drafts", "0").lower() in {"1", "true", "yes"}
    return jsonify({
        "sessions": _store().list_sessions(
            _identity(), include_archived=include_archived, include_drafts=include_drafts,
        ),
    })


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
    user_id = _identity()
    store = _store()
    new_title = data.get("title") if isinstance(data.get("title"), str) else None
    # 重名保护：同用户其他活跃主题已占用该标题时拒绝修改，前端可据此提示
    if new_title and store.session_title_taken(user_id, new_title, exclude_session_id=session_id):
        return jsonify({"error": "已存在同名学习主题，请换一个名称", "code": "title_conflict"}), 409
    # 只有请求显式带了 persona 才更新（切回默认传空字符串）；只改标题时不得动它
    if "persona" in data:
        new_persona = _clean_persona(data.get("persona"))
        if new_persona is None:
            return jsonify({"error": "人设内容过长，请缩短后重试", "code": "tree_persona_too_long"}), 400
    else:
        new_persona = None
    updated = store.update_session(
        session_id,
        user_id,
        title=new_title,
        summary=data.get("summary") if isinstance(data.get("summary"), str) else None,
        persona=new_persona,
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
    user_cfg = _user_config()
    api_key, api_url, model = _model_config_for(user_cfg)
    if not api_key:
        return jsonify({"error": "学习服务尚未配置", "code": "tree_provider_unconfigured"}), 503
    provider = TreeProvider(
        _methodology(),
        api_key,
        api_url,
        model,
        int(config.PROVIDER_TIMEOUT_SECONDS),
        1,
        user_cfg.get("persona") or config.persona(),
        _deconstruction_for(user_cfg),
        int(config.THINKING_BUDGET_TOKENS),
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


@api_bp.route("/sessions/<session_id>/layouts/clear", methods=["POST"])
def clear_session_layouts(session_id: str):
    """「紧凑排版」：清除该主题全部节点的已保存布局（尺寸/位置），恢复默认。

    卡片回到默认尺寸、位置按默认间距紧凑重排；其它主题不受影响。
    """
    user_id = _identity()
    store = _store()
    if not store.get_session(session_id, user_id):
        return jsonify({"error": "主题不存在", "code": "tree_session_not_found"}), 404
    cleared = store.clear_session_layouts(session_id, user_id)
    return jsonify({"ok": True, "cleared": cleared})


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

def _idempotent_response(job: dict[str, Any], store: TreeStore) -> Any:
    """幂等命中：返回既有任务的状态，不建新节点、不重复扣配额。

    前端拿到 job_id 后照常轮询 /jobs/<id>：进行中→继续等，已完成→渲染回答。
    """
    job_id = job.get("id") or ""
    user_id = job.get("user_id") or _identity()
    return jsonify({
        "ok": True,
        "job_id": job_id,
        "session_id": job.get("session_id") or "",
        "status": job.get("status") or "failed",
        "user_node_id": job.get("user_node_id") or "",
        "assistant_node_id": job.get("assistant_node_id") or "",
        "answer": job.get("answer") or "",
        "error": job.get("error") or "",
        "retryable": bool(job.get("retryable")),
        "idempotent": True,
        "quota": _quota(user_id, _client_ip()),
    })


@api_bp.route("/ask", methods=["POST"])
def ask():
    user_id = _identity()
    ip_address = _client_ip()
    data = request.get_json(silent=True) or {}
    question = data.get("question")
    session_id = data.get("session_id") or session.get("tree_session_id")
    parent_id = data.get("parent_node_id")
    interaction_type = data.get("interaction_type", "question")
    idempotency_key = data.get("idempotency_key")

    if not isinstance(question, str) or not question.strip():
        return jsonify({"error": "问题不能为空", "code": "tree_question_required"}), 400
    question = question.strip()
    if len(question) > int(config.MAX_QUESTION_CHARS):
        return jsonify({"error": "问题过长，请缩短后重试", "code": "tree_question_too_long"}), 413
    if interaction_type not in INTERACTION_TYPES:
        return jsonify({"error": "不支持的交互类型", "code": "tree_interaction_invalid"}), 400
    if idempotency_key is not None and (
        not isinstance(idempotency_key, str)
        or not idempotency_key.strip()
        or len(idempotency_key) > 100
    ):
        return jsonify({"error": "幂等键格式不正确", "code": "tree_idempotency_invalid"}), 400
    user_cfg = _user_config()
    api_key = _model_config_for(user_cfg)[0]
    if not api_key:
        return jsonify({"error": "学习服务尚未配置", "code": "tree_provider_unconfigured"}), 503

    store = _store()

    # 幂等：同 user + 同键的重复提交直接返回既有任务，不再建节点/不扣配额。
    if idempotency_key:
        existing = store.get_job_by_idempotency(user_id, idempotency_key)
        if existing:
            # 日志关联：幂等命中也要带上任务 id，便于按任务排查
            request.environ["job_id"] = existing["id"]
            request.environ["session_id"] = existing["session_id"]
            return _idempotent_response(existing, store)
    if not isinstance(session_id, str) or not store.get_session(session_id, user_id):
        # 直接提问自动建树时，可顺带带上新主题要用的树人设
        persona = _clean_persona(data.get("persona"))
        if persona is None:
            return jsonify({"error": "人设内容过长，请缩短后重试", "code": "tree_persona_too_long"}), 400
        quiz_session = store.create_session(user_id, persona=persona)
        session_id = quiz_session["id"]
        session["tree_session_id"] = session_id
    request.environ["session_id"] = session_id
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
    if store.global_active_job_count() >= int(config.MAX_GLOBAL_INFLIGHT):
        return jsonify({"error": "学习服务繁忙，请稍后再试", "code": "tree_busy_global"}), 429

    if not config.QUOTA_ENABLED:
        reservation = {"allowed": True, "remaining": None, "unlimited": True}
    else:
        reservation = store.reserve_quota(
            user_id,
            ip_address,
            _quota_max_for(user_id),
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
            idempotency_key=idempotency_key,
        )
        if job is not None:
            request.environ["job_id"] = job["id"]
        if job is None:
            # 并发下同幂等键被另一请求先写入：释放刚预留的配额，返回既有任务
            if config.QUOTA_ENABLED:
                store.release_quota(user_id, ip_address)
            existing = store.get_job_by_idempotency(user_id, idempotency_key)
            return _idempotent_response(existing or {"id": "", "status": "failed"}, store)
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
    # 日志关联：轮询链路按 job/session 过滤
    request.environ["job_id"] = job_id
    request.environ["session_id"] = job["session_id"]
    assistant_node = (
        _store().get_node(job["assistant_node_id"], job["session_id"], _identity())
        if job.get("assistant_node_id")
        else None
    )
    user_node = _store().get_node(job["user_node_id"], job["session_id"], _identity())
    return jsonify({
        "id": job["id"],
        "status": job["status"],
        "answer": job["answer"],
        "error": job["error"],
        "retryable": bool(job.get("retryable")),
        "attempts": int(job.get("attempts") or 1),
        "next_attempt_at": job.get("next_attempt_at") or "",
        "assistant_node_id": job["assistant_node_id"],
        "assistant_node": assistant_node,
        "user_node": user_node,
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
    filename = export_basename(quiz_session, scope)
    return send_file(
        BytesIO(content),
        mimetype=mimetype,
        as_attachment=True,
        download_name=f"{filename}.{extension}",
        max_age=0,
    )
