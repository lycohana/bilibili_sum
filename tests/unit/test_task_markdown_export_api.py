import sqlite3
from pathlib import Path

import pytest
from fastapi import HTTPException

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_infra.config import ServiceSettings
from video_sum_service.app import app, settings_manager
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import VideoAssetRecord
from video_sum_service.task_exports import export_task_markdown


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def create_completed_task(repository: SqliteTaskRepository) -> str:
    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV1test",
            platform="bilibili",
            title="测试导出视频",
            source_url="https://www.bilibili.com/video/BV1test",
            cover_url="",
        )
    )
    record = repository.create_task(
        TaskInput(input_type=InputType.URL, source=video.source_url, title=video.title),
        video_id=video.video_id,
    )
    repository.save_result(
        record.task_id,
        TaskResult(
            overview="概览",
            knowledge_note_markdown="# 测试导出视频\n\n## 核心概览\n\n概览",
            key_points=["要点一"],
            timeline=[{"title": "章节一", "start": 12.0, "summary": "章节摘要"}],
            artifacts={"summary_path": "C:/tmp/summary.json"},
        ),
    )
    repository.update_status(record.task_id, TaskStatus.COMPLETED)
    return record.task_id


@pytest.fixture(autouse=True)
def restore_app_state():
    original_repository = getattr(app.state, "task_repository", None)
    original_settings = settings_manager.current
    yield
    app.state.task_repository = original_repository
    settings_manager._settings = original_settings


def test_export_task_markdown_requires_output_dir(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    app.state.task_repository = repository
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir="",
    )
    settings_manager._settings = settings

    with pytest.raises(HTTPException, match="输出目录"):
        export_task_markdown(repository, settings, task_id)


def test_export_task_markdown_writes_file_and_persists_artifact(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    app.state.task_repository = repository
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(tmp_path / "vault"),
    )
    settings_manager._settings = settings

    response = export_task_markdown(repository, settings, task_id)
    refreshed = repository.get_task(task_id)

    assert response.target_format == "obsidian"
    assert response.overwritten is False
    assert Path(response.path).exists()
    assert refreshed is not None
    assert refreshed.result is not None
    assert refreshed.result.artifacts["obsidian_note_path"] == response.path
    content = Path(response.path).read_text(encoding="utf-8")
    assert content.startswith("---\n")
    assert "## 关键要点" in content


def test_export_task_markdown_avoids_overwriting_existing_file(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    output_dir = tmp_path / "vault"
    output_dir.mkdir(parents=True, exist_ok=True)
    existing = output_dir / "测试导出视频 2026-04-22.md"
    existing.write_text("old", encoding="utf-8")

    app.state.task_repository = repository
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(output_dir),
    )
    settings_manager._settings = settings

    response = export_task_markdown(repository, settings, task_id)

    assert response.file_name != existing.name
    assert response.file_name.endswith(".md")
    assert response.overwritten is True


def test_export_task_markdown_rejects_task_without_note(tmp_path: Path) -> None:
    repository = create_repository()
    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV1empty",
            platform="bilibili",
            title="空笔记视频",
            source_url="https://www.bilibili.com/video/BV1empty",
            cover_url="",
        )
    )
    record = repository.create_task(
        TaskInput(input_type=InputType.URL, source=video.source_url, title=video.title),
        video_id=video.video_id,
    )
    repository.save_result(record.task_id, TaskResult(overview="概览", knowledge_note_markdown="", artifacts={}))
    repository.update_status(record.task_id, TaskStatus.COMPLETED)
    app.state.task_repository = repository
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(tmp_path / "vault"),
    )
    settings_manager._settings = settings

    with pytest.raises(HTTPException, match="知识笔记"):
        export_task_markdown(repository, settings, record.task_id)
