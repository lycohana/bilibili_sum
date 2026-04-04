import asyncio
from contextlib import asynccontextmanager
import importlib.metadata
import json
import logging
from pathlib import Path
import subprocess
import sys

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import httpx
from yt_dlp import YoutubeDL

from video_sum_core.models.tasks import InputType, TaskInput, TaskStatus
from video_sum_core.pipeline.real import PipelineSettings, RealPipelineRunner
from video_sum_core.utils import normalize_video_url
from video_sum_infra.app import AppInfo
from video_sum_infra.config import ServiceSettings
from video_sum_infra.db import connect_sqlite
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import (
    TaskCreateRequest,
    TaskDetailResponse,
    TaskEventResponse,
    TaskProgressResponse,
    TaskSummaryResponse,
    VideoAssetDetailResponse,
    VideoAssetRecord,
    VideoAssetSummaryResponse,
    VideoProbeRequest,
    VideoProbeResponse,
)
from video_sum_service.settings_manager import SettingsManager, SettingsUpdatePayload
from video_sum_service.worker import TaskWorker

logger = logging.getLogger("video_sum_service.app")

settings_manager = SettingsManager(ServiceSettings())
settings = settings_manager.load()
app_info = AppInfo.load()
WEB_STATIC_DIR = Path(__file__).resolve().parents[3] / "web" / "static"
CACHE_STATIC_DIR = settings.cache_dir
COVER_CACHE_DIR = CACHE_STATIC_DIR / "covers"


def detect_environment() -> dict[str, object]:
    try:
        import torch
    except ImportError:
        torch = None

    cuda_available = bool(torch is not None and torch.cuda.is_available())
    gpu_name = torch.cuda.get_device_name(0) if cuda_available else ""
    torch_version = torch.__version__ if torch is not None else ""

    try:
        yt_dlp_version = importlib.metadata.version("yt-dlp")
    except importlib.metadata.PackageNotFoundError:
        yt_dlp_version = ""

    try:
        faster_whisper_version = importlib.metadata.version("faster-whisper")
    except importlib.metadata.PackageNotFoundError:
        faster_whisper_version = ""

    return {
        "pythonVersion": sys.version.split()[0],
        "torchInstalled": torch is not None,
        "torchVersion": torch_version,
        "cudaAvailable": cuda_available,
        "gpuName": gpu_name,
        "ytDlpVersion": yt_dlp_version,
        "fasterWhisperVersion": faster_whisper_version,
        "recommendedModel": "large-v3-turbo" if cuda_available else "base",
        "recommendedDevice": "cuda" if cuda_available else "cpu",
    }


def build_worker(repository: SqliteTaskRepository, current_settings: ServiceSettings) -> TaskWorker:
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment().get("cudaAvailable"))
    )
    logger.info(
        "build worker whisper_model=%s whisper_device=%s whisper_compute_type=%s llm_enabled=%s llm_model=%s",
        runtime_settings.whisper_model,
        runtime_settings.whisper_device,
        runtime_settings.whisper_compute_type,
        runtime_settings.llm_enabled,
        runtime_settings.llm_model,
    )
    pipeline_settings = PipelineSettings(
        tasks_dir=runtime_settings.tasks_dir,
        whisper_model=runtime_settings.whisper_model,
        whisper_device=runtime_settings.whisper_device,
        whisper_compute_type=runtime_settings.whisper_compute_type,
        llm_enabled=runtime_settings.llm_enabled,
        llm_api_key=runtime_settings.llm_api_key,
        llm_base_url=runtime_settings.llm_base_url,
        llm_model=runtime_settings.llm_model,
        summary_system_prompt=runtime_settings.summary_system_prompt,
        summary_user_prompt_template=runtime_settings.summary_user_prompt_template,
        summary_chunk_target_chars=runtime_settings.summary_chunk_target_chars,
        summary_chunk_overlap_segments=runtime_settings.summary_chunk_overlap_segments,
        summary_chunk_concurrency=runtime_settings.summary_chunk_concurrency,
        summary_chunk_retry_count=runtime_settings.summary_chunk_retry_count,
    )
    return TaskWorker(repository=repository, pipeline_runner=RealPipelineRunner(pipeline_settings))


def cache_cover_image(source_url: str, canonical_id: str, referer_url: str | None = None) -> str:
    if not source_url:
        return ""
    normalized_source = source_url.replace("http://", "https://")
    COVER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = COVER_CACHE_DIR / f"{canonical_id}.jpg"
    if target.exists():
        return f"/media/covers/{target.name}"
    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
            ),
            "Referer": referer_url or "https://www.bilibili.com/",
        }
        with httpx.Client(timeout=30, follow_redirects=True, headers=headers) as client:
            response = client.get(normalized_source)
            response.raise_for_status()
        target.write_bytes(response.content)
        return f"/media/covers/{target.name}"
    except Exception:
        return normalized_source


def probe_video_asset(url: str, force_refresh: bool = False) -> VideoAssetRecord:
    normalized_url, canonical_id = normalize_video_url(url)
    with YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
        info = ydl.extract_info(normalized_url, download=False)
    if not isinstance(info, dict):
        raise HTTPException(status_code=400, detail="无法读取视频信息。")
    title = str(info.get("title") or canonical_id or normalized_url)
    thumbnail = str(info.get("thumbnail") or "")
    duration = float(info.get("duration")) if info.get("duration") else None
    platform = str(info.get("extractor_key") or "video").lower()
    actual_id = str(info.get("id") or canonical_id or normalized_url)
    cached_cover_url = cache_cover_image(thumbnail, actual_id, referer_url=normalized_url)
    return VideoAssetRecord(
        canonical_id=actual_id,
        platform=platform,
        title=title,
        source_url=normalized_url,
        cover_url=cached_cover_url,
        duration=duration,
    )


def localize_video_cover(task_store: SqliteTaskRepository, video: VideoAssetRecord) -> VideoAssetRecord:
    if not video.cover_url or video.cover_url.startswith("/media/"):
        return video
    localized = cache_cover_image(video.cover_url, video.canonical_id, referer_url=video.source_url)
    if localized == video.cover_url:
        return video
    updated = video.model_copy(update={"cover_url": localized})
    return task_store.upsert_video_asset(updated)


def install_cuda_support(cuda_variant: str) -> dict[str, object]:
    allowed_variants = {"cu124", "cu126", "cu128"}
    if cuda_variant not in allowed_variants:
        raise HTTPException(status_code=400, detail="Unsupported CUDA variant.")

    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "torch",
        "torchvision",
        "torchaudio",
        "--index-url",
        f"https://download.pytorch.org/whl/{cuda_variant}",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=3600, check=True)
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=(exc.stderr or exc.stdout or str(exc))[:1200]) from exc

    return {
        "cudaVariant": cuda_variant,
        "stdout": (result.stdout or "")[-1500:],
        "environment": detect_environment(),
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    current_settings = settings_manager.current
    connection = connect_sqlite(current_settings.database_url)
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    worker = build_worker(repository=repository, current_settings=current_settings)
    _app.state.task_repository = repository
    _app.state.task_worker = worker
    _app.state.db_connection = connection
    _app.state.settings_manager = settings_manager
    logger.info("application startup complete database=%s", current_settings.database_url)
    try:
        yield
    finally:
        logger.info("application shutdown")
        connection.close()


app = FastAPI(
    title="Video Summarizer Service",
    version=app_info.version,
    description="Local-first backend service for video summarization tasks.",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=WEB_STATIC_DIR), name="static")
app.mount("/media", StaticFiles(directory=CACHE_STATIC_DIR), name="media")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_STATIC_DIR / "index.html")


@app.get("/videos/{video_id}", include_in_schema=False)
def video_detail_page(video_id: str) -> FileResponse:
    return FileResponse(WEB_STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": app_info.name, "version": app_info.version}


@app.get("/api/v1/system/info")
def system_info() -> dict[str, object]:
    current_settings = settings_manager.current
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment().get("cudaAvailable"))
    )
    return {
        "application": {"name": app_info.name, "version": app_info.version},
        "service": {
            "host": current_settings.host,
            "port": current_settings.port,
            "data_dir": str(current_settings.data_dir),
            "cache_dir": str(current_settings.cache_dir),
            "tasks_dir": str(current_settings.tasks_dir),
            "database_url": current_settings.database_url,
        },
        "runtime": {
            "whisper_model": runtime_settings.whisper_model,
            "whisper_device": runtime_settings.whisper_device,
            "whisper_compute_type": runtime_settings.whisper_compute_type,
            "llm_enabled": current_settings.llm_enabled,
            "llm_model": current_settings.llm_model,
        },
        "taskModel": {"statuses": [status.value for status in TaskStatus]},
        "environment": detect_environment(),
    }


@app.get("/api/v1/settings")
def get_settings() -> dict[str, object]:
    current_settings = settings_manager.current
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment().get("cudaAvailable"))
    )
    return {
        "host": current_settings.host,
        "port": current_settings.port,
        "data_dir": str(current_settings.data_dir),
        "cache_dir": str(current_settings.cache_dir),
        "tasks_dir": str(current_settings.tasks_dir),
        "database_url": current_settings.database_url,
        "whisper_model": runtime_settings.whisper_model,
        "whisper_device": runtime_settings.whisper_device,
        "whisper_compute_type": runtime_settings.whisper_compute_type,
        "device_preference": current_settings.device_preference,
        "compute_type": current_settings.compute_type,
        "model_mode": current_settings.model_mode,
        "fixed_model": current_settings.fixed_model,
        "cuda_variant": current_settings.cuda_variant,
        "output_dir": current_settings.output_dir,
        "preserve_temp_audio": current_settings.preserve_temp_audio,
        "enable_cache": current_settings.enable_cache,
        "language": current_settings.language,
        "summary_mode": current_settings.summary_mode,
        "llm_enabled": current_settings.llm_enabled,
        "llm_provider": current_settings.llm_provider,
        "llm_base_url": current_settings.llm_base_url,
        "llm_model": current_settings.llm_model,
        "llm_api_key": current_settings.llm_api_key,
        "llm_api_key_configured": bool(current_settings.llm_api_key),
        "summary_system_prompt": current_settings.summary_system_prompt,
        "summary_user_prompt_template": current_settings.summary_user_prompt_template,
        "summary_chunk_target_chars": current_settings.summary_chunk_target_chars,
        "summary_chunk_overlap_segments": current_settings.summary_chunk_overlap_segments,
        "summary_chunk_concurrency": current_settings.summary_chunk_concurrency,
        "summary_chunk_retry_count": current_settings.summary_chunk_retry_count,
    }


@app.put("/api/v1/settings")
def update_settings(payload: SettingsUpdatePayload) -> dict[str, object]:
    current_settings = settings_manager.save(payload)
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment().get("cudaAvailable"))
    )
    current_settings.data_dir.mkdir(parents=True, exist_ok=True)
    current_settings.cache_dir.mkdir(parents=True, exist_ok=True)
    current_settings.tasks_dir.mkdir(parents=True, exist_ok=True)
    app.state.task_worker = build_worker(app.state.task_repository, current_settings)
    return {
        "saved": True,
        "settings": {
            "host": current_settings.host,
            "port": current_settings.port,
            "data_dir": str(current_settings.data_dir),
            "cache_dir": str(current_settings.cache_dir),
            "tasks_dir": str(current_settings.tasks_dir),
            "database_url": current_settings.database_url,
            "whisper_model": runtime_settings.whisper_model,
            "whisper_device": runtime_settings.whisper_device,
            "whisper_compute_type": runtime_settings.whisper_compute_type,
            "device_preference": current_settings.device_preference,
            "compute_type": current_settings.compute_type,
            "model_mode": current_settings.model_mode,
            "fixed_model": current_settings.fixed_model,
            "cuda_variant": current_settings.cuda_variant,
            "output_dir": current_settings.output_dir,
            "preserve_temp_audio": current_settings.preserve_temp_audio,
            "enable_cache": current_settings.enable_cache,
            "language": current_settings.language,
            "summary_mode": current_settings.summary_mode,
            "llm_enabled": current_settings.llm_enabled,
            "llm_provider": current_settings.llm_provider,
            "llm_base_url": current_settings.llm_base_url,
            "llm_model": current_settings.llm_model,
            "llm_api_key": current_settings.llm_api_key,
            "llm_api_key_configured": bool(current_settings.llm_api_key),
            "summary_system_prompt": current_settings.summary_system_prompt,
            "summary_user_prompt_template": current_settings.summary_user_prompt_template,
            "summary_chunk_target_chars": current_settings.summary_chunk_target_chars,
            "summary_chunk_overlap_segments": current_settings.summary_chunk_overlap_segments,
            "summary_chunk_concurrency": current_settings.summary_chunk_concurrency,
            "summary_chunk_retry_count": current_settings.summary_chunk_retry_count,
        },
        "message": "设置已保存。涉及服务监听地址的修改将在下次启动后生效。",
    }


@app.get("/api/v1/environment")
def get_environment() -> dict[str, object]:
    return detect_environment()


@app.post("/api/v1/cuda/install")
def post_cuda_install(payload: dict[str, object]) -> dict[str, object]:
    return install_cuda_support(str(payload.get("cudaVariant", "cu128")))


@app.post("/api/v1/videos/probe", response_model=VideoProbeResponse)
def probe_video(request: VideoProbeRequest) -> VideoProbeResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    logger.info("probe video url=%s force_refresh=%s", request.url, request.force_refresh)
    probed = probe_video_asset(request.url, request.force_refresh)
    existing = task_store.get_video_asset_by_canonical_id(probed.canonical_id)
    cached = existing is not None and not request.force_refresh
    asset = existing if cached else task_store.upsert_video_asset(probed)
    asset = localize_video_cover(task_store, asset)
    return VideoProbeResponse(video=asset.to_summary(), cached=cached)


@app.get("/api/v1/videos", response_model=list[VideoAssetSummaryResponse])
def list_videos() -> list[VideoAssetSummaryResponse]:
    task_store: SqliteTaskRepository = app.state.task_repository
    return [localize_video_cover(task_store, video).to_summary() for video in task_store.list_video_assets()]


@app.get("/api/v1/videos/{video_id}", response_model=VideoAssetDetailResponse)
def get_video(video_id: str) -> VideoAssetDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    return localize_video_cover(task_store, video).to_detail()


@app.delete("/api/v1/videos/{video_id}")
def delete_video(video_id: str) -> dict[str, object]:
    task_store: SqliteTaskRepository = app.state.task_repository
    deleted = task_store.delete_video_asset(video_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Video not found.")
    logger.info("delete video video_id=%s", video_id)
    return {"deleted": True, "video_id": video_id}


@app.get("/api/v1/videos/{video_id}/tasks", response_model=list[TaskSummaryResponse])
def get_video_tasks(video_id: str) -> list[TaskSummaryResponse]:
    task_store: SqliteTaskRepository = app.state.task_repository
    return [task.to_summary() for task in task_store.list_tasks_for_video(video_id)]


@app.post("/api/v1/videos/{video_id}/tasks", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_video_task(video_id: str) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    task_worker: TaskWorker = app.state.task_worker
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    logger.info("create video task video_id=%s title=%s source=%s", video.video_id, video.title, video.source_url)
    record = task_store.create_task(
        TaskInput(input_type=InputType.URL, source=video.source_url, title=video.title),
        video_id=video.video_id,
    )
    task_worker.submit(record)
    refreshed = task_store.get_task(record.task_id)
    assert refreshed is not None
    return refreshed.to_detail()


@app.post("/api/v1/tasks", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_task(request: TaskCreateRequest) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    task_worker: TaskWorker = app.state.task_worker
    logger.info(
        "create task input_type=%s source=%s title=%s video_id=%s",
        request.input_type.value,
        request.source,
        request.title,
        request.video_id,
    )

    video_id = request.video_id
    if video_id is None and request.input_type is InputType.URL:
        probed = probe_video_asset(request.source)
        asset = task_store.upsert_video_asset(probed)
        video_id = asset.video_id

    record = task_store.create_task(
        TaskInput(
            input_type=request.input_type,
            source=request.source,
            title=request.title,
            platform_hint=request.platform_hint,
            options=request.options,
        ),
        video_id=video_id,
    )
    task_worker.submit(record)
    refreshed = task_store.get_task(record.task_id)
    assert refreshed is not None
    return refreshed.to_detail()


@app.get("/api/v1/tasks", response_model=list[TaskSummaryResponse])
def list_tasks() -> list[TaskSummaryResponse]:
    task_store: SqliteTaskRepository = app.state.task_repository
    return [record.to_summary() for record in task_store.list_tasks()]


@app.get("/api/v1/tasks/{task_id}", response_model=TaskDetailResponse)
def get_task(task_id: str) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return record.to_detail()


@app.delete("/api/v1/tasks/{task_id}")
def delete_task(task_id: str) -> dict[str, object]:
    task_store: SqliteTaskRepository = app.state.task_repository
    deleted = task_store.delete_task(task_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found.")
    logger.info("delete task task_id=%s", task_id)
    return {"deleted": True, "task_id": task_id}


@app.get("/api/v1/tasks/{task_id}/result", response_model=TaskDetailResponse)
def get_task_result(task_id: str) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return record.to_detail()


@app.get("/api/v1/tasks/{task_id}/events", response_model=list[TaskEventResponse])
def get_task_events(task_id: str) -> list[TaskEventResponse]:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return [event.to_response() for event in task_store.list_events(task_id)]


@app.get("/api/v1/tasks/{task_id}/events/stream")
async def stream_task_events(task_id: str, after: str | None = None) -> StreamingResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")

    async def event_generator():
        last_seen = after
        idle_ticks = 0
        terminal_statuses = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}

        while True:
            current_record = task_store.get_task(task_id)
            if current_record is None:
                yield "event: error\ndata: {\"message\":\"Task not found.\"}\n\n"
                return

            events = task_store.list_events_after(task_id, last_seen)
            if events:
                idle_ticks = 0
                for event in events:
                    last_seen = event.created_at.isoformat()
                    payload = {
                        "event": event.to_response().model_dump(mode="json"),
                        "status": current_record.status.value,
                        "updated_at": current_record.updated_at.isoformat(),
                    }
                    yield f"event: progress\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            else:
                idle_ticks += 1

            current_record = task_store.get_task(task_id)
            if current_record is None or current_record.status in terminal_statuses:
                if idle_ticks >= 2:
                    return

            if idle_ticks >= 20:
                yield "event: heartbeat\ndata: {}\n\n"
                idle_ticks = 0

            await asyncio.sleep(0.4)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/v1/tasks/{task_id}/progress", response_model=TaskProgressResponse)
def get_task_progress(task_id: str) -> TaskProgressResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
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
