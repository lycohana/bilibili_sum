import json
import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from video_sum_core.models.tasks import TaskMindMap
from video_sum_infra.config import ServiceSettings

from video_sum_service.schemas import TaskRecord, VideoAssetRecord

logger = logging.getLogger("video_sum_service.app")


def task_artifact_directories(tasks: list[TaskRecord], tasks_dir: Path) -> list[Path]:
    directories: set[Path] = set()
    managed_tasks_dir = tasks_dir.resolve()
    for task in tasks:
        directories.add(managed_tasks_dir / task.task_id)
        if task.result is None:
            continue
        for artifact_path in task.result.artifacts.values():
            try:
                parent = Path(str(artifact_path)).expanduser().resolve().parent
            except (OSError, RuntimeError, TypeError, ValueError):
                continue
            if parent == managed_tasks_dir or managed_tasks_dir in parent.parents:
                directories.add(parent)
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


def cleanup_task_files(task: TaskRecord, current_settings: ServiceSettings) -> None:
    for directory in task_artifact_directories([task], current_settings.tasks_dir):
        try:
            if directory.exists():
                shutil.rmtree(directory, ignore_errors=False)
        except OSError:
            logger.warning("failed to remove task directory: %s", directory, exc_info=True)


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


def load_visual_context(visual_context_path: str) -> dict[str, object]:
    try:
        payload = json.loads(Path(visual_context_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="无法读取当前任务的图文笔记结果。") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="当前任务的图文笔记格式无效。")
    return payload


def load_visual_note_markdown(visual_note_path: str | None) -> str:
    if not visual_note_path:
        return ""
    try:
        return Path(visual_note_path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


VISUAL_FRAME_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def visual_artifact_directories(result: Any, task_id: str, tasks_dir: Path) -> list[Path]:
    directories: list[Path] = []
    seen: set[Path] = set()
    artifacts = getattr(result, "artifacts", {}) or {}
    artifact_paths = [
        getattr(result, "visual_enhanced_note_artifact_path", None),
        getattr(result, "visual_note_artifact_path", None),
        artifacts.get("visual_enhanced_note_path"),
        artifacts.get("visual_note_path"),
        artifacts.get("visual_context_path"),
        artifacts.get("visual_frame_index_path"),
        artifacts.get("visual_keyframe_plan_path"),
        artifacts.get("visual_insert_plan_path"),
    ]

    def add_directory(candidate: Path) -> None:
        try:
            resolved = candidate.expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            return
        if resolved not in seen:
            seen.add(resolved)
            directories.append(resolved)

    for raw_path in artifact_paths:
        if not raw_path:
            continue
        try:
            path = Path(str(raw_path)).expanduser()
        except (OSError, RuntimeError, TypeError, ValueError):
            continue
        add_directory(path.parent if path.suffix else path)

    add_directory(tasks_dir / task_id / "visual_evidence")
    return directories


def resolve_visual_media_path(result: Any, task_id: str, tasks_dir: Path, file_name: str) -> Path | None:
    requested_name = str(file_name or "").strip()
    if not requested_name or "/" in requested_name or "\\" in requested_name:
        return None

    requested_path = Path(requested_name)
    requested_stem = requested_path.stem
    requested_suffix = requested_path.suffix.lower()
    if not requested_stem:
        return None
    if requested_suffix and requested_suffix not in VISUAL_FRAME_SUFFIXES:
        return None

    for visual_dir in visual_artifact_directories(result, task_id, tasks_dir):
        direct_match = _resolve_visual_media_direct_match(visual_dir, requested_name, requested_stem, requested_suffix)
        if direct_match is not None:
            return direct_match

        indexed_match = _resolve_visual_media_index_match(visual_dir, requested_name, requested_stem)
        if indexed_match is not None:
            return indexed_match
    return None


def _resolve_visual_media_direct_match(
    visual_dir: Path,
    requested_name: str,
    requested_stem: str,
    requested_suffix: str,
) -> Path | None:
    candidate_names = [requested_name]
    if requested_suffix:
        candidate_names.extend(f"{requested_stem}{suffix}" for suffix in VISUAL_FRAME_SUFFIXES if suffix != requested_suffix)
    else:
        candidate_names.extend(f"{requested_stem}{suffix}" for suffix in VISUAL_FRAME_SUFFIXES)

    for candidate_name in candidate_names:
        target = _safe_visual_frame_target(visual_dir, Path(candidate_name).name)
        if target is not None:
            return target
    return None


def _resolve_visual_media_index_match(visual_dir: Path, requested_name: str, requested_stem: str) -> Path | None:
    for index_name in ("frame_index.json", "visual_context.json"):
        payload = _read_optional_json(visual_dir / index_name)
        frames = payload.get("frames") if isinstance(payload, dict) else None
        if not isinstance(frames, list):
            continue
        for frame in frames:
            if not isinstance(frame, dict):
                continue
            frame_id = str(frame.get("frame_id") or "").strip()
            file_name = str(frame.get("file_name") or "").strip()
            image_path = str(frame.get("image_path") or "").strip()
            indexed_names = {Path(value).name for value in (file_name, image_path) if value}
            indexed_stems = {Path(value).stem for value in indexed_names if value}
            if frame_id == requested_stem or requested_name in indexed_names or requested_stem in indexed_stems:
                for indexed_name in indexed_names:
                    target = _safe_visual_frame_target(visual_dir, indexed_name)
                    if target is not None:
                        return target
    return None


def _safe_visual_frame_target(visual_dir: Path, file_name: str) -> Path | None:
    if not file_name or "/" in file_name or "\\" in file_name:
        return None
    if Path(file_name).suffix.lower() not in VISUAL_FRAME_SUFFIXES:
        return None
    try:
        frames_dir = (visual_dir / "frames").resolve()
        target = (frames_dir / file_name).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if frames_dir not in target.parents or not target.exists() or not target.is_file():
        return None
    return target


def _read_optional_json(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def load_visual_insert_plan(visual_insert_plan_path: str | None) -> dict[str, object] | None:
    if not visual_insert_plan_path:
        return None
    try:
        payload = json.loads(Path(visual_insert_plan_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None
