import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import textwrap
import threading
import time
import uuid
import venv
from typing import Callable, Iterator

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
    repo_root,
    runtime_library_dirs,
    runtime_python_candidates,
    runtime_python_executable,
    runtime_worker_executable,
    runtime_scripts_dir,
    sanitized_subprocess_dll_search,
    service_log_path,
    web_static_dir,
    write_runtime_metadata,
)
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
CUDA_INSTALL_TERMINAL_STATES = {"completed", "failed", "cancelled"}


class CudaInstallCancelled(RuntimeError):
    pass


@dataclass
class CudaInstallTask:
    install_id: str
    cuda_variant: str
    status: str = "running"
    stage: str = "pending"
    progress: int = 0
    message: str = ""
    error: str = ""
    created_at: float = field(default_factory=lambda: time.time())
    updated_at: float = field(default_factory=lambda: time.time())
    runtime_channel: str = ""
    installed: bool = False
    restart_required: bool = False
    stdout_tail: str = ""
    environment: dict[str, object] | None = None
    seq: int = 0
    events: deque[dict[str, object]] = field(default_factory=lambda: deque(maxlen=400))
    cancel_event: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None
    process: subprocess.Popen[str] | None = None
    condition: threading.Condition = field(default_factory=lambda: threading.Condition(threading.Lock()))

    def snapshot(self) -> dict[str, object]:
        with self.condition:
            return {
                "install_id": self.install_id,
                "cuda_variant": self.cuda_variant,
                "status": self.status,
                "stage": self.stage,
                "progress": self.progress,
                "message": self.message,
                "error": self.error,
                "created_at": int(self.created_at),
                "updated_at": int(self.updated_at),
                "runtime_channel": self.runtime_channel,
                "installed": self.installed,
                "restartRequired": self.restart_required,
                "stdoutTail": self.stdout_tail,
                "environment": self.environment or {},
                "seq": self.seq,
            }


class CudaInstallManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, CudaInstallTask] = {}
        self._active_id: str | None = None

    def _get_task_unlocked(self, install_id: str) -> CudaInstallTask | None:
        return self._tasks.get(install_id)

    def _active_task_unlocked(self) -> CudaInstallTask | None:
        if self._active_id is None:
            return None
        return self._tasks.get(self._active_id)

    def _append_event(self, task: CudaInstallTask, event: dict[str, object]) -> None:
        with task.condition:
            task.seq += 1
            item = dict(event)
            item.setdefault("install_id", task.install_id)
            item["seq"] = task.seq
            task.updated_at = time.time()
            task.stage = str(item.get("stage") or task.stage)
            if isinstance(item.get("progress"), (int, float)):
                task.progress = int(item["progress"])
            if isinstance(item.get("message"), str):
                task.message = str(item["message"])
            if isinstance(item.get("status"), str) and str(item.get("status")):
                task.status = str(item["status"])
            if isinstance(item.get("runtime_channel"), str):
                task.runtime_channel = str(item["runtime_channel"])
            if item.get("installed") is True:
                task.installed = True
                task.status = "completed"
            if isinstance(item.get("stdoutTail"), str):
                task.stdout_tail = str(item["stdoutTail"])
            if isinstance(item.get("environment"), dict):
                task.environment = item["environment"]  # type: ignore[assignment]
            if isinstance(item.get("restartRequired"), bool):
                task.restart_required = bool(item["restartRequired"])
            task.events.append(item)
            task.condition.notify_all()

    def _finalize_task(self, task: CudaInstallTask, *, status: str, error: str = "") -> None:
        with task.condition:
            task.status = status
            task.error = error
            task.updated_at = time.time()
            task.condition.notify_all()
        with self._lock:
            if self._active_id == task.install_id:
                self._active_id = None
            # Keep only recent tasks in memory.
            if len(self._tasks) > 20:
                stale = sorted(self._tasks.values(), key=lambda item: item.updated_at)[:-20]
                stale_ids = {item.install_id for item in stale if item.install_id != self._active_id}
                for stale_id in stale_ids:
                    self._tasks.pop(stale_id, None)

    def _set_process(self, task: CudaInstallTask, process: subprocess.Popen[str] | None) -> None:
        with task.condition:
            task.process = process
            task.condition.notify_all()

    def _run_task(self, task: CudaInstallTask) -> None:
        try:
            for event in _cuda_install_event_iter(
                task.cuda_variant,
                install_id=task.install_id,
                cancel_event=task.cancel_event,
                process_callback=lambda proc: self._set_process(task, proc),
            ):
                self._append_event(task, event)
            final_status = "completed" if task.installed else "failed"
            if final_status == "failed" and not task.error:
                task.error = "CUDA installation finished without completion event."
            self._finalize_task(task, status=final_status, error=task.error)
        except CudaInstallCancelled:
            self._append_event(
                task,
                {
                    "install_id": task.install_id,
                    "stage": task.stage,
                    "progress": task.progress,
                    "message": "CUDA 安装已取消",
                    "error": "CUDA installation cancelled by user.",
                    "status": "cancelled",
                },
            )
            self._finalize_task(task, status="cancelled", error="CUDA installation cancelled by user.")
        except HTTPException as exc:
            detail = str(exc.detail)
            self._append_event(
                task,
                {
                    "install_id": task.install_id,
                    "stage": task.stage,
                    "progress": task.progress,
                    "message": "CUDA 安装失败",
                    "error": detail,
                    "status": "failed",
                },
            )
            self._finalize_task(task, status="failed", error=detail)
        except Exception as exc:
            logger.exception("cuda install background task crashed install_id=%s", task.install_id)
            detail = str(exc)
            self._append_event(
                task,
                {
                    "install_id": task.install_id,
                    "stage": task.stage,
                    "progress": task.progress,
                    "message": "CUDA 安装失败",
                    "error": detail,
                    "status": "failed",
                },
            )
            self._finalize_task(task, status="failed", error=detail)

    def start(self, cuda_variant: str) -> CudaInstallTask:
        normalized_variant = _normalize_cuda_variant(cuda_variant)
        with self._lock:
            active = self._active_task_unlocked()
            if active is not None and active.status == "running":
                if active.cuda_variant == normalized_variant:
                    return active
                raise HTTPException(
                    status_code=409,
                    detail=f"Another CUDA installation is in progress (install_id={active.install_id}).",
                )

            install_id = uuid.uuid4().hex[:12]
            task = CudaInstallTask(install_id=install_id, cuda_variant=normalized_variant)
            self._tasks[install_id] = task
            self._active_id = install_id
            thread = threading.Thread(target=self._run_task, args=(task,), daemon=True)
            task.thread = thread
            thread.start()
            return task

    def get(self, install_id: str | None = None) -> CudaInstallTask | None:
        with self._lock:
            if install_id:
                return self._get_task_unlocked(install_id)
            return self._active_task_unlocked()

    def cancel(self, install_id: str | None = None) -> CudaInstallTask:
        task = self.get(install_id)
        if task is None:
            raise HTTPException(status_code=404, detail="CUDA install task not found.")

        with task.condition:
            if task.status in CUDA_INSTALL_TERMINAL_STATES:
                return task
            task.cancel_event.set()
            proc = task.process
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
        return task

    def wait_terminal(self, install_id: str, timeout_seconds: int = 3600) -> CudaInstallTask:
        task = self.get(install_id)
        if task is None:
            raise HTTPException(status_code=404, detail="CUDA install task not found.")
        deadline = time.monotonic() + timeout_seconds
        while True:
            with task.condition:
                if task.status in CUDA_INSTALL_TERMINAL_STATES:
                    return task
                remaining = max(0.0, deadline - time.monotonic())
                if remaining <= 0:
                    raise HTTPException(status_code=504, detail="Timed out waiting for CUDA installation.")
                task.condition.wait(timeout=min(1.0, remaining))

    def stream(self, install_id: str, after_seq: int = 0) -> Iterator[dict[str, object]]:
        task = self.get(install_id)
        if task is None:
            raise HTTPException(status_code=404, detail="CUDA install task not found.")

        last_seq = max(0, int(after_seq))
        while True:
            pending: list[dict[str, object]] = []
            status_value = ""
            with task.condition:
                if task.seq <= last_seq and task.status not in CUDA_INSTALL_TERMINAL_STATES:
                    task.condition.wait(timeout=2.0)
                pending = [event for event in task.events if int(event.get("seq", 0)) > last_seq]
                status_value = task.status

            if pending:
                for item in pending:
                    last_seq = max(last_seq, int(item.get("seq", 0)))
                    payload = dict(item)
                    payload.setdefault("status", status_value)
                    yield payload
            elif status_value not in CUDA_INSTALL_TERMINAL_STATES:
                yield {
                    "install_id": task.install_id,
                    "seq": last_seq,
                    "stage": task.stage,
                    "progress": task.progress,
                    "message": "安装任务仍在进行，等待新的进度输出...",
                    "status": status_value,
                    "heartbeat": True,
                    "timestamp": int(time.time()),
                }

            if status_value in CUDA_INSTALL_TERMINAL_STATES:
                break


cuda_install_manager = CudaInstallManager()


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
        path_entries.append(str(ffmpeg_dir.parent))

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
    runtime_cwd = managed_runtime_dir(runtime_channel)
    if not runtime_cwd.exists():
        runtime_cwd = repo_root()
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
            cwd=runtime_cwd,
            **_windows_hidden_subprocess_kwargs(),
        )


def _install_workspace_packages(python_executable: Path, runtime_channel: str) -> None:
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


def _managed_runtime_ready(runtime_channel: str) -> bool:
    runtime_dir = managed_runtime_dir(runtime_channel)
    return any(candidate.exists() for candidate in runtime_python_candidates(runtime_dir))


def ensure_runtime_channel(runtime_channel: str) -> Path | None:
    if runtime_channel == "base":
        if is_frozen():
            return None
        bootstrap_managed_runtime("base")
        if _managed_runtime_ready("base"):
            return managed_runtime_dir("base")
        return _create_source_runtime("base")

    if is_frozen():
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Packaged builds currently support only the built-in base runtime.",
        )

    target_dir = managed_runtime_dir(runtime_channel)
    if _managed_runtime_ready(runtime_channel):
        return target_dir

    base_dir = ensure_runtime_channel("base")
    if base_dir is not None and base_dir.exists():
        shutil.copytree(base_dir, target_dir, dirs_exist_ok=True)
        if _managed_runtime_ready(runtime_channel):
            return target_dir

    return _create_source_runtime(runtime_channel)


def detect_environment(runtime_channel: str | None = None) -> dict[str, object]:
    active_channel = runtime_channel or settings_manager.current.runtime_channel
    if is_frozen() and active_channel != "base":
        logger.warning("packaged runtime channel %s is unsupported, forcing base", active_channel)
        active_channel = "base"
    cached = _environment_probe_cache.get(active_channel)
    if cached is not None:
        return dict(cached)

    if active_channel == "base" and is_frozen():
        try:
            try:
                import torch
            except ImportError:
                torch = None

            cuda_available = bool(torch is not None and torch.cuda.is_available())
            gpu_name = torch.cuda.get_device_name(0) if cuda_available else ""
            # 根据设备推荐计算精度
            recommended_compute_type = "float16" if cuda_available else "int8"
            
            payload = {
                "pythonVersion": sys.version.split()[0],
                "torchInstalled": torch is not None,
                "torchVersion": torch.__version__ if torch is not None else "",
                "cudaAvailable": cuda_available,
                "gpuName": gpu_name,
                "ytDlpVersion": importlib.metadata.version("yt-dlp"),
                "fasterWhisperVersion": importlib.metadata.version("faster-whisper"),
                "ffmpegLocation": str(ffmpeg_location() or ""),
                "recommendedModel": "large-v3-turbo" if cuda_available else "base",
                "recommendedDevice": "cuda" if cuda_available else "cpu",
                "recommendedComputeType": recommended_compute_type,
                "runtimeChannel": active_channel,
                "runtimeReady": True,
                "runtimePython": str(Path(sys.executable).resolve()),
                "runtimeError": "",
            }
            _environment_probe_failures.pop(active_channel, None)
            _environment_probe_cache[active_channel] = dict(payload)
            return payload
        except Exception as exc:
            logger.warning("detect environment inline failed runtime_channel=%s error=%s", active_channel, exc)

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
        # 根据设备推荐计算精度
        recommended_compute_type = "float16" if cuda_available else "int8"
        
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
            "recommendedComputeType": recommended_compute_type,
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
    if is_frozen():
        if selected_runtime_channel != "base":
            logger.warning("packaged build does not support runtime channel %s, forcing base", selected_runtime_channel)
        selected_runtime_channel = "base"
        if runtime_worker_executable(selected_runtime_channel) is None:
            raise RuntimeError("Packaged transcription worker is missing.")
    elif selected_runtime_channel != "base" and runtime_python_executable(selected_runtime_channel) is None:
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
    effective_runtime_channel = "base" if is_frozen() else current_settings.runtime_channel
    runtime_settings = current_settings.with_resolved_runtime(
        cuda_available=bool(detect_environment(effective_runtime_channel).get("cudaAvailable"))
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
        "runtime_channel": effective_runtime_channel,
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


def _normalize_cuda_variant(cuda_variant: str | None) -> str:
    return str(cuda_variant or "cu128").strip().lower()


_PIP_PERCENT_PATTERN = re.compile(r"(?<!\d)(\d{1,3})%")
_PIP_SIZE_PATTERN = re.compile(
    r"(?P<downloaded>\d+(?:\.\d+)?)\s*(?P<downloaded_unit>[kKmMgGtT]i?[bB])?\s*/\s*"
    r"(?P<total>\d+(?:\.\d+)?)\s*(?P<total_unit>[kKmMgGtT]i?[bB])"
)
_SIZE_FACTORS = {
    "B": 1,
    "KB": 1024,
    "MB": 1024**2,
    "GB": 1024**3,
    "TB": 1024**4,
}


def _size_to_bytes(value: str, unit: str | None) -> int | None:
    if unit is None:
        return None
    normalized_unit = unit.strip().upper().replace("IB", "B")
    factor = _SIZE_FACTORS.get(normalized_unit)
    if factor is None:
        return None
    return int(float(value) * factor)


def _format_size_bytes(value: int | None) -> str:
    if value is None:
        return "-"
    size = float(max(value, 0))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            if unit == "B":
                return f"{int(size)}{unit}"
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{int(size)}B"


def _extract_pip_download_progress(line: str) -> tuple[int | None, int | None, int | None]:
    percent: int | None = None
    downloaded_bytes: int | None = None
    total_bytes: int | None = None

    percent_match = _PIP_PERCENT_PATTERN.search(line)
    if percent_match:
        percent = max(0, min(100, int(percent_match.group(1))))

    size_match = _PIP_SIZE_PATTERN.search(line)
    if size_match:
        total_unit = size_match.group("total_unit")
        downloaded_unit = size_match.group("downloaded_unit") or total_unit
        downloaded_bytes = _size_to_bytes(size_match.group("downloaded"), downloaded_unit)
        total_bytes = _size_to_bytes(size_match.group("total"), total_unit)
        if percent is None and downloaded_bytes is not None and total_bytes and total_bytes > 0:
            percent = max(0, min(100, int(downloaded_bytes * 100 / total_bytes)))

    return percent, downloaded_bytes, total_bytes


def _cuda_event(
    install_id: str,
    *,
    stage: str,
    progress: int,
    message: str,
    output: str | None = None,
) -> dict[str, object]:
    event: dict[str, object] = {
        "install_id": install_id,
        "stage": stage,
        "progress": progress,
        "message": message,
        "timestamp": int(time.time()),
    }
    if output:
        event["output"] = output
    return event


def _cuda_install_event_iter(
    cuda_variant: str,
    *,
    install_id: str | None = None,
    cancel_event: threading.Event | None = None,
    process_callback: Callable[[subprocess.Popen[str] | None], None] | None = None,
) -> Iterator[dict[str, object]]:
    effective_install_id = install_id or uuid.uuid4().hex[:12]
    cancellation = cancel_event or threading.Event()

    def _raise_if_cancelled(*, stage: str, progress: int, message: str) -> None:
        if cancellation.is_set():
            logger.info(
                "cuda install cancelled install_id=%s stage=%s progress=%s",
                effective_install_id,
                stage,
                progress,
            )
            raise CudaInstallCancelled(message)

    def _terminate_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        try:
            process.terminate()
            process.wait(timeout=10)
            return
        except subprocess.TimeoutExpired:
            pass
        except OSError:
            return
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass

    normalized_variant = _normalize_cuda_variant(cuda_variant)
    allowed_variants = {"cu124", "cu126", "cu128"}
    if normalized_variant not in allowed_variants:
        logger.warning("cuda install rejected install_id=%s cuda_variant=%s", effective_install_id, cuda_variant)
        raise HTTPException(status_code=400, detail="Unsupported CUDA variant.")

    if is_frozen():
        logger.warning("cuda install unsupported in packaged build install_id=%s", effective_install_id)
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="CUDA managed runtime installation is not supported in packaged builds yet.",
        )

    runtime_channel = f"gpu-{normalized_variant}"
    logger.info(
        "cuda install start install_id=%s cuda_variant=%s runtime_channel=%s",
        effective_install_id,
        normalized_variant,
        runtime_channel,
    )
    yield _cuda_event(
        effective_install_id,
        stage="workspace",
        progress=5,
        message="正在准备运行时目录...",
    )
    _raise_if_cancelled(stage="workspace", progress=5, message="CUDA installation cancelled before workspace setup.")

    runtime_dir = ensure_runtime_channel(runtime_channel)
    python_executable = runtime_python_executable(runtime_channel)
    if runtime_dir is None or python_executable is None:
        logger.error(
            "cuda install runtime unavailable install_id=%s runtime_channel=%s runtime_dir=%s",
            effective_install_id,
            runtime_channel,
            runtime_dir,
        )
        raise HTTPException(status_code=500, detail="Managed runtime is unavailable.")

    logger.info(
        "cuda install runtime ready install_id=%s runtime_dir=%s python=%s",
        effective_install_id,
        runtime_dir,
        python_executable,
    )
    yield _cuda_event(
        effective_install_id,
        stage="workspace",
        progress=12,
        message="正在安装工作区依赖...",
    )
    _raise_if_cancelled(stage="workspace", progress=12, message="CUDA installation cancelled before dependency install.")
    try:
        _install_workspace_packages(python_executable, runtime_channel=runtime_channel)
    except subprocess.CalledProcessError as exc:
        logger.error(
            "cuda install workspace dependencies failed install_id=%s detail=%s",
            effective_install_id,
            (exc.stderr or exc.stdout or str(exc))[-1200:],
        )
        clear_environment_probe_cache(runtime_channel)
        raise HTTPException(
            status_code=500,
            detail=((exc.stderr or exc.stdout or str(exc))[-1500:]),
        ) from exc
    _raise_if_cancelled(stage="workspace", progress=35, message="CUDA installation cancelled after dependency install.")
    yield _cuda_event(effective_install_id, stage="workspace", progress=35, message="工作区依赖安装完成")

    command = [
        str(python_executable),
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--progress-bar",
        "on",
        "torch",
        "torchvision",
        "torchaudio",
        "--index-url",
        f"https://download.pytorch.org/whl/{normalized_variant}",
    ]
    logger.info("cuda install pip command install_id=%s command=%s", effective_install_id, command)
    yield _cuda_event(
        effective_install_id,
        stage="pytorch",
        progress=40,
        message="正在安装 PyTorch CUDA 组件...",
    )
    _raise_if_cancelled(stage="pytorch", progress=40, message="CUDA installation cancelled before pip install.")

    output_tail: deque[str] = deque(maxlen=160)
    line_count = 0
    last_reported = 0
    current_progress = 40
    last_download_percent = -1
    latest_download_bytes: int | None = None
    latest_total_bytes: int | None = None
    with sanitized_subprocess_dll_search():
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=str(runtime_dir),
            env=_runtime_subprocess_env(runtime_channel),
            **_windows_hidden_subprocess_kwargs(),
        )
    if process_callback is not None:
        process_callback(process)

    output_queue: queue.Queue[str | None] = queue.Queue()
    reader: threading.Thread | None = None
    text_buffer = ""
    try:
        if process.stdout is None:
            _terminate_process(process)
            raise HTTPException(status_code=500, detail="Failed to capture pip output for CUDA installation.")

        def read_output() -> None:
            assert process.stdout is not None
            while True:
                chunk = process.stdout.read(1024)
                if not chunk:
                    break
                output_queue.put(chunk)
            output_queue.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        last_heartbeat = time.monotonic()
        while True:
            if cancellation.is_set():
                _terminate_process(process)
                raise CudaInstallCancelled("CUDA installation cancelled while installing PyTorch dependencies.")
            try:
                raw_chunk = output_queue.get(timeout=1.0)
            except queue.Empty:
                now = time.monotonic()
                if now - last_heartbeat >= 5:
                    last_heartbeat = now
                    yield _cuda_event(
                        effective_install_id,
                        stage="pytorch",
                        progress=current_progress,
                        message=f"正在安装 PyTorch CUDA 组件（已输出 {line_count} 行，仍在进行）",
                    )
                continue

            if raw_chunk is None:
                break

            text_buffer += raw_chunk
            segments = re.split(r"[\r\n]+", text_buffer)
            text_buffer = segments.pop() if segments else ""

            for raw_segment in segments:
                line = raw_segment.strip()
                if not line:
                    continue
                output_tail.append(line)
                line_count += 1

                percent, downloaded_bytes, total_bytes = _extract_pip_download_progress(line)
                if downloaded_bytes is not None:
                    latest_download_bytes = downloaded_bytes
                if total_bytes is not None:
                    latest_total_bytes = total_bytes

                if percent is not None and percent != last_download_percent:
                    last_download_percent = percent
                    mapped_progress = int(min(88, max(current_progress, 40 + int(percent * 0.48))))
                    current_progress = mapped_progress
                    logger.info(
                        "cuda install download progress install_id=%s percent=%s downloaded=%s total=%s",
                        effective_install_id,
                        percent,
                        _format_size_bytes(latest_download_bytes),
                        _format_size_bytes(latest_total_bytes),
                    )
                    progress_message = (
                        f"正在下载 PyTorch 包 {percent}% "
                        f"({ _format_size_bytes(latest_download_bytes) } / { _format_size_bytes(latest_total_bytes) })"
                    )
                    yield _cuda_event(
                        effective_install_id,
                        stage="pytorch",
                        progress=current_progress,
                        message=progress_message,
                        output=line,
                    )
                    continue

                if line_count - last_reported >= 25:
                    last_reported = line_count
                    current_progress = int(min(88, max(current_progress, 40 + line_count // 4)))
                    logger.info(
                        "cuda install output install_id=%s progress=%s line_count=%s line=%s",
                        effective_install_id,
                        current_progress,
                        line_count,
                        line[:500],
                    )
                    yield _cuda_event(
                        effective_install_id,
                        stage="pytorch",
                        progress=current_progress,
                        message=f"正在安装 PyTorch CUDA 组件... ({line_count} 行输出)",
                        output=line,
                    )

        remaining = text_buffer.strip()
        if remaining:
            output_tail.append(remaining)

        if cancellation.is_set():
            _terminate_process(process)
            raise CudaInstallCancelled("CUDA installation cancelled while finalizing pip install.")

        returncode = process.wait()
    finally:
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        if reader is not None:
            reader.join(timeout=2)
        if process_callback is not None:
            process_callback(None)

    stdout_tail = "\n".join(output_tail)
    if returncode != 0:
        logger.error(
            "cuda install pip failed install_id=%s returncode=%s stdout_tail=%s",
            effective_install_id,
            returncode,
            stdout_tail[-1200:],
        )
        clear_environment_probe_cache(runtime_channel)
        raise HTTPException(
            status_code=500,
            detail=f"pip install failed with code {returncode}: {stdout_tail[-1200:]}",
        )

    yield _cuda_event(effective_install_id, stage="pytorch", progress=88, message="PyTorch CUDA 组件安装完成")
    yield _cuda_event(effective_install_id, stage="config", progress=92, message="正在写入运行时配置...")
    _raise_if_cancelled(stage="config", progress=92, message="CUDA installation cancelled before writing runtime config.")

    current_settings = settings_manager.save(
        SettingsUpdatePayload(cuda_variant=normalized_variant, runtime_channel=runtime_channel)
    )
    clear_environment_probe_cache(runtime_channel)
    clear_environment_probe_cache("base")
    write_runtime_metadata(
        runtime_channel,
        {
            "runtime_channel": runtime_channel,
            "cuda_variant": normalized_variant,
            "python": str(python_executable),
        },
    )
    environment = detect_environment(runtime_channel)
    app.state.task_worker = build_worker(app.state.task_repository, current_settings)
    logger.info(
        "cuda install completed install_id=%s runtime_channel=%s torch_installed=%s cuda_available=%s",
        effective_install_id,
        runtime_channel,
        bool(environment.get("torchInstalled")),
        bool(environment.get("cudaAvailable")),
    )

    yield {
        "install_id": effective_install_id,
        "installed": True,
        "cuda_variant": normalized_variant,
        "runtime_channel": runtime_channel,
        "restartRequired": True,
        "stdoutTail": stdout_tail[-1500:],
        "environment": environment,
        "progress": 100,
        "status": "completed",
        "stage": "complete",
        "message": "CUDA 安装完成",
    }


def install_cuda_support_stream(cuda_variant: str) -> Iterator[str]:
    logger.info("cuda install stream request cuda_variant=%s", cuda_variant)
    try:
        for event in _cuda_install_event_iter(cuda_variant):
            yield json.dumps(event, ensure_ascii=False)
    except HTTPException as exc:
        logger.warning("cuda install stream failed detail=%s", exc.detail)
        yield json.dumps({"error": str(exc.detail)}, ensure_ascii=False)
    except Exception as exc:  # pragma: no cover - defensive logging for unexpected runtime failures.
        logger.exception("cuda install stream failed")
        yield json.dumps({"error": str(exc)}, ensure_ascii=False)


def install_cuda_support(cuda_variant: str) -> dict[str, object]:
    logger.info("cuda install sync request cuda_variant=%s", cuda_variant)
    final_event: dict[str, object] | None = None
    for event in _cuda_install_event_iter(cuda_variant):
        final_event = event

    if final_event is None:
        raise HTTPException(status_code=500, detail="CUDA installation produced no result.")
    logger.info("cuda install sync completed install_id=%s", final_event.get("install_id"))
    return final_event


@asynccontextmanager
async def lifespan(_app: FastAPI):
    current_settings = settings_manager.current
    active_runtime_channel = "base" if is_frozen() else current_settings.runtime_channel
    bootstrap_managed_runtime(active_runtime_channel)
    prepend_runtime_path(active_runtime_channel)
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
def system_info() -> dict[str, object]:
    current_settings = settings_manager.current
    effective_runtime_channel = "base" if is_frozen() else current_settings.runtime_channel
    environment = detect_environment(effective_runtime_channel)
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
            "runtime_channel": effective_runtime_channel,
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
    logger.info("update_settings received payload: %s", payload.model_dump())
    effective_payload = payload
    if is_frozen() and payload.runtime_channel and payload.runtime_channel != "base":
        logger.warning("ignoring non-base runtime channel %s for packaged build", payload.runtime_channel)
        effective_payload = payload.model_copy(update={"runtime_channel": "base"})

    current_settings = settings_manager.save(effective_payload)
    logger.info("update_settings saved settings: model_mode=%s fixed_model=%s device_preference=%s compute_type=%s",
                current_settings.model_mode, current_settings.fixed_model, current_settings.device_preference, current_settings.compute_type)
    clear_environment_probe_cache()
    active_runtime_channel = "base" if is_frozen() else current_settings.runtime_channel
    bootstrap_managed_runtime(active_runtime_channel)
    prepend_runtime_path(active_runtime_channel)
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
def get_environment() -> dict[str, object]:
    current_settings = settings_manager.current
    effective_runtime_channel = "base" if is_frozen() else current_settings.runtime_channel
    return detect_environment(effective_runtime_channel)


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
    install_id_value = payload.get("install_id")
    if install_id_value is None:
        install_id_value = payload.get("installId")
    install_id = str(install_id_value).strip() if install_id_value else ""

    cuda_variant = payload.get("cuda_variant")
    if cuda_variant is None:
        cuda_variant = payload.get("cudaVariant", "cu128")
    resolved_variant = str(cuda_variant)
    logger.info(
        "api cuda install payload=%s resolved_variant=%s install_id=%s",
        payload,
        resolved_variant,
        install_id or "-",
    )

    task = cuda_install_manager.get(install_id) if install_id else cuda_install_manager.start(resolved_variant)
    if task is None:
        raise HTTPException(status_code=404, detail="CUDA install task not found.")
    terminal = cuda_install_manager.wait_terminal(task.install_id)
    return terminal.snapshot()


@app.post("/api/v1/cuda/install-stream")
def post_cuda_install_stream(payload: dict[str, object]) -> StreamingResponse:
    """流式 CUDA 安装端点，支持恢复既有安装任务"""
    install_id_value = payload.get("install_id")
    if install_id_value is None:
        install_id_value = payload.get("installId")
    install_id = str(install_id_value).strip() if install_id_value else ""

    after_seq_value = payload.get("after_seq")
    if after_seq_value is None:
        after_seq_value = payload.get("afterSeq", 0)
    try:
        after_seq = max(0, int(after_seq_value))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid after_seq value.") from None

    cuda_variant = payload.get("cuda_variant")
    if cuda_variant is None:
        cuda_variant = payload.get("cudaVariant", "cu128")
    resolved_variant = str(cuda_variant)

    if install_id:
        task = cuda_install_manager.get(install_id)
        if task is None:
            raise HTTPException(status_code=404, detail="CUDA install task not found.")
    else:
        task = cuda_install_manager.start(resolved_variant)

    logger.info(
        "api cuda install stream payload=%s resolved_variant=%s install_id=%s after_seq=%s",
        payload,
        resolved_variant,
        task.install_id,
        after_seq,
    )

    def generate() -> Iterator[str]:
        try:
            for event in cuda_install_manager.stream(task.install_id, after_seq=after_seq):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except HTTPException as exc:
            payload = {"install_id": task.install_id, "error": str(exc.detail), "status": "failed"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except Exception as exc:  # pragma: no cover - defensive runtime guard
            logger.exception("cuda install stream generator failed install_id=%s", task.install_id)
            payload = {"install_id": task.install_id, "error": str(exc), "status": "failed"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/v1/cuda/install/status")
def get_cuda_install_status(install_id: str | None = None) -> dict[str, object]:
    task = cuda_install_manager.get(install_id.strip() if install_id else None)
    if task is None:
        if install_id:
            raise HTTPException(status_code=404, detail="CUDA install task not found.")
        return {"active": False, "task": None}
    snapshot = task.snapshot()
    return {"active": snapshot.get("status") == "running", "task": snapshot}


@app.post("/api/v1/cuda/install/cancel")
def post_cuda_install_cancel(payload: dict[str, object]) -> dict[str, object]:
    install_id_value = payload.get("install_id")
    if install_id_value is None:
        install_id_value = payload.get("installId")
    install_id = str(install_id_value).strip() if install_id_value else None
    task = cuda_install_manager.cancel(install_id)
    return {"cancelRequested": True, "task": task.snapshot()}


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
