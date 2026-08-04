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


def _new_id() -> str:
    return uuid.uuid4().hex


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

    def ping(self) -> None:
        """轻量探活：确认 SQLite 可读（healthcheck 用）。"""
        with self._connection() as conn:
            conn.execute("SELECT 1").fetchone()

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
        """Do not leave quota reservations stuck after a server restart."""
        rows = conn.execute(
            """
            SELECT user_id, ip_address FROM quiz_jobs
            WHERE status IN ('pending', 'running')
            """
        ).fetchall()
        if not rows:
            return
        now = _now()
        conn.execute(
            """
            UPDATE quiz_jobs
            SET status = 'failed', error = 'server restarted', updated_at = ?
            WHERE status IN ('pending', 'running')
            """,
            (now,),
        )
        window = datetime.now(timezone.utc).date().isoformat()
        for row in rows:
            for scope, key in (("user", row["user_id"]), ("ip", row["ip_address"])):
                conn.execute(
                    """
                    UPDATE quiz_usage SET used = MAX(used - 1, 0)
                    WHERE scope = ? AND scope_key = ? AND window_start = ?
                    """,
                    (scope, key, window),
                )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row else None

    def create_session(self, user_id: str, title: str = "") -> dict[str, Any]:
        session_id = _new_id()
        now = _now()
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO quiz_sessions(id, user_id, title, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, user_id, title, now, now),
            )
        return self.get_session(session_id, user_id)  # type: ignore[return-value]

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
    ) -> list[dict[str, Any]]:
        with self._connection() as conn:
            status_filter = "" if include_archived else "AND s.status = 'active'"
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
    ) -> dict[str, Any]:
        job_id = _new_id()
        now = _now()
        with self._connection() as conn:
            conn.execute(
                """
                INSERT INTO quiz_jobs(
                    id, session_id, user_id, ip_address, user_node_id, parent_id,
                    interaction_type, question, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
                    now,
                    now,
                ),
            )
        return self.get_job(job_id, user_id)  # type: ignore[return-value]

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
        max_questions: int,
    ) -> dict[str, Any]:
        """Atomically reserve one daily slot for both browser and IP scopes."""
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

    def get_quota(self, user_id: str, ip_address: str, max_questions: int) -> dict[str, Any]:
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
        return {"remaining": max(0, max_questions - max(values)), "max": max_questions}

    @staticmethod
    def _decode_node(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        raw_metadata = data.pop("metadata_json", None)
        data["metadata"] = json.loads(raw_metadata) if raw_metadata else None
        return data
