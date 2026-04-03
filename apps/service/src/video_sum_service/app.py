from contextlib import asynccontextmanager
import importlib.metadata
from pathlib import Path
import subprocess
import sys

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from video_sum_core.models.tasks import TaskStatus
from video_sum_core.pipeline.real import PipelineSettings, RealPipelineRunner
from video_sum_infra.app import AppInfo
from video_sum_infra.config import ServiceSettings
from video_sum_infra.db import connect_sqlite
from video_sum_service.schemas import (
    TaskCreateRequest,
    TaskDetailResponse,
    TaskEventResponse,
    TaskSummaryResponse,
)
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.settings_manager import SettingsManager, SettingsUpdatePayload
from video_sum_service.worker import TaskWorker

settings_manager = SettingsManager(ServiceSettings())
settings = settings_manager.load()
app_info = AppInfo.load()
WEB_STATIC_DIR = Path(__file__).resolve().parents[3] / "web" / "static"


def build_worker(repository: SqliteTaskRepository, current_settings: ServiceSettings) -> TaskWorker:
    pipeline_settings = PipelineSettings(
        tasks_dir=current_settings.tasks_dir,
        whisper_model=current_settings.whisper_model,
        whisper_device=current_settings.whisper_device,
        whisper_compute_type=current_settings.whisper_compute_type,
        llm_enabled=current_settings.llm_enabled,
        llm_api_key=current_settings.llm_api_key,
        llm_base_url=current_settings.llm_base_url,
        llm_model=current_settings.llm_model,
    )
    return TaskWorker(repository=repository, pipeline_runner=RealPipelineRunner(pipeline_settings))


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
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=3600,
            check=True,
        )
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
    try:
        yield
    finally:
        connection.close()

app = FastAPI(
    title="Video Summarizer Service",
    version=app_info.version,
    description="Local-first backend service for video summarization tasks.",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=WEB_STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": app_info.name,
        "version": app_info.version,
    }


@app.get("/api/v1/system/info")
def system_info() -> dict[str, object]:
    current_settings = settings_manager.current
    return {
        "application": {
            "name": app_info.name,
            "version": app_info.version,
        },
        "service": {
            "host": current_settings.host,
            "port": current_settings.port,
            "data_dir": str(current_settings.data_dir),
            "cache_dir": str(current_settings.cache_dir),
            "tasks_dir": str(current_settings.tasks_dir),
            "database_url": current_settings.database_url,
        },
        "runtime": {
            "whisper_model": current_settings.whisper_model,
            "llm_enabled": current_settings.llm_enabled,
            "llm_model": current_settings.llm_model,
        },
        "taskModel": {
            "statuses": [status.value for status in TaskStatus],
        },
        "environment": detect_environment(),
    }


@app.get("/api/v1/settings")
def get_settings() -> dict[str, object]:
    current_settings = settings_manager.current
    return {
        "host": current_settings.host,
        "port": current_settings.port,
        "data_dir": str(current_settings.data_dir),
        "cache_dir": str(current_settings.cache_dir),
        "tasks_dir": str(current_settings.tasks_dir),
        "database_url": current_settings.database_url,
        "whisper_model": current_settings.whisper_model,
        "whisper_device": current_settings.whisper_device,
        "whisper_compute_type": current_settings.whisper_compute_type,
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
    }


@app.put("/api/v1/settings")
def update_settings(payload: SettingsUpdatePayload) -> dict[str, object]:
    current_settings = settings_manager.save(payload)
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
            "whisper_model": current_settings.whisper_model,
            "whisper_device": current_settings.whisper_device,
            "whisper_compute_type": current_settings.whisper_compute_type,
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
        },
        "message": "设置已保存。涉及服务监听地址的修改将在下次启动后生效。",
    }


@app.get("/api/v1/environment")
def get_environment() -> dict[str, object]:
    return detect_environment()


@app.post("/api/v1/cuda/install")
def post_cuda_install(payload: dict[str, object]) -> dict[str, object]:
    return install_cuda_support(str(payload.get("cudaVariant", "cu128")))


@app.post("/api/v1/tasks", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_task(request: TaskCreateRequest) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    task_worker: TaskWorker = app.state.task_worker
    record = task_store.create_task(request)
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    return record.to_detail()


@app.get("/api/v1/tasks/{task_id}/result", response_model=TaskDetailResponse)
def get_task_result(task_id: str) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    return record.to_detail()


@app.get("/api/v1/tasks/{task_id}/events", response_model=list[TaskEventResponse])
def get_task_events(task_id: str) -> list[TaskEventResponse]:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    return [event.to_response() for event in task_store.list_events(task_id)]
