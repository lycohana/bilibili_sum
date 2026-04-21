import sqlite3

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_service.app import app
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers.videos import create_video_task, create_video_tasks_batch, create_video_resummary_tasks_batch
from video_sum_service.schemas import VideoAssetRecord


class FakeTaskWorker:
    def __init__(self) -> None:
        self.submitted = []

    def submit(self, record) -> None:
        self.submitted.append(record)


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def append_completed_page_task(repository: SqliteTaskRepository, video_id: str, page_number: int, title: str = "P1") -> str:
    record = repository.create_task(
        TaskInput(input_type=InputType.URL, source=f"https://example.com/video?p={page_number}", title=title, platform_hint="bilibili"),
        video_id=video_id,
        page_number=page_number,
        page_title=title,
    )
    repository.update_status(record.task_id, TaskStatus.COMPLETED)
    repository.save_result(
        record.task_id,
        TaskResult(
            overview="done",
            transcript_text="[00:00] hello",
            artifacts={"summary_path": f"C:/tmp/{record.task_id}-summary.json"},
        ),
    )
    return record.task_id


def test_create_video_task_uses_video_file_input_for_local_asset() -> None:
    repository = create_repository()
    worker = FakeTaskWorker()
    asset = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="local-test-video",
            platform="local",
            title="本地视频",
            source_url=r"C:\videos\sample.mp4",
            cover_url="/media/covers/local-test-video.jpg",
            duration=42.0,
        )
    )
    app.state.task_repository = repository
    app.state.task_worker = worker

    response = create_video_task(type("Request", (), {"app": app})(), asset.video_id)

    assert len(worker.submitted) == 1
    assert worker.submitted[0].task_input.input_type is InputType.VIDEO_FILE
    assert worker.submitted[0].task_input.source == asset.source_url
    assert response.input_type == InputType.VIDEO_FILE.value
    assert response.video_id == asset.video_id


def test_create_video_task_does_not_reprobe_page_metadata_before_submit(monkeypatch) -> None:
    repository = create_repository()
    worker = FakeTaskWorker()
    asset = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-no-reprobe",
            platform="bilibili",
            title="测试合集",
            source_url="https://www.bilibili.com/video/BV-no-reprobe",
            pages=[
                {"page": 1, "title": "P1 开场", "source_url": "https://www.bilibili.com/video/BV-no-reprobe?p=1", "cover_url": "", "duration": None},
            ],
        )
    )
    app.state.task_repository = repository
    app.state.task_worker = worker
    monkeypatch.setattr(
        "video_sum_service.routers.videos.probe_video_asset",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("should not be called")),
    )

    response = create_video_task(
        type("Request", (), {"app": app})(),
        asset.video_id,
        type("Body", (), {"page_number": 1})(),
    )

    assert len(worker.submitted) == 1
    assert worker.submitted[0].task_input.source == "https://www.bilibili.com/video/BV-no-reprobe?p=1"
    assert response.page_number == 1


def test_create_video_tasks_batch_requires_confirmation_for_completed_pages() -> None:
    repository = create_repository()
    worker = FakeTaskWorker()
    asset = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-batch-confirm",
            platform="bilibili",
            title="测试合集",
            source_url="https://www.bilibili.com/video/BV-batch-confirm",
            pages=[
                {"page": 1, "title": "P1 开场", "source_url": "https://www.bilibili.com/video/BV-batch-confirm?p=1", "cover_url": ""},
                {"page": 2, "title": "P2 正片", "source_url": "https://www.bilibili.com/video/BV-batch-confirm?p=2", "cover_url": ""},
            ],
        )
    )
    append_completed_page_task(repository, asset.video_id, 1, "P1 开场")
    app.state.task_repository = repository
    app.state.task_worker = worker

    response = create_video_tasks_batch(
        asset.video_id,
        type("Body", (), {"page_numbers": [1, 2], "confirm": False})(),
        type("Request", (), {"app": app})(),
    )

    assert response.requires_confirmation is True
    assert response.created_tasks == []
    assert len(response.conflict_pages) == 1
    assert response.conflict_pages[0].page_number == 1
    assert worker.submitted == []


def test_create_video_resummary_tasks_batch_creates_new_tasks_after_confirmation(monkeypatch) -> None:
    repository = create_repository()
    worker = FakeTaskWorker()
    asset = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-batch-resummary",
            platform="bilibili",
            title="测试合集",
            source_url="https://www.bilibili.com/video/BV-batch-resummary",
            pages=[
                {"page": 1, "title": "P1 开场", "source_url": "https://www.bilibili.com/video/BV-batch-resummary?p=1", "cover_url": ""},
                {"page": 2, "title": "P2 正片", "source_url": "https://www.bilibili.com/video/BV-batch-resummary?p=2", "cover_url": ""},
            ],
        )
    )
    append_completed_page_task(repository, asset.video_id, 1, "P1 开场")
    app.state.task_repository = repository
    app.state.task_worker = worker
    monkeypatch.setattr("video_sum_service.routers.videos.load_task_segments", lambda _path: [{"start": 0, "text": "hello"}])

    preview = create_video_resummary_tasks_batch(
        asset.video_id,
        type("Body", (), {"page_numbers": [1, 2], "confirm": False})(),
        type("Request", (), {"app": app})(),
    )
    confirmed = create_video_resummary_tasks_batch(
        asset.video_id,
        type("Body", (), {"page_numbers": [1, 2], "confirm": True})(),
        type("Request", (), {"app": app})(),
    )

    assert preview.requires_confirmation is True
    assert len(preview.conflict_pages) == 1
    assert preview.conflict_pages[0].page_number == 1
    assert confirmed.requires_confirmation is False
    assert len(confirmed.created_tasks) == 1
    assert confirmed.created_tasks[0].page_number == 1
    assert len(confirmed.skipped_pages) == 1
    assert confirmed.skipped_pages[0].page_number == 2
    assert worker.submitted[-1].task_input.input_type is InputType.TRANSCRIPT_TEXT
