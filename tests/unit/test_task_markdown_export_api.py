import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import HTTPException

from video_sum_core.markdown_exports import build_export_filename
from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_infra.config import ServiceSettings
from video_sum_service import task_exports
from video_sum_service.app import app, settings_manager
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import VideoAssetRecord
from video_sum_service.task_exports import export_task_markdown, export_task_transcript


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
            transcript_text="[00:00] 转写内容",
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
    assert "## 转写全文" not in content


def test_export_task_markdown_can_include_transcript_and_override_output_dir(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    app.state.task_repository = repository
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(tmp_path / "default-vault"),
    )
    settings_manager._settings = settings

    response = export_task_markdown(
        repository,
        settings,
        task_id,
        include_transcript=True,
        output_dir=str(tmp_path / "picked-vault"),
    )

    assert Path(response.path).parent == tmp_path / "picked-vault"
    content = Path(response.path).read_text(encoding="utf-8")
    assert "## 转写全文" in content
    assert "[00:00] 转写内容" in content


def test_export_task_markdown_copies_visual_assets_with_relative_links(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    record = repository.get_task(task_id)
    assert record is not None and record.result is not None
    visual_dir = tmp_path / "tasks" / task_id / "visual_evidence"
    frames_dir = visual_dir / "frames"
    frames_dir.mkdir(parents=True)
    frame_path = frames_dir / "f0001.jpg"
    frame_path.write_bytes(b"fake-jpeg")
    visual_note_path = visual_dir / "visual_enhanced_note.md"
    visual_note_path.write_text("## 知识笔记\n\n这个概念需要对照画面理解。\n\n![00:12 画面](visual://f0001)\n\n画面说明被整合进正文。", encoding="utf-8")
    repository.save_result(
        task_id,
        record.result.model_copy(
            update={
                    "visual_note_status": "ready",
                    "visual_note_artifact_path": str(visual_note_path),
                    "visual_enhanced_note_artifact_path": str(visual_note_path),
                    "visual_frame_count": 1,
                    "artifacts": {**record.result.artifacts, "visual_enhanced_note_path": str(visual_note_path)},
                }
            ),
        )
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(tmp_path / "vault"),
    )

    response = export_task_markdown(repository, settings, task_id)
    export_path = Path(response.path)
    content = export_path.read_text(encoding="utf-8")

    assert "这个概念需要对照画面理解。" in content
    assert "画面说明被整合进正文。" in content
    assert "## 视觉证据" not in content
    assert f"]({export_path.stem}.assets/f0001.jpg)" in content
    assert (export_path.parent / f"{export_path.stem}.assets" / "f0001.jpg").read_bytes() == b"fake-jpeg"
    assert "visual_evidence" not in content


def test_export_task_markdown_copies_visual_asset_by_frame_index(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    record = repository.get_task(task_id)
    assert record is not None and record.result is not None
    visual_dir = tmp_path / "tasks" / task_id / "visual_evidence"
    frames_dir = visual_dir / "frames"
    frames_dir.mkdir(parents=True)
    frame_path = frames_dir / "frame-a.webp"
    frame_path.write_bytes(b"fake-webp")
    (visual_dir / "frame_index.json").write_text(
        '{"frames":[{"frame_id":"f0001","file_name":"frame-a.webp","image_path":"frames/frame-a.webp"}]}',
        encoding="utf-8",
    )
    visual_note_path = visual_dir / "visual_enhanced_note.md"
    visual_note_path.write_text("正文。\n\n![00:12 画面](visual://f0001)", encoding="utf-8")
    repository.save_result(
        task_id,
        record.result.model_copy(
            update={
                "visual_note_status": "ready",
                "visual_enhanced_note_artifact_path": str(visual_note_path),
                "visual_frame_count": 1,
                "artifacts": {**record.result.artifacts, "visual_enhanced_note_path": str(visual_note_path)},
            }
        ),
    )
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(tmp_path / "vault"),
    )

    response = export_task_markdown(repository, settings, task_id)
    export_path = Path(response.path)
    content = export_path.read_text(encoding="utf-8")

    assert f"]({export_path.stem}.assets/frame-a.webp)" in content
    assert (export_path.parent / f"{export_path.stem}.assets" / "frame-a.webp").read_bytes() == b"fake-webp"


def test_export_task_markdown_avoids_overwriting_existing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixed_export_time = datetime.fromisoformat("2026-04-22T12:00:00+08:00")

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return fixed_export_time
            return fixed_export_time.astimezone(tz)

    monkeypatch.setattr(task_exports, "datetime", FixedDatetime)
    repository = create_repository()
    task_id = create_completed_task(repository)
    output_dir = tmp_path / "vault"
    output_dir.mkdir(parents=True, exist_ok=True)
    existing = output_dir / build_export_filename("测试导出视频", fixed_export_time)
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


def test_export_task_transcript_writes_file_and_persists_artifact(tmp_path: Path) -> None:
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

    response = export_task_transcript(repository, settings, task_id)
    refreshed = repository.get_task(task_id)

    assert response.target_format == "transcript"
    assert response.file_name.endswith(".txt")
    assert Path(response.path).read_text(encoding="utf-8") == "[00:00] 转写内容"
    assert refreshed is not None
    assert refreshed.result is not None
    assert refreshed.result.artifacts["transcript_export_path"] == response.path


def test_export_task_transcript_rejects_task_without_transcript(tmp_path: Path) -> None:
    repository = create_repository()
    task_id = create_completed_task(repository)
    record = repository.get_task(task_id)
    assert record is not None
    repository.save_result(task_id, record.result.model_copy(update={"transcript_text": "", "artifacts": {}}))
    app.state.task_repository = repository
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        output_dir=str(tmp_path / "vault"),
    )

    with pytest.raises(HTTPException, match="转写全文"):
        export_task_transcript(repository, settings, task_id)
