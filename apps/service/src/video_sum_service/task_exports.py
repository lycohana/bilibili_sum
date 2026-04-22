from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import HTTPException

from video_sum_core.models.tasks import TaskStatus
from video_sum_core.markdown_exports import build_export_filename, build_task_markdown_export
from video_sum_infra.config import ServiceSettings

from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import TaskMarkdownExportResponse


def export_task_markdown(
    repository: SqliteTaskRepository,
    current_settings: ServiceSettings,
    task_id: str,
    *,
    target: Literal["markdown", "obsidian"] = "obsidian",
) -> TaskMarkdownExportResponse:
    normalized_target = str(target or "obsidian").strip().lower()
    if normalized_target not in {"markdown", "obsidian"}:
        raise HTTPException(status_code=400, detail="仅支持导出 markdown 或 obsidian 格式。")

    record = repository.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    if record.status != TaskStatus.COMPLETED or record.result is None:
        raise HTTPException(status_code=400, detail="仅已完成且有结果的任务可以导出 Markdown。")

    result = record.result
    if not result.knowledge_note_markdown.strip():
        raise HTTPException(status_code=400, detail="当前任务缺少知识笔记，暂时无法导出 Markdown。")

    output_dir_raw = str(current_settings.output_dir or "").strip()
    if not output_dir_raw:
        raise HTTPException(status_code=400, detail="请先在设置中配置输出目录，再导出 Markdown / Obsidian 笔记。")

    export_directory = Path(output_dir_raw).expanduser()
    export_directory.mkdir(parents=True, exist_ok=True)

    video = repository.get_video_asset(record.video_id) if record.video_id else None
    export_time = datetime.now().astimezone()
    title = (
        str(record.task_input.title or "").strip()
        or str(video.title if video else "").strip()
        or "BriefVid 知识笔记"
    )
    preferred_file_name = build_export_filename(title, export_time)
    platform = str(video.platform if video else record.task_input.platform_hint or "").strip().lower() or "unknown"
    tags = ["briefvid", platform, "video-summary"]
    markdown = build_task_markdown_export(
        title=title,
        overview=result.overview,
        knowledge_note_markdown=result.knowledge_note_markdown,
        key_points=result.key_points,
        timeline=result.timeline,
        source_url=str(video.source_url if video else record.task_input.source or ""),
        platform=platform,
        video_id=record.video_id,
        canonical_id=str(video.canonical_id) if video else None,
        task_id=record.task_id,
        created_at=record.created_at,
        exported_at=export_time,
        tags=tags,
        target=normalized_target,
        mindmap_path=result.mindmap_artifact_path or result.artifacts.get("mindmap_path"),
    )
    export_path, had_name_conflict = _write_markdown_export(export_directory, preferred_file_name, markdown)

    artifact_key = "obsidian_note_path" if normalized_target == "obsidian" else "markdown_note_path"
    refreshed_result = result.model_copy(
        update={
            "artifacts": {
                **result.artifacts,
                artifact_key: str(export_path),
            }
        }
    )
    repository.save_result(task_id, refreshed_result)
    return TaskMarkdownExportResponse(
        task_id=task_id,
        target_format=normalized_target,
        path=str(export_path),
        directory=str(export_directory),
        file_name=export_path.name,
        overwritten=had_name_conflict,
        artifact_key=artifact_key,
    )


def _write_markdown_export(directory: Path, file_name: str, content: str) -> tuple[Path, bool]:
    base_candidate = directory / file_name
    suffix = base_candidate.suffix or ".md"
    stem = base_candidate.stem
    counter = 1
    while True:
        candidate = base_candidate if counter == 1 else directory / f"{stem} ({counter}){suffix}"
        try:
            with candidate.open("x", encoding="utf-8") as handle:
                handle.write(content)
        except FileExistsError:
            counter += 1
            continue
        return candidate, counter > 1
