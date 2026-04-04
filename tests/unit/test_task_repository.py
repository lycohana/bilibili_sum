import sqlite3

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import VideoAssetRecord


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


def test_repository_upserts_video_asset() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    asset = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-test",
            platform="bilibili",
            title="示例视频",
            source_url="https://www.bilibili.com/video/BV-test",
            cover_url="https://example.com/cover.jpg",
            duration=120.0,
        )
    )
    fetched = repository.get_video_asset(asset.video_id)

    assert fetched is not None
    assert fetched.title == "示例视频"
    assert fetched.cover_url.endswith("cover.jpg")


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
    repository.save_result(
        record.task_id,
        TaskResult(transcript_text="hello", llm_total_tokens=321),
    )

    fetched = repository.get_task(record.task_id)
    events = repository.list_events(record.task_id)
    listed = repository.list_tasks()

    assert fetched is not None
    assert fetched.result is not None
    assert fetched.result.transcript_text == "hello"
    assert fetched.result.llm_total_tokens == 321
    assert listed[0].result is not None
    assert listed[0].result.llm_total_tokens == 321
    assert len(events) == 1
    assert events[0].stage == "running"


def test_task_summary_includes_duration_and_llm_tokens() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    record = repository.create_task(TaskInput(input_type=InputType.URL, source="https://example.com"))
    repository.save_result(record.task_id, TaskResult(llm_total_tokens=456))
    repository.update_status(record.task_id, TaskStatus.COMPLETED)

    fetched = repository.get_task(record.task_id)

    assert fetched is not None
    summary = fetched.to_summary()
    assert summary.llm_total_tokens == 456
    assert summary.task_duration_seconds is not None
    assert summary.task_duration_seconds >= 0


def test_repository_lists_incremental_events() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    record = repository.create_task(TaskInput(input_type=InputType.URL, source="https://example.com"))
    first = repository.append_event(record.task_id, stage="queued", progress=0, message="排队中")
    repository.append_event(record.task_id, stage="running", progress=50, message="处理中")

    events = repository.list_events_after(record.task_id, first.created_at.isoformat())

    assert len(events) == 1
    assert events[0].stage == "running"


def test_repository_deletes_task() -> None:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()

    asset = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-delete",
            platform="bilibili",
            title="待删除视频",
            source_url="https://www.bilibili.com/video/BV-delete",
        )
    )
    record = repository.create_task(
        TaskInput(input_type=InputType.URL, source="https://example.com"),
        video_id=asset.video_id,
    )
    repository.append_event(record.task_id, stage="queued", progress=0, message="排队中")

    deleted = repository.delete_task(record.task_id)

    assert deleted is True
    assert repository.get_task(record.task_id) is None
