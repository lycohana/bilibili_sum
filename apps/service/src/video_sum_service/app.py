import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import textwrap
import threading
import venv

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
from video_sum_infra.runtime import (
    bootstrap_managed_runtime,
    ffmpeg_location,
    is_frozen,
    log_dir,
    managed_runtime_dir,
    prepend_runtime_path,
    read_runtime_metadata,
    repo_root,
    runtime_library_dirs,
    runtime_python_candidates,
    runtime_python_executable,
    runtime_scripts_dir,
    sanitized_subprocess_dll_search,
    service_log_path,
    web_static_dir,
    write_runtime_metadata,
)
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import (
    ResummaryRequest,
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
WEB_STATIC_DIR = web_static_dir()
CACHE_STATIC_DIR = settings.cache_dir
COVER_CACHE_DIR = CACHE_STATIC_DIR / "covers"
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.cache_dir.mkdir(parents=True, exist_ok=True)
settings.tasks_dir.mkdir(parents=True, exist_ok=True)
log_dir().mkdir(parents=True, exist_ok=True)
_environment_probe_cache: dict[str, dict[str, object]] = {}
_environment_probe_failures: dict[str, str] = {}
MAX_LOG_CHARS = 20_000
MAX_LOG_LINE_CHARS = 1_000


def _windows_hidden_subprocess_kwargs() -> dict[str, object]:
    if os.name != "nt":
        return {}

    kwargs: dict[str, object] = {}
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if creationflags:
        kwargs["creationflags"] = creationflags

    startupinfo_cls = getattr(subprocess, "STARTUPINFO", None)
    use_show_window = getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
    sw_hide = getattr(subprocess, "SW_HIDE", 0)
    if startupinfo_cls is not None:
        startupinfo = startupinfo_cls()
        startupinfo.dwFlags |= use_show_window
        startupinfo.wShowWindow = sw_hide
        kwargs["startupinfo"] = startupinfo

    return kwargs


def _trim_log_text(content: str, *, max_chars: int = MAX_LOG_CHARS, max_line_chars: int = MAX_LOG_LINE_CHARS) -> str:
    lines = content.splitlines()
    trimmed_lines = [
        f"{line[:max_line_chars]}... [line truncated]"
        if len(line) > max_line_chars
        else line
        for line in lines
    ]
    trimmed = "\n".join(trimmed_lines)
    if len(trimmed) <= max_chars:
        return trimmed
    return f"... [log truncated, showing last {max_chars} chars]\n{trimmed[-max_chars:]}"


def read_log_tail(max_lines: int = 200) -> str:
    log_path = service_log_path()
    if not log_path.exists():
        return ""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return _trim_log_text("\n".join(lines[-max(1, max_lines) :]))


def _runtime_subprocess_env(runtime_channel: str) -> dict[str, str]:
    env = dict(os.environ)
    for key in (
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONEXECUTABLE",
        "__PYVENV_LAUNCHER__",
    ):
        env.pop(key, None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    path_entries = [str(path) for path in runtime_library_dirs(runtime_channel)]
    ffmpeg_dir = ffmpeg_location()
    if ffmpeg_dir is not None:
        path_entries.append(str(ffmpeg_dir))

    current_path = env.get("PATH", "")
    inherited_entries: list[str] = []
    blocked_prefixes: list[Path] = []
    if is_frozen():
        blocked_prefixes.append(Path(sys.executable).resolve().parent)
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            blocked_prefixes.append(Path(meipass).resolve())

    for raw_entry in current_path.split(os.pathsep):
        entry = raw_entry.strip()
        if not entry:
            continue
        try:
            entry_path = Path(entry).resolve()
        except OSError:
            inherited_entries.append(entry)
            continue
        if any(str(entry_path).lower().startswith(str(prefix).lower()) for prefix in blocked_prefixes):
            continue
        inherited_entries.append(entry)

    merged: list[str] = []
    for entry in [*path_entries, *inherited_entries]:
        if entry and entry not in merged:
            merged.append(entry)
    env["PATH"] = os.pathsep.join(merged)
    return env


def _run_command(command: list[str], runtime_channel: str, timeout: int = 3600) -> subprocess.CompletedProcess[str]:
    with sanitized_subprocess_dll_search():
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=True,
            env=_runtime_subprocess_env(runtime_channel),
            cwd=managed_runtime_dir(runtime_channel),
            **_windows_hidden_subprocess_kwargs(),
        )


def _ensure_runtime_pip(python_executable: Path, runtime_channel: str) -> None:
    check_command = [str(python_executable), "-m", "pip", "--version"]
    try:
        _run_command(check_command, runtime_channel=runtime_channel, timeout=120)
        return
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        if "No module named pip" not in detail:
            raise

    bootstrap_command = [str(python_executable), "-m", "ensurepip", "--upgrade"]
    _run_command(bootstrap_command, runtime_channel=runtime_channel, timeout=300)


def _install_workspace_packages(python_executable: Path, runtime_channel: str) -> None:
    if is_frozen():
        # Frozen builds already bundle video_sum_* packages inside the portable seed runtime.
        # Re-installing from source paths only works in a source checkout and breaks in production.
        return

    _ensure_runtime_pip(python_executable, runtime_channel)
    root = repo_root()
    command = [
        str(python_executable),
        "-m",
        "pip",
        "install",
        "--upgrade",
        "pip",
        "setuptools",
        "wheel",
        str(root / "packages" / "infra"),
        str(root / "packages" / "core"),
        str(root / "apps" / "service"),
    ]
    _run_command(command, runtime_channel=runtime_channel, timeout=1800)


def _create_source_runtime(runtime_channel: str) -> Path:
    runtime_dir = managed_runtime_dir(runtime_channel)
    builder = venv.EnvBuilder(with_pip=True, clear=True)
    builder.create(runtime_dir)
    python_executable = None
    for candidate in runtime_python_candidates(runtime_dir):
        if candidate.exists():
            python_executable = candidate
            break
    if python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime creation failed: python.exe missing.")
    _install_workspace_packages(python_executable, runtime_channel=runtime_channel)
    return runtime_dir


def ensure_runtime_channel(runtime_channel: str) -> Path | None:
    if runtime_channel == "base":
        bootstrap_managed_runtime("base")
        python_executable = runtime_python_executable("base")
        if python_executable is not None:
            return managed_runtime_dir("base")
        if not is_frozen():
            return _create_source_runtime("base")
        raise HTTPException(status_code=500, detail="Bundled base runtime is missing.")

    target_dir = managed_runtime_dir(runtime_channel)
    base_dir = ensure_runtime_channel("base")
    if base_dir is None or not base_dir.exists():
        raise HTTPException(status_code=500, detail="Base runtime is unavailable.")

    base_metadata = read_runtime_metadata(base_dir)
    target_metadata = read_runtime_metadata(target_dir)
    target_ready = runtime_python_executable(runtime_channel) is not None
    target_matches_base = (
        target_metadata.get("appVersion") == base_metadata.get("appVersion")
        and target_metadata.get("runtimeLayout") == base_metadata.get("runtimeLayout")
    )
    if target_ready and target_matches_base:
        return target_dir

    if target_dir.exists():
        shutil.rmtree(target_dir)

    shutil.copytree(base_dir, target_dir, dirs_exist_ok=True)
    return target_dir


def detect_environment(runtime_channel: str | None = None) -> dict[str, object]:
    active_channel = runtime_channel or settings_manager.current.runtime_channel
    cached = _environment_probe_cache.get(active_channel)
    if cached is not None:
        return dict(cached)

    python_executable = runtime_python_executable(active_channel)
    if python_executable is None:
        if active_channel == "base" and not is_frozen():
            python_executable = Path(sys.executable).resolve()
        else:
            payload = {
                "pythonVersion": "",
                "torchInstalled": False,
                "torchVersion": "",
                "cudaAvailable": False,
                "gpuName": "",
                "ytDlpVersion": "",
                "fasterWhisperVersion": "",
                "ffmpegLocation": "",
                "recommendedModel": "base",
                "recommendedDevice": "cpu",
                "runtimeChannel": active_channel,
                "runtimeReady": False,
                "runtimePython": "",
            }
            _environment_probe_cache[active_channel] = dict(payload)
            return payload

    script = textwrap.dedent(
        """
        import importlib.metadata
        import json
        import sys
        try:
            import torch
        except ImportError:
            torch = None

        cuda_available = bool(torch is not None and torch.cuda.is_available())
        gpu_name = torch.cuda.get_device_name(0) if cuda_available else ""
        payload = {
            "pythonVersion": sys.version.split()[0],
            "torchInstalled": torch is not None,
            "torchVersion": torch.__version__ if torch is not None else "",
            "cudaAvailable": cuda_available,
            "gpuName": gpu_name,
            "ytDlpVersion": importlib.metadata.version("yt-dlp"),
            "fasterWhisperVersion": importlib.metadata.version("faster-whisper"),
            "ffmpegLocation": "",
            "recommendedModel": "large-v3-turbo" if cuda_available else "base",
            "recommendedDevice": "cuda" if cuda_available else "cpu",
        }
        print(json.dumps(payload, ensure_ascii=False))
        """
    ).strip()

    try:
        result = _run_command([str(python_executable), "-c", script], runtime_channel=active_channel, timeout=120)
        payload = json.loads(result.stdout.strip() or "{}")
        # 在主进程中获取 ffmpeg 位置（因为子进程可能没有正确的 PATH）
        payload["ffmpegLocation"] = str(ffmpeg_location() or "")
        _environment_probe_failures.pop(active_channel, None)
    except Exception as exc:
        failure_detail = ""
        if isinstance(exc, subprocess.CalledProcessError):
            failure_detail = (exc.stderr or exc.stdout or str(exc)).strip()
        else:
            failure_detail = str(exc)
        if _environment_probe_failures.get(active_channel) != failure_detail:
            logger.warning(
                "detect environment failed runtime_channel=%s error=%s detail=%s",
                active_channel,
                exc,
                failure_detail[-1200:],
            )
            _environment_probe_failures[active_channel] = failure_detail
        payload = {
            "pythonVersion": "",
            "torchInstalled": False,
            "torchVersion": "",
            "cudaAvailable": False,
            "gpuName": "",
            "ytDlpVersion": "",
            "fasterWhisperVersion": "",
            "ffmpegLocation": "",
            "recommendedModel": "base",
            "recommendedDevice": "cpu",
            "runtimeError": failure_detail[-1200:],
        }

    payload.update(
        {
            "runtimeChannel": active_channel,
            "runtimeReady": runtime_python_executable(active_channel) is not None,
            "runtimePython": str(python_executable),
            "ffmpegLocation": str(ffmpeg_location() or ""),
        }
    )
    if not payload.get("runtimeError"):
        payload["runtimeError"] = ""
    _environment_probe_cache[active_channel] = dict(payload)
    return payload


def clear_environment_probe_cache(runtime_channel: str | None = None) -> None:
    if runtime_channel is None:
        _environment_probe_cache.clear()
        _environment_probe_failures.clear()
        return
    _environment_probe_cache.pop(runtime_channel, None)
    _environment_probe_failures.pop(runtime_channel, None)


def build_worker(repository: SqliteTaskRepository, current_settings: ServiceSettings) -> TaskWorker:
    selected_runtime_channel = current_settings.runtime_channel
    if selected_runtime_channel != "base" and runtime_python_executable(selected_runtime_channel) is None:
        logger.warning("runtime channel %s is not ready, falling back to base", selected_runtime_channel)
        selected_runtime_channel = "base"

    bootstrap_managed_runtime(selected_runtime_channel)
    prepend_runtime_path(selected_runtime_channel)
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment(selected_runtime_channel).get("cudaAvailable"))
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
        runtime_channel=selected_runtime_channel,
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


def serialize_settings(current_settings: ServiceSettings) -> dict[str, object]:
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment(current_settings.runtime_channel).get("cudaAvailable"))
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
        "runtime_channel": current_settings.runtime_channel,
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


def load_task_segments(summary_path: str) -> list[dict[str, object]]:
    try:
        payload = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="无法读取当前任务的分段结果。") from exc

    segments = payload.get("segments")
    if not isinstance(segments, list) or not segments:
        raise HTTPException(status_code=400, detail="当前任务缺少可复用的分段数据。")
    return segments


def install_cuda_support(cuda_variant: str) -> dict[str, object]:
    allowed_variants = {"cu124", "cu126", "cu128"}
    if cuda_variant not in allowed_variants:
        raise HTTPException(status_code=400, detail="Unsupported CUDA variant.")

    runtime_channel = f"gpu-{cuda_variant}"
    runtime_dir = ensure_runtime_channel(runtime_channel)
    python_executable = runtime_python_executable(runtime_channel)
    if runtime_dir is None or python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime is unavailable.")

    # Keep managed GPU runtimes aligned with the current workspace package set.
    # This prevents older side runtimes from retaining stale console entrypoints.
    try:
        _install_workspace_packages(python_executable, runtime_channel=runtime_channel)
    except subprocess.CalledProcessError as exc:
        clear_environment_probe_cache(runtime_channel)
        raise HTTPException(
            status_code=500,
            detail=((exc.stderr or exc.stdout or str(exc))[-1500:]),
        ) from exc

    command = [
        str(python_executable),
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
        _ensure_runtime_pip(python_executable, runtime_channel)
        result = _run_command(command, runtime_channel=runtime_channel)
    except subprocess.CalledProcessError as exc:
        clear_environment_probe_cache(runtime_channel)
        raise HTTPException(status_code=500, detail=((exc.stderr or exc.stdout or str(exc))[-1500:])) from exc

    current_settings = settings_manager.save(
        SettingsUpdatePayload(cuda_variant=cuda_variant, runtime_channel=runtime_channel)
    )
    clear_environment_probe_cache(runtime_channel)
    clear_environment_probe_cache("base")
    write_runtime_metadata(
        runtime_channel,
        {
            "runtimeChannel": runtime_channel,
            "cudaVariant": cuda_variant,
            "python": str(python_executable),
        },
    )
    environment = detect_environment(runtime_channel)
    app.state.task_worker = build_worker(app.state.task_repository, current_settings)

    return {
        "installed": True,
        "cudaVariant": cuda_variant,
        "runtimeChannel": runtime_channel,
        "restartRequired": True,
        "stdoutTail": (result.stdout or "")[-1500:],
        "environment": environment,
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    current_settings = settings_manager.current
    bootstrap_managed_runtime(current_settings.runtime_channel)
    prepend_runtime_path(current_settings.runtime_channel)
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
    title="BriefVid Service",
    version=app_info.version,
    description="Local-first backend service for BriefVid video summarization tasks.",
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


@app.get("/settings", include_in_schema=False)
@app.get("/settings/{subpath:path}", include_in_schema=False)
def settings_page(subpath: str = "") -> FileResponse:
    return FileResponse(WEB_STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": app_info.name, "version": app_info.version}


@app.get("/api/v1/system/info")
def system_info(runtime_channel: str | None = None, refresh: bool = False) -> dict[str, object]:
    current_settings = settings_manager.current
    active_channel = runtime_channel or current_settings.runtime_channel
    if refresh:
        clear_environment_probe_cache(active_channel)
    environment = detect_environment(active_channel)
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(environment.get("cudaAvailable"))
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
            "log_dir": str(log_dir()),
            "log_file": str(service_log_path()),
        },
        "runtime": {
            "runtime_channel": active_channel,
            "whisper_model": runtime_settings.whisper_model,
            "whisper_device": runtime_settings.whisper_device,
            "whisper_compute_type": runtime_settings.whisper_compute_type,
            "llm_enabled": current_settings.llm_enabled,
            "llm_model": current_settings.llm_model,
        },
        "taskModel": {"statuses": [status.value for status in TaskStatus]},
        "environment": environment,
    }


@app.get("/api/v1/settings")
def get_settings() -> dict[str, object]:
    current_settings = settings_manager.current
    return serialize_settings(current_settings)


@app.put("/api/v1/settings")
def update_settings(payload: SettingsUpdatePayload) -> dict[str, object]:
    current_settings = settings_manager.save(payload)
    clear_environment_probe_cache()
    bootstrap_managed_runtime(current_settings.runtime_channel)
    prepend_runtime_path(current_settings.runtime_channel)
    current_settings.data_dir.mkdir(parents=True, exist_ok=True)
    current_settings.cache_dir.mkdir(parents=True, exist_ok=True)
    current_settings.tasks_dir.mkdir(parents=True, exist_ok=True)
    app.state.task_worker = build_worker(app.state.task_repository, current_settings)
    return {
        "saved": True,
        "settings": serialize_settings(current_settings),
        "message": "设置已保存。涉及服务监听地址的修改将在下次启动后生效。",
    }


@app.get("/api/v1/environment")
def get_environment(runtime_channel: str | None = None, refresh: bool = False) -> dict[str, object]:
    active_channel = runtime_channel or settings_manager.current.runtime_channel
    if refresh:
        clear_environment_probe_cache(active_channel)
    return detect_environment(active_channel)


@app.get("/api/v1/system/logs")
def get_system_logs(lines: int = 200) -> dict[str, object]:
    line_count = max(20, min(int(lines), 1000))
    return {
        "path": str(service_log_path()),
        "lines": line_count,
        "content": read_log_tail(line_count),
    }


@app.post("/api/v1/system/shutdown")
def shutdown_service() -> dict[str, object]:
    logger.warning("shutdown requested from api")

    def _shutdown() -> None:
        os._exit(0)

    threading.Timer(0.5, _shutdown).start()
    return {"shuttingDown": True, "message": "服务正在关闭。"}


@app.post("/api/v1/cuda/install")
def post_cuda_install(payload: dict[str, object]) -> dict[str, object]:
    requested_variant = payload.get("cuda_variant", payload.get("cudaVariant", "cu128"))
    return install_cuda_support(str(requested_variant))


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


@app.post("/api/v1/videos/{video_id}/tasks/resummary", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_video_resummary_task(video_id: str, request: ResummaryRequest) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    task_worker: TaskWorker = app.state.task_worker
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")

    source_task = task_store.get_task(request.task_id) if request.task_id else None
    if source_task is None:
        source_task = next(
            (
                task
                for task in task_store.list_tasks_for_video(video_id)
                if task.result and task.result.transcript_text.strip() and task.result.artifacts.get("summary_path")
            ),
            None,
        )
    if source_task is None:
        raise HTTPException(status_code=400, detail="当前视频还没有可复用的转写结果。")
    if source_task.video_id != video_id:
        raise HTTPException(status_code=400, detail="所选任务不属于当前视频。")
    if source_task.result is None or not source_task.result.transcript_text.strip():
        raise HTTPException(status_code=400, detail="所选任务还没有可复用的转写文本。")

    summary_path = source_task.result.artifacts.get("summary_path") if source_task.result else None
    if not summary_path:
        raise HTTPException(status_code=400, detail="所选任务缺少可复用的分段文件。")
    segments = load_task_segments(summary_path)

    payload = json.dumps(
        {
            "title": source_task.task_input.title or video.title,
            "transcript": source_task.result.transcript_text,
            "segments": segments,
        },
        ensure_ascii=False,
    )
    logger.info(
        "create video resummary task video_id=%s source_task_id=%s title=%s",
        video.video_id,
        source_task.task_id,
        source_task.task_input.title or video.title,
    )
    record = task_store.create_task(
        TaskInput(
            input_type=InputType.TRANSCRIPT_TEXT,
            source=payload,
            title=source_task.task_input.title or video.title,
            platform_hint=source_task.task_input.platform_hint,
            options=source_task.task_input.options,
        ),
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
