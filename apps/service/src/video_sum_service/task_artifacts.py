import json
import logging
import shutil
from pathlib import Path

from fastapi import HTTPException

from video_sum_core.models.tasks import TaskMindMap
from video_sum_infra.config import ServiceSettings

from video_sum_service.schemas import TaskRecord, VideoAssetRecord

logger = logging.getLogger("video_sum_service.app")


def task_artifact_directories(tasks: list[TaskRecord], tasks_dir: Path) -> list[Path]:
    directories: set[Path] = set()
    for task in tasks:
        directories.add(tasks_dir / task.task_id)
        if task.result is None:
            continue
        for artifact_path in task.result.artifacts.values():
            try:
                path = Path(str(artifact_path))
            except (TypeError, ValueError):
                continue
            directories.add(path.parent)
    return sorted(directories, key=lambda item: len(item.parts), reverse=True)


def video_cover_paths(video: VideoAssetRecord, cache_dir: Path) -> list[Path]:
    cover_paths: set[Path] = set()
    cover_url = str(video.cover_url or "")
    if cover_url.startswith("/media/covers/"):
        cover_paths.add(cache_dir / "covers" / Path(cover_url).name)
    return sorted(cover_paths)


def video_source_paths(video: VideoAssetRecord, cache_dir: Path) -> list[Path]:
    source_paths: set[Path] = set()
    if str(video.platform or "").lower() != "local":
        return []
    try:
        source_path = Path(str(video.source_url or "")).resolve()
        uploads_dir = (cache_dir / "uploads").resolve()
        if uploads_dir in source_path.parents:
            source_paths.add(source_path)
    except (OSError, RuntimeError, ValueError):
        return []
    return sorted(source_paths)


def cleanup_video_files(video: VideoAssetRecord, tasks: list[TaskRecord], current_settings: ServiceSettings) -> None:
    for directory in task_artifact_directories(tasks, current_settings.tasks_dir):
        try:
            if directory.exists():
                shutil.rmtree(directory, ignore_errors=False)
        except OSError:
            logger.warning("failed to remove task directory: %s", directory, exc_info=True)

    for cover_path in video_cover_paths(video, current_settings.cache_dir):
        try:
            if cover_path.exists():
                cover_path.unlink()
        except OSError:
            logger.warning("failed to remove cached cover: %s", cover_path, exc_info=True)

    for source_path in video_source_paths(video, current_settings.cache_dir):
        try:
            if source_path.exists():
                source_path.unlink()
        except OSError:
            logger.warning("failed to remove cached local media source: %s", source_path, exc_info=True)


def load_task_segments(summary_path: str) -> list[dict[str, object]]:
    try:
        payload = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="无法读取当前任务的分段结果。") from exc

    segments = payload.get("segments")
    if not isinstance(segments, list) or not segments:
        raise HTTPException(status_code=400, detail="当前任务缺少可复用的分段数据。")
    return segments


def load_task_mindmap(mindmap_path: str) -> TaskMindMap:
    try:
        payload = json.loads(Path(mindmap_path).read_text(encoding="utf-8"))
        return TaskMindMap.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail="无法读取当前任务的思维导图结果。") from exc
