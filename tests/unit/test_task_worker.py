import sqlite3
from pathlib import Path

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_core.pipeline.base import PipelineContext, PipelineRunner
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.worker import TaskWorker


class FakePipelineRunner(PipelineRunner):
    def __init__(self, result: TaskResult) -> None:
        self._result = result

    def run(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        return [], self._result


class TrackingTaskWorker(TaskWorker):
    def __init__(self, repository: SqliteTaskRepository, pipeline_runner: PipelineRunner, *, auto_generate_mindmap: bool) -> None:
        super().__init__(repository, pipeline_runner, auto_generate_mindmap=auto_generate_mindmap)
        self.mindmap_calls: list[tuple[str, bool]] = []

    def submit_mindmap(self, task_id: str, *, force: bool = False) -> None:  # type: ignore[override]
        self.mindmap_calls.append((task_id, force))


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def create_task(repository: SqliteTaskRepository):
    return repository.create_task(
        TaskInput(input_type=InputType.URL, source="https://example.com/video", title="测试视频")
    )


def test_worker_auto_generates_mindmap_when_enabled() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记",
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=True)

    worker._run_task(record.task_id)

    refreshed = repository.get_task(record.task_id)
    assert refreshed is not None
    assert refreshed.status == TaskStatus.COMPLETED
    assert worker.mindmap_calls == [(record.task_id, False)]
    assert any(event.stage == "mindmap_queued" for event in repository.list_events(record.task_id))


def test_worker_skips_auto_mindmap_when_disabled() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记",
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=False)

    worker._run_task(record.task_id)

    assert worker.mindmap_calls == []


def test_worker_skips_auto_mindmap_when_required_inputs_are_missing() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="",
        artifacts={},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=True)

    worker._run_task(record.task_id)

    assert worker.mindmap_calls == []
