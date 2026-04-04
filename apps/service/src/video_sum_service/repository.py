import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from video_sum_core.models.tasks import TaskInput, TaskResult, TaskStatus
from video_sum_infra.db import sqlite_cursor
from video_sum_service.schemas import (
    TaskEventRecord,
    TaskRecord,
    VideoAssetRecord,
)


class SqliteTaskRepository:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self._lock = Lock()

    def initialize(self) -> None:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS video_assets (
                    video_id TEXT PRIMARY KEY,
                    canonical_id TEXT NOT NULL UNIQUE,
                    platform TEXT NOT NULL,
                    title TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    cover_url TEXT,
                    duration REAL,
                    latest_task_id TEXT,
                    latest_status TEXT,
                    latest_stage TEXT,
                    latest_error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    video_id TEXT,
                    status TEXT NOT NULL,
                    task_input_json TEXT NOT NULL,
                    result_json TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._ensure_column(cursor, "tasks", "video_id", "TEXT")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS task_results (
                    task_id TEXT PRIMARY KEY,
                    result_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS task_events (
                    event_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    progress INTEGER NOT NULL,
                    message TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
                )
                """
            )

    def _ensure_column(self, cursor: sqlite3.Cursor, table: str, column: str, definition: str) -> None:
        rows = cursor.execute(f"PRAGMA table_info({table})").fetchall()
        names = {row["name"] if isinstance(row, sqlite3.Row) else row[1] for row in rows}
        if column not in names:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def upsert_video_asset(self, asset: VideoAssetRecord) -> VideoAssetRecord:
        updated_at = datetime.now(timezone.utc).isoformat()
        created_at = asset.created_at.isoformat()
        with self._lock, sqlite_cursor(self._connection) as cursor:
            existing = cursor.execute(
                "SELECT video_id, created_at FROM video_assets WHERE canonical_id = ?",
                (asset.canonical_id,),
            ).fetchone()
            video_id = existing["video_id"] if existing is not None else asset.video_id
            created = existing["created_at"] if existing is not None else created_at
            cursor.execute(
                """
                INSERT INTO video_assets (
                    video_id, canonical_id, platform, title, source_url, cover_url, duration,
                    latest_task_id, latest_status, latest_stage, latest_error_message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(canonical_id) DO UPDATE SET
                    title = excluded.title,
                    source_url = excluded.source_url,
                    cover_url = excluded.cover_url,
                    duration = excluded.duration,
                    updated_at = excluded.updated_at
                """,
                (
                    video_id,
                    asset.canonical_id,
                    asset.platform,
                    asset.title,
                    asset.source_url,
                    asset.cover_url,
                    asset.duration,
                    asset.latest_task_id,
                    asset.latest_status.value if asset.latest_status else None,
                    asset.latest_stage,
                    asset.latest_error_message,
                    created,
                    updated_at,
                ),
            )
        refreshed = self.get_video_asset(video_id)
        assert refreshed is not None
        return refreshed

    def get_video_asset(self, video_id: str) -> VideoAssetRecord | None:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            row = cursor.execute(
                """
                SELECT
                    v.video_id, v.canonical_id, v.platform, v.title, v.source_url, v.cover_url, v.duration,
                    v.latest_task_id, v.latest_status, v.latest_stage, v.latest_error_message,
                    v.created_at, v.updated_at, r.result_json AS latest_result_json
                FROM video_assets v
                LEFT JOIN task_results r ON r.task_id = v.latest_task_id
                WHERE v.video_id = ?
                """,
                (video_id,),
            ).fetchone()
        return self._row_to_video_asset(row) if row is not None else None

    def get_video_asset_by_canonical_id(self, canonical_id: str) -> VideoAssetRecord | None:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            row = cursor.execute(
                """
                SELECT
                    v.video_id, v.canonical_id, v.platform, v.title, v.source_url, v.cover_url, v.duration,
                    v.latest_task_id, v.latest_status, v.latest_stage, v.latest_error_message,
                    v.created_at, v.updated_at, r.result_json AS latest_result_json
                FROM video_assets v
                LEFT JOIN task_results r ON r.task_id = v.latest_task_id
                WHERE v.canonical_id = ?
                """,
                (canonical_id,),
            ).fetchone()
        return self._row_to_video_asset(row) if row is not None else None

    def list_video_assets(self) -> list[VideoAssetRecord]:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            rows = cursor.execute(
                """
                SELECT
                    v.video_id, v.canonical_id, v.platform, v.title, v.source_url, v.cover_url, v.duration,
                    v.latest_task_id, v.latest_status, v.latest_stage, v.latest_error_message,
                    v.created_at, v.updated_at, r.result_json AS latest_result_json
                FROM video_assets v
                LEFT JOIN task_results r ON r.task_id = v.latest_task_id
                ORDER BY v.updated_at DESC
                """
            ).fetchall()
        return [self._row_to_video_asset(row) for row in rows]

    def create_task(self, task_input: TaskInput, video_id: str | None = None) -> TaskRecord:
        record = TaskRecord(task_input=task_input, video_id=video_id)
        payload = self._serialize_record(record)
        with self._lock, sqlite_cursor(self._connection) as cursor:
            cursor.execute(
                """
                INSERT INTO tasks (
                    task_id, video_id, status, task_input_json, result_json, error_code,
                    error_message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["task_id"],
                    payload["video_id"],
                    payload["status"],
                    payload["task_input_json"],
                    payload["result_json"],
                    payload["error_code"],
                    payload["error_message"],
                    payload["created_at"],
                    payload["updated_at"],
                ),
            )
            if video_id:
                cursor.execute(
                    """
                    UPDATE video_assets
                    SET latest_task_id = ?, latest_status = ?, latest_stage = ?, latest_error_message = NULL, updated_at = ?
                    WHERE video_id = ?
                    """,
                    (record.task_id, record.status.value, "queued", payload["updated_at"], video_id),
                )
        return record

    def list_tasks(self) -> list[TaskRecord]:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            rows = cursor.execute(
                """
                SELECT
                    t.task_id, t.video_id, t.status, t.task_input_json, r.result_json, t.error_code,
                    t.error_message, t.created_at, t.updated_at
                FROM tasks t
                LEFT JOIN task_results r ON r.task_id = t.task_id
                ORDER BY t.created_at DESC
                """
            ).fetchall()
        return [self._row_to_record(row) for row in rows]

    def list_tasks_for_video(self, video_id: str) -> list[TaskRecord]:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            rows = cursor.execute(
                """
                SELECT
                    t.task_id, t.video_id, t.status, t.task_input_json, r.result_json, t.error_code,
                    t.error_message, t.created_at, t.updated_at
                FROM tasks t
                LEFT JOIN task_results r ON r.task_id = t.task_id
                WHERE t.video_id = ?
                ORDER BY t.created_at DESC
                """,
                (video_id,),
            ).fetchall()
        return [self._row_to_record(row) for row in rows]

    def get_task(self, task_id: str) -> TaskRecord | None:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            row = cursor.execute(
                """
                SELECT
                    t.task_id, t.video_id, t.status, t.task_input_json, r.result_json, t.error_code,
                    t.error_message, t.created_at, t.updated_at
                FROM tasks t
                LEFT JOIN task_results r ON r.task_id = t.task_id
                WHERE t.task_id = ?
                """,
                (task_id,),
            ).fetchone()
        return self._row_to_record(row) if row is not None else None

    def delete_task(self, task_id: str) -> bool:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            row = cursor.execute("SELECT video_id FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            if row is None:
                return False
            video_id = row["video_id"]
            cursor.execute("DELETE FROM task_events WHERE task_id = ?", (task_id,))
            cursor.execute("DELETE FROM task_results WHERE task_id = ?", (task_id,))
            cursor.execute("DELETE FROM tasks WHERE task_id = ?", (task_id,))
            if video_id:
                latest = cursor.execute(
                    """
                    SELECT task_id, status, error_message, updated_at
                    FROM tasks
                    WHERE video_id = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    (video_id,),
                ).fetchone()
                if latest is None:
                    cursor.execute(
                        """
                        UPDATE video_assets
                        SET latest_task_id = NULL, latest_status = NULL, latest_stage = NULL,
                            latest_error_message = NULL, updated_at = ?
                        WHERE video_id = ?
                        """,
                        (datetime.now(timezone.utc).isoformat(), video_id),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE video_assets
                        SET latest_task_id = ?, latest_status = ?, latest_error_message = ?, updated_at = ?
                        WHERE video_id = ?
                        """,
                        (
                            latest["task_id"],
                            latest["status"],
                            latest["error_message"],
                            latest["updated_at"],
                            video_id,
                        ),
                    )
        return True

    def delete_video_asset(self, video_id: str) -> bool:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            video_row = cursor.execute(
                "SELECT cover_url FROM video_assets WHERE video_id = ?",
                (video_id,),
            ).fetchone()
            if video_row is None:
                return False

            task_rows = cursor.execute(
                "SELECT task_id FROM tasks WHERE video_id = ?",
                (video_id,),
            ).fetchall()
            task_ids = [row["task_id"] for row in task_rows]

            for task_id in task_ids:
                cursor.execute("DELETE FROM task_events WHERE task_id = ?", (task_id,))
                cursor.execute("DELETE FROM task_results WHERE task_id = ?", (task_id,))
            cursor.execute("DELETE FROM tasks WHERE video_id = ?", (video_id,))
            cursor.execute("DELETE FROM video_assets WHERE video_id = ?", (video_id,))

        cover_url = video_row["cover_url"] if video_row is not None else ""
        if cover_url and str(cover_url).startswith("/media/covers/"):
            try:
                cover_path = Path(str(cover_url).replace("/media/covers/", "", 1))
                local_cover = Path.cwd() / ".data" / "cache" / "covers" / cover_path.name
                if local_cover.exists():
                    local_cover.unlink()
            except OSError:
                pass
        return True

    def update_status(self, task_id: str, status: TaskStatus) -> TaskRecord | None:
        updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock, sqlite_cursor(self._connection) as cursor:
            cursor.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?",
                (status.value, updated_at, task_id),
            )
            row = cursor.execute("SELECT video_id FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            if row is not None and row["video_id"]:
                cursor.execute(
                    """
                    UPDATE video_assets
                    SET latest_task_id = ?, latest_status = ?, updated_at = ?
                    WHERE video_id = ?
                    """,
                    (task_id, status.value, updated_at, row["video_id"]),
                )
        return self.get_task(task_id)

    def save_result(self, task_id: str, result: TaskResult) -> TaskRecord | None:
        updated_at = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(result.model_dump(mode="json"), ensure_ascii=False)
        with self._lock, sqlite_cursor(self._connection) as cursor:
            cursor.execute(
                """
                INSERT INTO task_results (task_id, result_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET result_json = excluded.result_json, updated_at = excluded.updated_at
                """,
                (task_id, payload, updated_at),
            )
            cursor.execute("UPDATE tasks SET updated_at = ? WHERE task_id = ?", (updated_at, task_id))
            row = cursor.execute("SELECT video_id FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            if row is not None and row["video_id"]:
                cursor.execute(
                    """
                    UPDATE video_assets
                    SET latest_task_id = ?, updated_at = ?
                    WHERE video_id = ?
                    """,
                    (task_id, updated_at, row["video_id"]),
                )
        return self.get_task(task_id)

    def update_error(self, task_id: str, error_code: str, error_message: str) -> TaskRecord | None:
        updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock, sqlite_cursor(self._connection) as cursor:
            cursor.execute(
                """
                UPDATE tasks SET error_code = ?, error_message = ?, updated_at = ? WHERE task_id = ?
                """,
                (error_code, error_message, updated_at, task_id),
            )
            row = cursor.execute("SELECT video_id FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            if row is not None and row["video_id"]:
                cursor.execute(
                    """
                    UPDATE video_assets
                    SET latest_task_id = ?, latest_error_message = ?, updated_at = ?
                    WHERE video_id = ?
                    """,
                    (task_id, error_message, updated_at, row["video_id"]),
                )
        return self.get_task(task_id)

    def append_event(
        self,
        task_id: str,
        stage: str,
        progress: int,
        message: str,
        payload: dict[str, object] | None = None,
    ) -> TaskEventRecord:
        event = TaskEventRecord(task_id=task_id, stage=stage, progress=progress, message=message, payload=payload or {})
        updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock, sqlite_cursor(self._connection) as cursor:
            cursor.execute(
                """
                INSERT INTO task_events (event_id, task_id, stage, progress, message, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.task_id,
                    event.stage,
                    event.progress,
                    event.message,
                    json.dumps(event.payload, ensure_ascii=False),
                    event.created_at.isoformat(),
                ),
            )
            row = cursor.execute("SELECT video_id FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            if row is not None and row["video_id"]:
                cursor.execute(
                    """
                    UPDATE video_assets
                    SET latest_stage = ?, updated_at = ?
                    WHERE video_id = ?
                    """,
                    (stage, updated_at, row["video_id"]),
                )
        return event

    def list_events(self, task_id: str) -> list[TaskEventRecord]:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            rows = cursor.execute(
                """
                SELECT event_id, task_id, stage, progress, message, payload_json, created_at
                FROM task_events
                WHERE task_id = ?
                ORDER BY created_at ASC
                """,
                (task_id,),
            ).fetchall()
        return [self._row_to_event(row) for row in rows]

    def list_events_after(self, task_id: str, after_created_at: str | None) -> list[TaskEventRecord]:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            if after_created_at:
                rows = cursor.execute(
                    """
                    SELECT event_id, task_id, stage, progress, message, payload_json, created_at
                    FROM task_events
                    WHERE task_id = ? AND created_at > ?
                    ORDER BY created_at ASC
                    """,
                    (task_id, after_created_at),
                ).fetchall()
            else:
                rows = cursor.execute(
                    """
                    SELECT event_id, task_id, stage, progress, message, payload_json, created_at
                    FROM task_events
                    WHERE task_id = ?
                    ORDER BY created_at ASC
                    """,
                    (task_id,),
                ).fetchall()
        return [self._row_to_event(row) for row in rows]

    def get_latest_event(self, task_id: str) -> TaskEventRecord | None:
        with self._lock, sqlite_cursor(self._connection) as cursor:
            row = cursor.execute(
                """
                SELECT event_id, task_id, stage, progress, message, payload_json, created_at
                FROM task_events WHERE task_id = ?
                ORDER BY created_at DESC LIMIT 1
                """,
                (task_id,),
            ).fetchone()
        return self._row_to_event(row) if row is not None else None

    def _serialize_record(self, record: TaskRecord) -> dict[str, str | None]:
        return {
            "task_id": record.task_id,
            "video_id": record.video_id,
            "status": record.status.value,
            "task_input_json": json.dumps(record.task_input.model_dump(mode="json"), ensure_ascii=False),
            "result_json": (
                json.dumps(record.result.model_dump(mode="json"), ensure_ascii=False)
                if record.result is not None
                else None
            ),
            "error_code": record.error_code,
            "error_message": record.error_message,
            "created_at": record.created_at.isoformat(),
            "updated_at": record.updated_at.isoformat(),
        }

    def _row_to_record(self, row: sqlite3.Row) -> TaskRecord:
        task_input = TaskInput.model_validate(json.loads(row["task_input_json"]))
        result = TaskResult.model_validate(json.loads(row["result_json"])) if row["result_json"] else None
        return TaskRecord(
            task_id=row["task_id"],
            video_id=row["video_id"],
            status=TaskStatus(row["status"]),
            task_input=task_input,
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            result=result,
            error_code=row["error_code"],
            error_message=row["error_message"],
        )

    def _row_to_video_asset(self, row: sqlite3.Row) -> VideoAssetRecord:
        latest_result = (
            TaskResult.model_validate(json.loads(row["latest_result_json"]))
            if row["latest_result_json"]
            else None
        )
        return VideoAssetRecord(
            video_id=row["video_id"],
            canonical_id=row["canonical_id"],
            platform=row["platform"],
            title=row["title"],
            source_url=row["source_url"],
            cover_url=row["cover_url"] or "",
            duration=row["duration"],
            latest_task_id=row["latest_task_id"],
            latest_status=TaskStatus(row["latest_status"]) if row["latest_status"] else None,
            latest_stage=row["latest_stage"],
            latest_result=latest_result,
            latest_error_message=row["latest_error_message"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def _row_to_event(self, row: sqlite3.Row) -> TaskEventRecord:
        return TaskEventRecord(
            event_id=row["event_id"],
            task_id=row["task_id"],
            stage=row["stage"],
            progress=row["progress"],
            message=row["message"],
            created_at=datetime.fromisoformat(row["created_at"]),
            payload=json.loads(row["payload_json"]),
        )
