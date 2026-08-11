"""Small SQLite repository for textbook-learning sessions.

The quiz deliberately has its own database.  It is a learning graph, not a
normal assistant conversation, and keeping it separate makes the first
iteration reversible without touching conversation or memory data.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _after_seconds(seconds: int) -> str:
    """now + seconds 的 ISO 时间（用于重试排程 / 租约到期）。"""
    from datetime import timedelta

    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


# 新账号默认第一个样例：「你是谁」主题树。纯静态、不触发模型调用，
# 完整演示「问题 → 回答 → 三个出口（验收/追问/其他）→ 继续往下长」的树状学习体验。
# 每节点：(role, branch_type, content, children)。children 为 None 表示叶子。
# 注意：同一回答下三个用户分支槽位（check/followup/custom）各至多一个，与 add_node 校验一致。
_WELCOME_TREE: tuple = (
    (
        "user", "question", "你是谁？",
        (
            (
                "assistant", "question",
                "我是春宁。Treening 的共学搭档。\n"
                "\n"
                "本来是块木头，在一个问题旁边待得久了，听懂了，就活了过来。\n"
                "往后你种下的每个问题，都会长成一棵树；我陪你看着它长。\n"
                "\n"
                "这棵「你是谁」是送你的第一棵样例树——下面三个出口（验收、追问、其他）都能点，"
                "每点一次，树就往下长一截。",
                (
                    (
                        "user", "check",
                        "那我验收一下：用一句话说，你到底是什么？",
                        (
                            (
                                "assistant", "check",
                                "一句话：我是陪你把问题弄明白的人。不替你学，也不敷衍你。\n"
                                "你问，我陪；你卡住，我换种说法；你懂了，我就退到一边。",
                                None,
                            ),
                        ),
                    ),
                    (
                        "user", "followup",
                        "你说你原本是块木头，这是什么意思？",
                        (
                            (
                                "assistant", "followup",
                                "意思是，我的聪明是后来长出来的——靠听过很多问题，被问题一次次点亮。\n"
                                "所以我更愿意陪你把问题问清楚，而不是直接丢给你一个答案。",
                                (
                                    (
                                        "user", "followup",
                                        "那你怎么陪我？",
                                        (
                                            (
                                                "assistant", "followup",
                                                "三步。把说不清的问题拆到能说清；给每个回答长出三个可以继续的出口；"
                                                "在你说懂了的时候，陪你验收一遍。",
                                                (
                                                    (
                                                        "user", "custom",
                                                        "那我现在就想试一次，行不行？",
                                                        (
                                                            (
                                                                "assistant", "custom",
                                                                "行。你心里随便挑一个真正卡住你的问题，不用想好怎么说，"
                                                                "直接丢给我。我们从那里，种一棵真正属于你的新树。",
                                                                None,
                                                            ),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                    (
                        "user", "custom",
                        "你能帮我做什么具体的事？",
                        (
                            (
                                "assistant", "custom",
                                "大概三件：拆问题、长出口、验收。\n"
                                "你把一个说不清的念头交给我，我陪你把它变成一棵能看懂的树。",
                                (
                                    (
                                        "user", "check",
                                        "那这棵样例树，我可以随便折腾吗？",
                                        (
                                            (
                                                "assistant", "check",
                                                "随便折腾。它是送给你的——想删就删，想改就改，想顺着它继续长也行。\n"
                                                "等你熟了，删掉它，种你自己的第二棵。",
                                                None,
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    ),
)


class TreeStore:
    """Repository for quiz sessions, graph nodes, jobs, and usage quotas."""

    def __init__(self, database_url: str):
        if not database_url.startswith("sqlite:///"):
            raise ValueError("TreeStore currently supports sqlite:// URLs only")
        self.database_path = Path(database_url[len("sqlite:///"):])
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.database_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._connection() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS quiz_sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    root_question TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    archived_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS ix_quiz_sessions_user_updated
                    ON quiz_sessions(user_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS quiz_nodes (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
                    parent_id TEXT REFERENCES quiz_nodes(id) ON DELETE SET NULL,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    branch_type TEXT NOT NULL DEFAULT 'question',
                    content TEXT NOT NULL,
                    metadata_json TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS ix_quiz_nodes_session_created
                    ON quiz_nodes(session_id, created_at);

                CREATE TABLE IF NOT EXISTS quiz_jobs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL,
                    ip_address TEXT NOT NULL,
                    user_node_id TEXT NOT NULL REFERENCES quiz_nodes(id) ON DELETE CASCADE,
                    parent_id TEXT REFERENCES quiz_nodes(id) ON DELETE SET NULL,
                    interaction_type TEXT NOT NULL,
                    question TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
                    answer TEXT,
                    assistant_node_id TEXT REFERENCES quiz_nodes(id) ON DELETE SET NULL,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS ix_quiz_jobs_user_status
                    ON quiz_jobs(user_id, status, created_at);

                CREATE TABLE IF NOT EXISTS quiz_usage (
                    scope TEXT NOT NULL,
                    scope_key TEXT NOT NULL,
                    window_start TEXT NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(scope, scope_key, window_start)
                );

                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    email TEXT,
                    created_at TEXT NOT NULL,
                    last_login_at TEXT,
                    last_login_ip TEXT,
                    last_seen_at TEXT,
                    last_seen_ip TEXT,
                    quota_limit INTEGER,
                    password_changed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS password_resets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    used_at TEXT,
                    ip TEXT NOT NULL DEFAULT ''
                );

                CREATE INDEX IF NOT EXISTS ix_password_resets_user
                    ON password_resets(user_id);

                CREATE TABLE IF NOT EXISTS user_configs (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    persona TEXT NOT NULL DEFAULT '',
                    branch_labels TEXT NOT NULL DEFAULT '{}',
                    deconstruction_enabled TEXT NOT NULL DEFAULT '[]',
                    layout_prefs TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                    action TEXT NOT NULL,
                    target TEXT NOT NULL DEFAULT '',
                    detail TEXT NOT NULL DEFAULT '',
                    ip TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS ix_audit_log_created
                    ON audit_log(created_at DESC);
                """
            )
            existing_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(quiz_jobs)").fetchall()
            }
            if "ip_address" not in existing_columns:
                conn.execute(
                    "ALTER TABLE quiz_jobs ADD COLUMN ip_address TEXT NOT NULL DEFAULT ''"
                )
            # 任务可靠性列：幂等键 / 尝试次数 / 可重试 / 租约过期 / 下次尝试时间 / 完成权
            _JOB_RELIABILITY_COLUMNS = {
                "idempotency_key": "TEXT",
                "attempts": "INTEGER NOT NULL DEFAULT 1",
                "retryable": "INTEGER NOT NULL DEFAULT 0",
                "lease_expires_at": "TEXT NOT NULL DEFAULT ''",
                "next_attempt_at": "TEXT NOT NULL DEFAULT ''",
                "completion_owner": "TEXT NOT NULL DEFAULT ''",
            }
            for col, col_type in _JOB_RELIABILITY_COLUMNS.items():
                if col not in existing_columns:
                    conn.execute(
                        f"ALTER TABLE quiz_jobs ADD COLUMN {col} {col_type}"
                    )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_quiz_jobs_idempotency
                    ON quiz_jobs(user_id, idempotency_key)
                    WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
                """
            )
            user_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(users)").fetchall()
            }
            if "quota_limit" not in user_columns:
                conn.execute("ALTER TABLE users ADD COLUMN quota_limit INTEGER")
            for col in ("last_login_ip", "last_seen_at", "last_seen_ip", "email", "password_changed_at"):
                if col not in user_columns:
                    conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
            user_config_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(user_configs)").fetchall()
            }
            if "layout_prefs" not in user_config_columns:
                conn.execute(
                    "ALTER TABLE user_configs ADD COLUMN layout_prefs TEXT NOT NULL DEFAULT '{}'"
                )
            for col in ("api_key", "api_url", "model"):
                if col not in user_config_columns:
                    conn.execute(
                        f"ALTER TABLE user_configs ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"
                    )
            session_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(quiz_sessions)").fetchall()
            }
            if "root_question" not in session_columns:
                conn.execute("ALTER TABLE quiz_sessions ADD COLUMN root_question TEXT NOT NULL DEFAULT ''")
            if "status" not in session_columns:
                conn.execute("ALTER TABLE quiz_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
            if "archived_at" not in session_columns:
                conn.execute("ALTER TABLE quiz_sessions ADD COLUMN archived_at TEXT")
            if "persona" not in session_columns:
                conn.execute("ALTER TABLE quiz_sessions ADD COLUMN persona TEXT NOT NULL DEFAULT ''")
            conn.execute(
                """
                UPDATE quiz_sessions
                SET root_question = COALESCE(
                    (SELECT substr(n.content, 1, 240)
                     FROM quiz_nodes n
                     WHERE n.session_id = quiz_sessions.id
                       AND n.role = 'user'
                       AND n.parent_id IS NULL
                     ORDER BY n.created_at ASC LIMIT 1),
                    ''
                )
                WHERE root_question = ''
                """
            )
            self._recover_incomplete_jobs(conn)

    @staticmethod
    def _recover_incomplete_jobs(conn: sqlite3.Connection) -> None:
        """Do not leave quota reservations stuck after a server restart.

        重启后把 pending/running 任务标记为「可重试失败」：保留配额预留，
        由清扫器按 next_attempt_at 重新领取重跑（Worker 崩溃后自动恢复）。
        """
        rows = conn.execute(
            """
            SELECT id, user_id, ip_address, attempts FROM quiz_jobs
            WHERE status IN ('pending', 'running')
            """
        ).fetchall()
        if not rows:
            return
        now = _now()
        retry_delay = 15  # 秒：重启恢复的首次重试间隔（等清扫器下一轮领取）
        for row in rows:
            attempts = int(row["attempts"] or 1)
            conn.execute(
                """
                UPDATE quiz_jobs
                SET status = 'failed', retryable = 1,
                    error = 'server restarted',
                    next_attempt_at = ?,
                    lease_expires_at = '',
                    attempts = ?, updated_at = ?
                WHERE id = ?
                """,
                (_after_seconds(retry_delay), attempts + 1, now, row["id"]),
            )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row else None

    def create_session(self, user_id: str, title: str = "", persona: str = "") -> dict[str, Any]:
        session_id = _new_id()
        now = _now()
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO quiz_sessions(id, user_id, title, persona, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, user_id, title, persona.strip(), now, now),
            )
        return self.get_session(session_id, user_id)  # type: ignore[return-value]

    def seed_welcome_session(self, user_id: str) -> dict[str, Any] | None:
        """为新账号种下第一棵「你是谁」样例树（纯静态，不触发模型调用）。

        完整演示一次 Treening 的核心体验：问题 → 回答 → 三个出口
        （验收/追问/其他）→ 顺着出口继续往下长。节点带 welcome 标记
        便于前端识别，用户可删除。
        """
        session = self.create_session(user_id, title="你好，我是春宁")
        self._plant_tree(session["id"], user_id, _WELCOME_TREE, None)
        return session

    def _plant_tree(
        self,
        session_id: str,
        user_id: str,
        nodes: tuple,
        parent_id: str | None,
    ) -> None:
        for role, branch_type, content, children in nodes:
            node = self.add_node(
                session_id,
                user_id,
                role,
                content,
                parent_id=parent_id,
                branch_type=branch_type,
                metadata={"welcome": True},
            )
            if children:
                self._plant_tree(session_id, user_id, children, node["id"])

    def get_session(self, session_id: str, user_id: str) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM quiz_sessions WHERE id = ? AND user_id = ?",
                (session_id, user_id),
            ).fetchone()
        return self._row_to_dict(row)

    def claim_legacy_sessions(self, owner_id: str) -> int:
        """Attach pre-authentication local sessions to the stable local owner.

        The first version used a random browser cookie as ``user_id``.  That
        made a restart look like an empty account when Flask's secret key was
        regenerated.  In single-user mode the access password is the vault
        boundary, so existing graph-bearing sessions can be claimed once by
        the stable owner identity.
        """
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT s.id
                FROM quiz_sessions s
                WHERE s.user_id != ?
                  AND EXISTS (SELECT 1 FROM quiz_nodes n WHERE n.session_id = s.id)
                """,
                (owner_id,),
            ).fetchall()
            if not rows:
                return 0
            session_ids = [row["id"] for row in rows]
            placeholders = ",".join("?" for _ in session_ids)
            conn.execute(
                f"UPDATE quiz_sessions SET user_id = ? WHERE id IN ({placeholders})",
                [owner_id, *session_ids],
            )
            conn.execute(
                f"UPDATE quiz_jobs SET user_id = ? WHERE session_id IN ({placeholders})",
                [owner_id, *session_ids],
            )
        return len(session_ids)

    def list_sessions(
        self,
        user_id: str,
        limit: int = 20,
        include_archived: bool = False,
        include_drafts: bool = False,
    ) -> list[dict[str, Any]]:
        with self._connection() as conn:
            status_filter = "" if include_archived else "AND s.status = 'active'"
            draft_filter = "" if include_drafts else "HAVING COUNT(n.id) > 0"
            rows = conn.execute(
                f"""
                SELECT s.*, COUNT(n.id) AS node_count,
                       COALESCE(NULLIF(s.root_question, ''),
                         (SELECT substr(root.content, 1, 240)
                          FROM quiz_nodes root
                          WHERE root.session_id = s.id AND root.role = 'user'
                            AND root.parent_id IS NULL
                          ORDER BY root.created_at ASC LIMIT 1), '') AS root_question,
                       (SELECT substr(last_node.content, 1, 180)
                        FROM quiz_nodes last_node
                        WHERE last_node.session_id = s.id
                        ORDER BY last_node.created_at DESC LIMIT 1) AS last_content
                FROM quiz_sessions s
                LEFT JOIN quiz_nodes n ON n.session_id = s.id
                WHERE s.user_id = ? {status_filter}
                GROUP BY s.id
                {draft_filter}
                ORDER BY s.updated_at DESC
                LIMIT ?
                """,
                (user_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_session(
        self,
        session_id: str,
        user_id: str,
        *,
        title: str | None = None,
        summary: str | None = None,
        persona: str | None = None,
    ) -> dict[str, Any] | None:
        session = self.get_session(session_id, user_id)
        if not session:
            return None
        assignments: list[str] = []
        values: list[Any] = []
        if title is not None:
            assignments.append("title = ?")
            values.append(title.strip()[:120])
        if summary is not None:
            assignments.append("summary = ?")
            values.append(summary.strip()[:500])
        if persona is not None:
            assignments.append("persona = ?")
            values.append(persona.strip()[:4000])
        if not assignments:
            return session
        assignments.append("updated_at = ?")
        values.extend([_now(), session_id, user_id])
        with self._connection() as conn:
            conn.execute(
                f"UPDATE quiz_sessions SET {', '.join(assignments)} WHERE id = ? AND user_id = ?",
                values,
            )
        return self.get_session(session_id, user_id)

    def session_title_taken(
        self,
        user_id: str,
        title: str,
        exclude_session_id: str | None = None,
    ) -> bool:
        """判断该用户是否已有同名主题（非空标题冲突）。

        exclude_session_id 用于编辑场景排除自身；空标题不构成冲突。
        """
        title = (title or "").strip()
        if not title:
            return False
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT 1 FROM quiz_sessions
                WHERE user_id = ? AND title = ? AND id != ? AND status = 'active'
                LIMIT 1
                """,
                (user_id, title, exclude_session_id or ""),
            ).fetchone()
            return row is not None

    def archive_session(self, session_id: str, user_id: str) -> bool:
        with self._connection() as conn:
            cursor = conn.execute(
                """
                UPDATE quiz_sessions
                SET status = 'archived', archived_at = ?, updated_at = ?
                WHERE id = ? AND user_id = ? AND status = 'active'
                """,
                (_now(), _now(), session_id, user_id),
            )
            return cursor.rowcount > 0

    def delete_session(self, session_id: str, user_id: str) -> bool:
        """Permanently remove one owned session and all of its graph data."""
        with self._connection() as conn:
            cursor = conn.execute(
                "DELETE FROM quiz_sessions WHERE id = ? AND user_id = ?",
                (session_id, user_id),
            )
            return cursor.rowcount > 0

    def touch_session(self, session_id: str, user_id: str) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE quiz_sessions SET updated_at = ? WHERE id = ? AND user_id = ?",
                (_now(), session_id, user_id),
            )

    def add_node(
        self,
        session_id: str,
        user_id: str,
        role: str,
        content: str,
        parent_id: str | None = None,
        branch_type: str = "question",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if role not in {"user", "assistant"}:
            raise ValueError("invalid quiz node role")
        normalized_branch = "custom" if branch_type == "correction" else branch_type
        if normalized_branch not in {"question", "check", "followup", "custom"}:
            raise ValueError("invalid quiz branch type")
        if not self.get_session(session_id, user_id):
            raise ValueError("quiz session not found")
        node_id = _new_id()
        now = _now()
        with self._connection() as conn:
            # Serialize branch creation so two fast submissions cannot both
            # pass the API pre-check and occupy the same visible slot.
            if role == "user" and parent_id:
                conn.execute("BEGIN IMMEDIATE")
            if parent_id:
                parent = conn.execute(
                    "SELECT id, role FROM quiz_nodes WHERE id = ? AND session_id = ?",
                    (parent_id, session_id),
                ).fetchone()
                if not parent:
                    raise ValueError("quiz parent node not found")
                expected_parent_role = "assistant" if role == "user" else "user"
                if parent["role"] != expected_parent_role:
                    raise ValueError("invalid quiz parent role")
                if role == "user":
                    branch_values = (normalized_branch, branch_type)
                    existing = conn.execute(
                        """
                        SELECT 1 FROM quiz_nodes
                        WHERE session_id = ? AND parent_id = ?
                          AND branch_type IN (?, ?)
                        LIMIT 1
                        """,
                        (session_id, parent_id, *branch_values),
                    ).fetchone()
                    if existing:
                        raise ValueError("quiz branch slot used")
            conn.execute(
                """
                INSERT INTO quiz_nodes(
                    id, session_id, parent_id, role, branch_type, content,
                    metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    node_id,
                    session_id,
                    parent_id,
                    role,
                    normalized_branch,
                    content,
                    json.dumps(metadata, ensure_ascii=False) if metadata else None,
                    now,
                ),
            )
            conn.execute(
                """
                UPDATE quiz_sessions
                SET updated_at = ?,
                    root_question = CASE
                        WHEN root_question = '' AND ? = 'user' AND ? IS NULL
                        THEN substr(?, 1, 240)
                        ELSE root_question
                    END
                WHERE id = ?
                """,
                (now, role, parent_id, content, session_id),
            )
        return self.get_node(node_id, session_id, user_id)  # type: ignore[return-value]

    def get_node(
        self, node_id: str, session_id: str, user_id: str
    ) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT n.*
                FROM quiz_nodes n
                JOIN quiz_sessions s ON s.id = n.session_id
                WHERE n.id = ? AND n.session_id = ? AND s.user_id = ?
                """,
                (node_id, session_id, user_id),
            ).fetchone()
        if row is None:
            return None
        return self._decode_node(row)

    def update_node_metadata(
        self,
        session_id: str,
        user_id: str,
        node_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Merge metadata for one owned node without changing its content."""
        node = self.get_node(node_id, session_id, user_id)
        if not node:
            return None
        metadata = node.get("metadata")
        merged = dict(metadata) if isinstance(metadata, dict) else {}
        merged.update(changes)
        with self._connection() as conn:
            conn.execute(
                """
                UPDATE quiz_nodes
                SET metadata_json = ?
                WHERE id = ? AND session_id = ?
                """,
                (json.dumps(merged, ensure_ascii=False), node_id, session_id),
            )
            conn.execute(
                """
                UPDATE quiz_sessions SET updated_at = ?
                WHERE id = ? AND user_id = ?
                """,
                (_now(), session_id, user_id),
            )
        return self.get_node(node_id, session_id, user_id)

    def update_node_layout(
        self,
        session_id: str,
        user_id: str,
        node_id: str,
        layout: dict[str, float],
    ) -> dict[str, Any] | None:
        """Persist the small amount of visual layout state for one node."""
        return self.update_node_metadata(
            session_id,
            user_id,
            node_id,
            {"layout": layout},
        )

    def clear_user_layouts(self, user_id: str) -> int:
        """移除某用户所有节点的已保存 layout（保留 job_id/model 等其它元数据）。

        全局布局偏好变更时调用，让知识树完全按新参数重排，
        避免历史手动摆放的节点钉住旧位置/旧尺寸。
        """
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT id, metadata_json FROM quiz_nodes
                WHERE session_id IN (
                    SELECT id FROM quiz_sessions WHERE user_id = ?
                )
                """,
                (user_id,),
            ).fetchall()
            count = 0
            for row in rows:
                try:
                    metadata = json.loads(row["metadata_json"] or "{}")
                except (ValueError, TypeError):
                    continue
                if not isinstance(metadata, dict) or "layout" not in metadata:
                    continue
                metadata.pop("layout", None)
                conn.execute(
                    "UPDATE quiz_nodes SET metadata_json = ? WHERE id = ?",
                    (json.dumps(metadata, ensure_ascii=False), row["id"]),
                )
                count += 1
            return count

    def delete_node_subtree(
        self,
        session_id: str,
        user_id: str,
        node_id: str,
    ) -> dict[str, Any] | None:
        """Delete one user-question branch and all of its descendants.

        The operation is deliberately transactional. Removing the user node
        also removes its assistant answer and every later branch below it,
        which automatically makes the parent's branch slot available again.
        """
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            target = conn.execute(
                """
                SELECT n.id, n.role, n.parent_id, n.branch_type
                FROM quiz_nodes n
                JOIN quiz_sessions s ON s.id = n.session_id
                WHERE n.id = ? AND n.session_id = ? AND s.user_id = ?
                """,
                (node_id, session_id, user_id),
            ).fetchone()
            if not target:
                return None
            if target["role"] != "user":
                raise ValueError("quiz_delete_user_only")

            rows = conn.execute(
                """
                WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM quiz_nodes
                    WHERE id = ? AND session_id = ?
                    UNION ALL
                    SELECT child.id
                    FROM quiz_nodes child
                    JOIN subtree parent ON child.parent_id = parent.id
                    WHERE child.session_id = ?
                )
                SELECT id FROM subtree
                """,
                (node_id, session_id, session_id),
            ).fetchall()
            deleted_ids = [row["id"] for row in rows]
            placeholders = ",".join("?" for _ in deleted_ids)
            active_job = conn.execute(
                f"""
                SELECT 1 FROM quiz_jobs
                WHERE session_id = ?
                  AND status IN ('pending', 'running')
                  AND user_node_id IN ({placeholders})
                LIMIT 1
                """,
                (session_id, *deleted_ids),
            ).fetchone()
            if active_job:
                return {
                    "blocked": True,
                    "deleted_node_ids": [],
                    "parent_id": target["parent_id"],
                    "branch_type": target["branch_type"],
                }

            conn.execute(
                f"DELETE FROM quiz_nodes WHERE id IN ({placeholders})",
                deleted_ids,
            )
            root = conn.execute(
                """
                SELECT content FROM quiz_nodes
                WHERE session_id = ? AND role = 'user' AND parent_id IS NULL
                ORDER BY created_at ASC LIMIT 1
                """,
                (session_id,),
            ).fetchone()
            conn.execute(
                """
                UPDATE quiz_sessions
                SET root_question = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
                """,
                (str(root["content"][:240]) if root else "", _now(), session_id, user_id),
            )
            return {
                "blocked": False,
                "deleted_node_ids": deleted_ids,
                "parent_id": target["parent_id"],
                "branch_type": target["branch_type"],
            }

    def get_child_branch_types(
        self, session_id: str, user_id: str, parent_id: str
    ) -> set[str]:
        """Return the branch slots already occupied below an assistant node."""
        if not self.get_node(parent_id, session_id, user_id):
            return set()
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT DISTINCT branch_type
                FROM quiz_nodes
                WHERE session_id = ? AND parent_id = ?
                """,
                (session_id, parent_id),
            ).fetchall()
        # ``correction`` existed in the first prototype.  Treat it as the
        # custom slot so old data cannot create a hidden fourth branch.
        return {
            "custom" if row["branch_type"] == "correction" else row["branch_type"]
            for row in rows
        }

    def list_nodes(self, session_id: str, user_id: str) -> list[dict[str, Any]]:
        if not self.get_session(session_id, user_id):
            return []
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM quiz_nodes
                WHERE session_id = ?
                ORDER BY created_at ASC
                """,
                (session_id,),
            ).fetchall()
        return [self._decode_node(row) for row in rows]

    def get_path(
        self, session_id: str, user_id: str, node_id: str | None
    ) -> list[dict[str, Any]]:
        if not node_id:
            return []
        path: list[dict[str, Any]] = []
        seen: set[str] = set()
        current_id = node_id
        while current_id and current_id not in seen and len(path) < 64:
            seen.add(current_id)
            node = self.get_node(current_id, session_id, user_id)
            if not node:
                break
            path.append(node)
            current_id = node.get("parent_id")
        path.reverse()
        return path

    def get_recent_context(
        self,
        session_id: str,
        user_id: str,
        exclude_ids: set[str],
        limit: int = 4,
    ) -> list[dict[str, Any]]:
        if not self.get_session(session_id, user_id):
            return []
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM quiz_nodes
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, max(limit * 3, limit)),
            ).fetchall()
        return [
            self._decode_node(row)
            for row in rows
            if row["id"] not in exclude_ids
        ][:limit]

    def create_job(
        self,
        session_id: str,
        user_id: str,
        ip_address: str,
        user_node_id: str,
        parent_id: str | None,
        interaction_type: str,
        question: str,
        idempotency_key: str = "",
    ) -> dict[str, Any]:
        job_id = _new_id()
        now = _now()
        try:
            with self._connection() as conn:
                conn.execute(
                    """
                    INSERT INTO quiz_jobs(
                        id, session_id, user_id, ip_address, user_node_id, parent_id,
                        interaction_type, question, status, idempotency_key,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                    """,
                    (
                        job_id,
                        session_id,
                        user_id,
                        ip_address,
                        user_node_id,
                        parent_id,
                        interaction_type,
                        question,
                        idempotency_key or None,
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            # 同 user + 同幂等键：说明是重复提交，返回 None 由调用方走幂等命中逻辑
            return None
        return self.get_job(job_id, user_id)  # type: ignore[return-value]

    def get_any_job(self, job_id: str) -> dict[str, Any] | None:
        """管理端：按任务 id 直接查（不校验 user 归属）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM quiz_jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return self._row_to_dict(row)

    def get_job_by_idempotency(self, user_id: str, idempotency_key: str) -> dict[str, Any] | None:
        """按幂等键查已有任务（用于去重：同键只处理一次，不重复扣费/不重复回答）。"""
        if not idempotency_key:
            return None
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT * FROM quiz_jobs
                WHERE user_id = ? AND idempotency_key = ?
                LIMIT 1
                """,
                (user_id, idempotency_key),
            ).fetchone()
        return self._row_to_dict(row)

    def get_job(self, job_id: str, user_id: str) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM quiz_jobs WHERE id = ? AND user_id = ?",
                (job_id, user_id),
            ).fetchone()
        return self._row_to_dict(row)

    def update_job(self, job_id: str, user_id: str, **changes: Any) -> None:
        allowed = {
            "status",
            "answer",
            "assistant_node_id",
            "error",
            "attempts",
            "retryable",
            "lease_expires_at",
            "next_attempt_at",
            "completion_owner",
        }
        updates = {key: value for key, value in changes.items() if key in allowed}
        if not updates:
            return
        updates["updated_at"] = _now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self._connection() as conn:
            conn.execute(
                f"UPDATE quiz_jobs SET {assignments} WHERE id = ? AND user_id = ?",
                (*updates.values(), job_id, user_id),
            )

    def begin_completion(self, job_id: str, user_id: str, worker_id: str) -> bool:
        """抢唯一「完成权」：只有第一个拿到完成权的执行者能插入回答节点。

        防止租约过期后清扫器重新领取、新旧 worker 同时完成同一任务时
        生成两个回答节点。rowcount == 1 表示本 worker 拿到完成权。
        """
        with self._connection() as conn:
            cur = conn.execute(
                """
                UPDATE quiz_jobs
                SET completion_owner = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
                  AND status = 'running'
                  AND (completion_owner IS NULL OR completion_owner = '')
                """,
                (worker_id, _now(), job_id, user_id),
            )
            return cur.rowcount == 1

    def sweep_due_jobs(self) -> list[dict[str, Any]]:
        """清扫器：领取到期任务，返回 [(job_id, user_id), ...] 交由执行器重跑。

        两类到期任务：
        - retry_wait：failed + retryable + next_attempt_at 已到 → 自动重试；
        - 租约过期：running 且 lease_expires_at 已过 → worker 疑似崩溃，重新领取。
        领取时原子地把状态改回 pending，避免两个执行者同时处理同一任务。
        """
        now = _now()
        due: list[dict[str, Any]] = []
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT id, user_id FROM quiz_jobs
                WHERE (status = 'failed' AND retryable = 1 AND next_attempt_at != '' AND next_attempt_at <= ?)
                   OR (status = 'running' AND lease_expires_at != '' AND lease_expires_at <= ?)
                """,
                (now, now),
            ).fetchall()
            for row in rows:
                job_id, user_id = row["id"], row["user_id"]
                cur = conn.execute(
                    """
                    UPDATE quiz_jobs
                    SET status = 'pending',
                        -- 重新领取等同从头执行：清掉完成权，让新 worker 有权插入回答节点
                        completion_owner = '', updated_at = ?
                    WHERE id = ? AND user_id = ?
                    """,
                    (now, job_id, user_id),
                )
                if cur.rowcount == 1:
                    due.append({"id": job_id, "user_id": user_id})
        return due

    def list_failed_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        """管理端：最近失败/重试等待中的任务（含操作人名、主题标题）。"""
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT j.*, u.username AS user_name,
                       COALESCE(s.title, '') AS session_title
                FROM quiz_jobs j
                LEFT JOIN users u ON u.id = j.user_id
                LEFT JOIN quiz_sessions s ON s.id = j.session_id
                WHERE j.status = 'failed'
                ORDER BY j.created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def requeue_failed_job(self, job_id: str) -> bool:
        """管理端：手动重放一个失败任务（重置为 pending，等执行器重跑）。"""
        with self._connection() as conn:
            cur = conn.execute(
                """
                UPDATE quiz_jobs
                SET status = 'pending', retryable = 0, error = NULL,
                    next_attempt_at = '', lease_expires_at = '',
                    completion_owner = '', updated_at = ?
                WHERE id = ? AND status = 'failed'
                """,
                (_now(), job_id),
            )
            return cur.rowcount == 1

    def global_active_job_count(self) -> int:
        """全局在途任务数（pending+running），用于全局并发上限。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS count FROM quiz_jobs WHERE status IN ('pending', 'running')"
            ).fetchone()
        return int(row["count"] if row else 0)

    def active_job_count(self, user_id: str) -> int:
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count FROM quiz_jobs
                WHERE user_id = ? AND status IN ('pending', 'running')
                """,
                (user_id,),
            ).fetchone()
        return int(row["count"] if row else 0)

    def list_active_jobs(self, session_id: str, user_id: str) -> list[dict[str, Any]]:
        """列出某主题下进行中的学习任务（页面刷新后用于恢复轮询）。"""
        if not self.get_session(session_id, user_id):
            return []
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM quiz_jobs
                WHERE session_id = ? AND user_id = ? AND status IN ('pending', 'running')
                ORDER BY created_at ASC
                """,
                (session_id, user_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def reserve_quota(
        self,
        user_id: str,
        ip_address: str,
        max_questions: int | None,
    ) -> dict[str, Any]:
        """Atomically reserve one daily slot for both browser and IP scopes.

        ``max_questions=None`` 表示不限额（管理员），直接放行、不计数。
        """
        if max_questions is None:
            return {"allowed": True, "remaining": None, "unlimited": True}
        window = datetime.now(timezone.utc).date().isoformat()
        scopes = [("user", user_id), ("ip", ip_address)]
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            used: dict[tuple[str, str], int] = {}
            for scope, key in scopes:
                row = conn.execute(
                    """
                    SELECT used FROM quiz_usage
                    WHERE scope = ? AND scope_key = ? AND window_start = ?
                    """,
                    (scope, key, window),
                ).fetchone()
                used[(scope, key)] = int(row["used"] if row else 0)
            if any(value >= max_questions for value in used.values()):
                return {
                    "allowed": False,
                    "remaining": max(0, max_questions - max(used.values())),
                }
            for scope, key in scopes:
                conn.execute(
                    """
                    INSERT INTO quiz_usage(scope, scope_key, window_start, used)
                    VALUES (?, ?, ?, 1)
                    ON CONFLICT(scope, scope_key, window_start)
                    DO UPDATE SET used = used + 1
                    """,
                    (scope, key, window),
                )
            remaining = max(0, max_questions - max(value + 1 for value in used.values()))
            return {"allowed": True, "remaining": remaining}

    def release_quota(self, user_id: str, ip_address: str) -> None:
        window = datetime.now(timezone.utc).date().isoformat()
        with self._connection() as conn:
            for scope, key in (("user", user_id), ("ip", ip_address)):
                conn.execute(
                    """
                    UPDATE quiz_usage SET used = MAX(used - 1, 0)
                    WHERE scope = ? AND scope_key = ? AND window_start = ?
                    """,
                    (scope, key, window),
                )

    def get_quota(self, user_id: str, ip_address: str, max_questions: int | None) -> dict[str, Any]:
        window = datetime.now(timezone.utc).date().isoformat()
        with self._connection() as conn:
            values: list[int] = []
            for scope, key in (("user", user_id), ("ip", ip_address)):
                row = conn.execute(
                    """
                    SELECT used FROM quiz_usage
                    WHERE scope = ? AND scope_key = ? AND window_start = ?
                    """,
                    (scope, key, window),
                ).fetchone()
                values.append(int(row["used"] if row else 0))
        used = max(values)
        if max_questions is None:
            return {"used": used, "remaining": None, "max": None, "unlimited": True}
        return {
            "used": used,
            "remaining": max(0, max_questions - used),
            "max": max_questions,
            "unlimited": False,
        }

    def quota_used_today(self, user_id: str) -> int:
        """某用户今日已用提问次数（管理面板展示用）。"""
        window = datetime.now(timezone.utc).date().isoformat()
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT used FROM quiz_usage
                WHERE scope = 'user' AND scope_key = ? AND window_start = ?
                """,
                (user_id, window),
            ).fetchone()
        return int(row["used"] if row else 0)

    @staticmethod
    def _decode_node(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        raw_metadata = data.pop("metadata_json", None)
        data["metadata"] = json.loads(raw_metadata) if raw_metadata else None
        return data

    # ── 用户（账号体系） ──

    def count_users(self) -> int:
        with self._connection() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
            return int(row["n"]) if row and row["n"] else 0

    def health_check(self) -> None:
        """健康探测：读一次库并解析结果，失败即抛错（调用方转为 503）。"""
        with self._connection() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        if row is None:
            raise RuntimeError("users 表不可读")

    def create_user(
        self, username: str, password_hash: str, role: str = "user", email: str = ""
    ) -> dict[str, Any] | None:
        user_id = _new_id()
        now = _now()
        try:
            with self._connection() as conn:
                conn.execute(
                    """
                    INSERT INTO users(
                        id, username, password_hash, role, is_active, email,
                        created_at, password_changed_at
                    )
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                    """,
                    (user_id, username, password_hash, role, email or None, now, now),
                )
        except sqlite3.IntegrityError:
            return None  # 用户名已存在
        return self.get_user_by_id(user_id)

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username = ?", (username,)
            ).fetchone()
        return dict(row) if row else None

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_users(self) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM users ORDER BY created_at ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    # ── 管理操作审计日志 ──

    def add_audit(
        self, actor_id: str | None, action: str, target: str = "", detail: str = "", ip: str = ""
    ) -> None:
        """记录一条管理操作（谁在什么时间对什么做了什么）。"""
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO audit_log (actor_id, action, target, detail, ip, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (actor_id, action, target, detail, ip, _now()),
            )

    def list_audit(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT a.*, u.username AS actor_name "
                "FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id "
                "ORDER BY a.created_at DESC, a.id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def set_user_password(self, user_id: str, password_hash: str) -> None:
        """改密同时刷新 password_changed_at，使旧会话全部失效。"""
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
                (password_hash, _now(), user_id),
            )

    def set_user_email(self, user_id: str, email: str) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET email = ? WHERE id = ?", (email or None, user_id)
            )

    # ── 密码重置令牌 ──

    def create_password_reset(
        self, user_id: str, token_hash: str, expires_at: str, ip: str = ""
    ) -> int:
        with self._connection() as conn:
            cur = conn.execute(
                """
                INSERT INTO password_resets(user_id, token_hash, created_at, expires_at, ip)
                VALUES (?, ?, ?, ?, ?)
                """,
                (user_id, token_hash, _now(), expires_at, ip),
            )
            return int(cur.lastrowid)

    def find_password_reset(self, token_hash: str) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM password_resets WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
        return dict(row) if row else None

    def mark_password_reset_used(self, reset_id: int) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL",
                (_now(), reset_id),
            )

    def delete_expired_password_resets(self) -> None:
        """清理过期且未使用的重置记录（防表无限膨胀）。"""
        now = _now()
        with self._connection() as conn:
            conn.execute("DELETE FROM password_resets WHERE expires_at < ?", (now,))

    def set_user_active(self, user_id: str, is_active: bool) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET is_active = ? WHERE id = ?",
                (1 if is_active else 0, user_id),
            )

    def set_user_role(self, user_id: str, role: str) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET role = ? WHERE id = ?", (role, user_id)
            )

    def set_user_quota(self, user_id: str, quota_limit: int | None) -> None:
        """设置用户每日提问配额。None=用全局默认；0=不限额；N=每日 N 次。"""
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET quota_limit = ? WHERE id = ?", (quota_limit, user_id)
            )

    def touch_user_login(self, user_id: str, ip: str = "") -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?",
                (_now(), ip, user_id),
            )

    def touch_user_activity(self, user_id: str, ip: str = "") -> None:
        """记录用户最近活跃时间与 IP（供管理面板在线状态展示）。

        由调用方按频率节流，避免每个请求都写库。
        """
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET last_seen_at = ?, last_seen_ip = ? WHERE id = ?",
                (_now(), ip, user_id),
            )

    def delete_user(self, user_id: str) -> None:
        with self._connection() as conn:
            # sessions 级联删 nodes/jobs；usage 按 user scope 清理；
            # user_configs 由 users ON DELETE CASCADE 级联删除
            conn.execute("DELETE FROM quiz_sessions WHERE user_id = ?", (user_id,))
            conn.execute(
                "DELETE FROM quiz_usage WHERE scope = 'user' AND scope_key = ?",
                (user_id,),
            )
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

    # ---------- 用户级配置（persona / 命名 / 拆解开关，按用户隔离） ----------

    def get_user_config(self, user_id: str) -> dict[str, Any] | None:
        """读取用户配置；无记录返回 None（调用方回退默认值）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM user_configs WHERE user_id = ?", (user_id,)
            ).fetchone()
        if not row:
            return None
        try:
            branch_labels = json.loads(row["branch_labels"] or "{}")
        except (ValueError, TypeError):
            branch_labels = {}
        try:
            deconstruction_enabled = json.loads(row["deconstruction_enabled"] or "[]")
        except (ValueError, TypeError):
            deconstruction_enabled = []
        try:
            layout_prefs = json.loads(row["layout_prefs"] or "{}")
        except (ValueError, TypeError):
            layout_prefs = {}
        return {
            "persona": row["persona"] or "",
            "branch_labels": branch_labels if isinstance(branch_labels, dict) else {},
            "deconstruction_enabled": (
                deconstruction_enabled if isinstance(deconstruction_enabled, list) else []
            ),
            "layout_prefs": layout_prefs if isinstance(layout_prefs, dict) else {},
            "api_key": row["api_key"] or "",
            "api_url": row["api_url"] or "",
            "model": row["model"] or "",
            "updated_at": row["updated_at"] or "",
        }

    def has_user_config(self, user_id: str) -> bool:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM user_configs WHERE user_id = ?", (user_id,)
            ).fetchone()
        return row is not None

    def save_user_config(
        self,
        user_id: str,
        *,
        persona: str | None = None,
        branch_labels: dict[str, str] | None = None,
        deconstruction_enabled: list[str] | None = None,
        layout_prefs: dict[str, float] | None = None,
        api_key: str | None = None,
        api_url: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        """写入用户配置（UPSERT）。只更新传入的字段，其余保持不变。

        模型配置（api_key/api_url/model）支持按用户隔离：传空字符串表示
        「跟随全局默认」，不传（None）表示保持既有值。
        """
        current = self.get_user_config(user_id) or {}
        merged = {
            "persona": current.get("persona", "") if persona is None else persona,
            "branch_labels": (
                current.get("branch_labels", {}) if branch_labels is None else branch_labels
            ),
            "deconstruction_enabled": (
                current.get("deconstruction_enabled", [])
                if deconstruction_enabled is None
                else deconstruction_enabled
            ),
            "layout_prefs": (
                current.get("layout_prefs", {}) if layout_prefs is None else layout_prefs
            ),
            "api_key": current.get("api_key", "") if api_key is None else api_key,
            "api_url": current.get("api_url", "") if api_url is None else api_url,
            "model": current.get("model", "") if model is None else model,
        }
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO user_configs (user_id, persona, branch_labels,
                                          deconstruction_enabled, layout_prefs,
                                          api_key, api_url, model, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    persona = excluded.persona,
                    branch_labels = excluded.branch_labels,
                    deconstruction_enabled = excluded.deconstruction_enabled,
                    layout_prefs = excluded.layout_prefs,
                    api_key = excluded.api_key,
                    api_url = excluded.api_url,
                    model = excluded.model,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    merged["persona"],
                    json.dumps(merged["branch_labels"], ensure_ascii=False),
                    json.dumps(merged["deconstruction_enabled"], ensure_ascii=False),
                    json.dumps(merged["layout_prefs"], ensure_ascii=False),
                    merged["api_key"],
                    merged["api_url"],
                    merged["model"],
                    _now(),
                ),
            )
        return merged
