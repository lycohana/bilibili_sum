import asyncio
import sqlite3

from video_sum_service.app import app
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers import videos as video_router
from video_sum_service.schemas import VideoAssetRecord


class _FakeStreamRequest:
    def __init__(self, repository: SqliteTaskRepository, chunks: list[bytes]) -> None:
        self.app = app
        self.app.state.task_repository = repository
        self._chunks = chunks

    async def stream(self):
        for chunk in self._chunks:
            yield chunk
        yield b""


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def test_upload_local_video_uses_uploaded_file_name(monkeypatch, tmp_path) -> None:
    repository = create_repository()
    monkeypatch.setattr(video_router, "LOCAL_MEDIA_UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(video_router, "localize_video_cover", lambda task_store, asset: asset)
    monkeypatch.setattr(
        video_router,
        "probe_local_video_asset",
        lambda file_path, **kwargs: VideoAssetRecord(
            canonical_id=kwargs["canonical_id_override"],
            platform="local",
            title=kwargs["title_override"],
            source_url=str(file_path),
            cover_url="/media/covers/local-upload-demo.jpg",
            duration=12.0,
        ),
    )
    request = _FakeStreamRequest(repository, [b"video-bytes"])

    response = asyncio.run(video_router.upload_local_video(request, filename="web-demo.mp4"))

    assert response.cached is False
    assert response.video.platform == "local"
    assert response.video.title == "web-demo"
    assert response.video.source_url.endswith(".mp4")
