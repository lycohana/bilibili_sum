import sqlite3

from video_sum_core.models.tasks import InputType
from video_sum_service.app import app
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers.videos import create_video_task
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
