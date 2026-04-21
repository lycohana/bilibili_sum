import asyncio
import sqlite3
from pathlib import Path

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_service.app import app
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers.tasks import stream_task_events


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def create_running_task(repository: SqliteTaskRepository, tmp_path: Path) -> str:
    record = repository.create_task(TaskInput(input_type=InputType.URL, source="https://example.com/video", title="测试视频"))
    summary_path = tmp_path / f"{record.task_id}-summary.json"
    summary_path.write_text('{"segments":[]}', encoding="utf-8")
    repository.save_result(
        record.task_id,
        TaskResult(
            overview="概览",
            knowledge_note_markdown="# 知识笔记",
            timeline=[],
            artifacts={"summary_path": str(summary_path)},
        ),
    )
    repository.update_status(record.task_id, TaskStatus.RUNNING)
    repository.append_event(record.task_id, stage="running", progress=50, message="处理中")
    return record.task_id


class FakeRequest:
    def __init__(self, disconnect_sequence: list[bool]) -> None:
        self.app = app
        self._disconnect_sequence = disconnect_sequence
        self._index = 0

    async def is_disconnected(self) -> bool:
        if self._index < len(self._disconnect_sequence):
            value = self._disconnect_sequence[self._index]
            self._index += 1
            return value
        return self._disconnect_sequence[-1] if self._disconnect_sequence else False


def test_stream_task_events_stops_when_client_disconnects(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_running_task(repository, tmp_path)
    app.state.task_repository = repository

    async def run() -> None:
        response = await stream_task_events(FakeRequest([False, False, True]), task_id)
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk)

        assert len(chunks) == 1
        assert "\"stage\": \"running\"" in chunks[0]

    asyncio.run(run())
