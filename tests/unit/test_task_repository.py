import sqlite3

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_service.repository import SqliteTaskRepository


def test_repository_create_and_fetch_task() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    record = repository.create_task(
        TaskInput(input_type=InputType.URL, source="https://example.com/video")
    )
    fetched = repository.get_task(record.task_id)

    assert fetched is not None
    assert fetched.task_id == record.task_id
    assert fetched.status == TaskStatus.QUEUED


def test_repository_updates_status() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    record = repository.create_task(TaskInput(input_type=InputType.URL, source="https://example.com"))
    updated = repository.update_status(record.task_id, TaskStatus.RUNNING)

    assert updated is not None
    assert updated.status == TaskStatus.RUNNING


def test_repository_saves_result_and_events() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    record = repository.create_task(TaskInput(input_type=InputType.URL, source="https://example.com"))
    repository.append_event(record.task_id, stage="running", progress=50, message="处理中")
    repository.save_result(record.task_id, TaskResult(transcript_text="hello"))

    fetched = repository.get_task(record.task_id)
    events = repository.list_events(record.task_id)

    assert fetched is not None
    assert fetched.result is not None
    assert fetched.result.transcript_text == "hello"
    assert len(events) == 1
    assert events[0].stage == "running"
