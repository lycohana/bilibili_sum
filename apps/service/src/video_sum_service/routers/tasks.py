import asyncio
import json

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from video_sum_core.models.tasks import InputType, TaskStatus
from video_sum_core.utils import normalize_video_url

from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import (
    TaskCreateRequest,
    TaskDetailResponse,
    TaskEventResponse,
    TaskMindMapResponse,
    TaskProgressResponse,
    TaskSummaryResponse,
)
from video_sum_service.context import settings_manager
from video_sum_service.task_artifacts import cleanup_task_files, load_task_mindmap
from video_sum_service.video_assets import probe_video_asset
from video_sum_service.worker import TaskWorker

router = APIRouter(prefix="/api/v1/tasks")


@router.post("", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_task(body: TaskCreateRequest, request: Request) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    task_worker: TaskWorker = request.app.state.task_worker

    video_id = body.video_id
    if video_id is None and body.input_type is InputType.URL:
        probed, _, _ = probe_video_asset(body.source)
        asset = task_store.upsert_video_asset(probed)
        video_id = asset.video_id

    normalized = normalize_video_url(body.source) if body.input_type is InputType.URL else None
    page_number = normalized.page_number if normalized and normalized.platform == "bilibili" else None

    record = task_store.create_task(
        body,
        video_id=video_id,
        page_number=page_number,
        page_title=body.title,
    )
    task_worker.submit(record)
    refreshed = task_store.get_task(record.task_id)
    assert refreshed is not None
    return refreshed.to_detail()


@router.get("", response_model=list[TaskSummaryResponse])
def list_tasks(request: Request) -> list[TaskSummaryResponse]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    return [record.to_summary() for record in task_store.list_tasks()]


@router.get("/{task_id}", response_model=TaskDetailResponse)
def get_task(task_id: str, request: Request) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return record.to_detail()


@router.delete("/{task_id}")
def delete_task(task_id: str, request: Request) -> dict[str, object]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    # 先清理文件，再删除数据库记录：如果文件清理失败，数据库记录仍保留以便重试
    cleanup_task_files(record, settings_manager.current)
    deleted = task_store.delete_task(task_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"deleted": True, "task_id": task_id}


@router.get("/{task_id}/result", response_model=TaskDetailResponse)
def get_task_result(task_id: str, request: Request) -> TaskDetailResponse:
    return get_task(task_id, request)


@router.get("/{task_id}/mindmap", response_model=TaskMindMapResponse)
def get_task_mindmap(task_id: str, request: Request) -> TaskMindMapResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")

    result = record.result
    if result is None:
        return TaskMindMapResponse(task_id=task_id, status="idle")

    mindmap_path = result.mindmap_artifact_path or result.artifacts.get("mindmap_path")
    mindmap = None
    status_value = result.mindmap_status or ("ready" if mindmap_path else "idle")
    error_message = result.mindmap_error_message
    if status_value == "generating":
        return TaskMindMapResponse(
            task_id=task_id,
            status="generating",
            error_message=error_message,
            updated_at=result.mindmap_updated_at,
            mindmap=None,
        )
    if status_value == "failed":
        return TaskMindMapResponse(
            task_id=task_id,
            status="failed",
            error_message=error_message,
            updated_at=result.mindmap_updated_at,
            mindmap=None,
        )
    if mindmap_path:
        try:
            mindmap = load_task_mindmap(mindmap_path)
        except HTTPException:
            status_value = "failed"
            error_message = "思维导图文件缺失或已损坏，请重新生成。"
    if mindmap is not None:
        status_value = "ready"

    return TaskMindMapResponse(
        task_id=task_id,
        status=status_value,
        error_message=error_message,
        updated_at=result.mindmap_updated_at,
        mindmap=mindmap,
    )


@router.post("/{task_id}/mindmap", response_model=TaskMindMapResponse)
def generate_task_mindmap(request: Request, task_id: str, force: bool = False) -> TaskMindMapResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    task_worker: TaskWorker = request.app.state.task_worker
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    if record.status != TaskStatus.COMPLETED or record.result is None:
        raise HTTPException(status_code=400, detail="仅已完成且有结果的任务可以生成思维导图。")
    if not record.result.knowledge_note_markdown.strip():
        raise HTTPException(status_code=400, detail="当前任务缺少知识笔记，暂时无法生成思维导图。")
    if not record.result.artifacts.get("summary_path"):
        raise HTTPException(status_code=400, detail="当前任务缺少摘要文件，暂时无法生成思维导图。")

    existing_path = record.result.mindmap_artifact_path or record.result.artifacts.get("mindmap_path")
    if record.result.mindmap_status == "generating" and not force:
        return TaskMindMapResponse(
            task_id=task_id,
            status="generating",
            error_message=None,
            updated_at=record.result.mindmap_updated_at,
            mindmap=None,
        )
    if existing_path and record.result.mindmap_status == "ready" and not force:
        try:
            return TaskMindMapResponse(
                task_id=task_id,
                status="ready",
                error_message=None,
                updated_at=record.result.mindmap_updated_at,
                mindmap=load_task_mindmap(existing_path),
            )
        except HTTPException:
            pass

    generating_result = record.result.model_copy(
        update={
            "mindmap_status": "generating",
            "mindmap_error_message": None,
        }
    )
    task_store.save_result(task_id, generating_result)
    task_worker.submit_mindmap(task_id, force=force)
    refreshed = task_store.get_task(task_id)
    refreshed_result = refreshed.result if refreshed is not None else generating_result
    return TaskMindMapResponse(
        task_id=task_id,
        status=refreshed_result.mindmap_status,
        error_message=refreshed_result.mindmap_error_message,
        updated_at=refreshed_result.mindmap_updated_at,
        mindmap=None,
    )


@router.get("/{task_id}/events", response_model=list[TaskEventResponse])
def get_task_events(task_id: str, request: Request) -> list[TaskEventResponse]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return [event.to_response() for event in task_store.list_events(task_id)]


@router.get("/{task_id}/events/stream")
async def stream_task_events(request: Request, task_id: str, after: str | None = None) -> StreamingResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")

    async def event_generator():
        last_seen = after
        idle_ticks = 0
        terminal_statuses = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}

        while True:
            if await request.is_disconnected():
                return

            current_record = task_store.get_task(task_id)
            if current_record is None:
                yield "event: error\ndata: {\"message\":\"Task not found.\"}\n\n"
                return

            events = task_store.list_events_after(task_id, last_seen)
            if events:
                idle_ticks = 0
                for event in events:
                    if await request.is_disconnected():
                        return
                    last_seen = event.created_at.isoformat()
                    payload = {
                        "event": event.to_response().model_dump(mode="json"),
                        "status": current_record.status.value,
                        "updated_at": current_record.updated_at.isoformat(),
                        "result": current_record.result.model_dump(mode="json") if current_record.result is not None else None,
                    }
                    yield f"event: progress\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            else:
                idle_ticks += 1

            current_record = task_store.get_task(task_id)
            if current_record is None or current_record.status in terminal_statuses:
                if idle_ticks >= 2:
                    return

            if idle_ticks >= 20:
                if await request.is_disconnected():
                    return
                yield "event: heartbeat\ndata: {}\n\n"
                idle_ticks = 0

            if await request.is_disconnected():
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/{task_id}/progress", response_model=TaskProgressResponse)
def get_task_progress(task_id: str, request: Request) -> TaskProgressResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    latest_event = task_store.get_latest_event(task_id)
    return TaskProgressResponse(
        task_id=record.task_id,
        status=record.status,
        progress=int(latest_event.progress) if latest_event is not None else 0,
        latest_stage=latest_event.stage if latest_event is not None else None,
        latest_message=latest_event.message if latest_event is not None else None,
        updated_at=record.updated_at,
    )
