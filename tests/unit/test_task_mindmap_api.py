import json
import sqlite3
from pathlib import Path

import pytest
from fastapi import HTTPException

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_service.app import app, generate_task_mindmap, get_task_mindmap
from video_sum_service.repository import SqliteTaskRepository


class StubWorker:
    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []

    def submit_mindmap(self, task_id: str, *, force: bool = False) -> None:
        self.calls.append((task_id, force))


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def create_completed_task(
    repository: SqliteTaskRepository,
    tmp_path: Path,
    *,
    with_note: bool = True,
    with_summary: bool = True,
    with_mindmap: bool = False,
):
    record = repository.create_task(TaskInput(input_type=InputType.URL, source="https://example.com/video", title="测试视频"))
    artifacts: dict[str, str] = {}
    if with_summary:
        summary_path = tmp_path / f"{record.task_id}-summary.json"
        summary_path.write_text(json.dumps({"segments": [{"start": 0, "text": "内容"}]}, ensure_ascii=False), encoding="utf-8")
        artifacts["summary_path"] = str(summary_path)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记" if with_note else "",
        timeline=[{"title": "章节一", "start": 0.0, "summary": "章节摘要"}],
        artifacts=artifacts,
    )
    if with_mindmap:
        mindmap_path = tmp_path / f"{record.task_id}-mindmap.json"
        mindmap_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "title": "导图",
                    "root": "root",
                    "nodes": [
                        {
                            "id": "root",
                            "label": "导图",
                            "type": "root",
                            "summary": "",
                            "children": [],
                            "source_chapter_titles": [],
                            "source_chapter_starts": [],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        result = result.model_copy(
            update={
                "mindmap_status": "ready",
                "mindmap_artifact_path": str(mindmap_path),
                "artifacts": {**result.artifacts, "mindmap_path": str(mindmap_path)},
            }
        )
    repository.save_result(record.task_id, result)
    repository.update_status(record.task_id, TaskStatus.COMPLETED)
    return repository.get_task(record.task_id)


def test_get_task_mindmap_returns_idle_when_missing(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path)
    app.state.task_repository = repository

    response = get_task_mindmap(record.task_id)

    assert response.status == "idle"
    assert response.mindmap is None


def test_get_task_mindmap_returns_ready_payload(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path, with_mindmap=True)
    app.state.task_repository = repository

    response = get_task_mindmap(record.task_id)

    assert response.status == "ready"
    assert response.mindmap is not None
    assert response.mindmap.root == "root"


def test_get_task_mindmap_hides_stale_artifact_while_generating(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path, with_mindmap=True)
    generating = record.result.model_copy(
        update={
            "mindmap_status": "generating",
            "mindmap_error_message": None,
        }
    )
    repository.save_result(record.task_id, generating)
    app.state.task_repository = repository

    response = get_task_mindmap(record.task_id)

    assert response.status == "generating"
    assert response.mindmap is None


def test_get_task_mindmap_returns_failed_when_artifact_is_missing(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path)
    broken = record.result.model_copy(
        update={
            "mindmap_status": "ready",
            "mindmap_artifact_path": str(tmp_path / "missing-mindmap.json"),
            "artifacts": {**record.result.artifacts, "mindmap_path": str(tmp_path / "missing-mindmap.json")},
        }
    )
    repository.save_result(record.task_id, broken)
    app.state.task_repository = repository

    response = get_task_mindmap(record.task_id)

    assert response.status == "failed"
    assert response.mindmap is None
    assert "缺失" in (response.error_message or "") or "损坏" in (response.error_message or "")


def test_generate_task_mindmap_sets_generating_and_dispatches_worker(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path)
    worker = StubWorker()
    app.state.task_repository = repository
    app.state.task_worker = worker

    response = generate_task_mindmap(record.task_id)
    refreshed = repository.get_task(record.task_id)

    assert response.status == "generating"
    assert refreshed is not None
    assert refreshed.result is not None
    assert refreshed.result.mindmap_status == "generating"
    assert worker.calls == [(record.task_id, False)]


def test_generate_task_mindmap_reuses_ready_artifact_without_force(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path, with_mindmap=True)
    worker = StubWorker()
    app.state.task_repository = repository
    app.state.task_worker = worker

    response = generate_task_mindmap(record.task_id)

    assert response.status == "ready"
    assert response.mindmap is not None
    assert worker.calls == []


def test_generate_task_mindmap_requires_knowledge_note_and_summary(tmp_path: Path) -> None:
    repository = create_repository()
    record = create_completed_task(repository, tmp_path, with_note=False, with_summary=False)
    worker = StubWorker()
    app.state.task_repository = repository
    app.state.task_worker = worker

    with pytest.raises(HTTPException):
        generate_task_mindmap(record.task_id)
