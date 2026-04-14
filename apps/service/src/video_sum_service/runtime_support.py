import json
import os
import shutil
import subprocess
import sys
import textwrap
import venv
from pathlib import Path

from fastapi import HTTPException

from video_sum_core.pipeline.real import PipelineSettings, RealPipelineRunner
from video_sum_infra.config import ServiceSettings
from video_sum_infra.runtime import (
    bootstrap_managed_runtime,
    ffmpeg_location,
    is_frozen,
    managed_runtime_dir,
    prepend_runtime_path,
    read_runtime_metadata,
    repo_root,
    runtime_library_dirs,
    runtime_python_candidates,
    runtime_python_executable,
    sanitized_subprocess_dll_search,
    write_runtime_metadata,
)

from video_sum_service.context import logger, settings_manager
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.settings_manager import SettingsUpdatePayload
from video_sum_service.worker import TaskWorker

_environment_probe_cache: dict[str, dict[str, object]] = {}
_environment_probe_failures: dict[str, str] = {}


def windows_hidden_subprocess_kwargs() -> dict[str, object]:
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


def runtime_subprocess_env(runtime_channel: str) -> dict[str, str]:
    env = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"):
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


def run_command(command: list[str], runtime_channel: str, timeout: int = 3600) -> subprocess.CompletedProcess[str]:
    with sanitized_subprocess_dll_search():
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=True,
            env=runtime_subprocess_env(runtime_channel),
            cwd=managed_runtime_dir(runtime_channel),
            **windows_hidden_subprocess_kwargs(),
        )


def command_error_detail(exc: subprocess.CalledProcessError, fallback: str) -> str:
    parts = [str(exc.stdout or "").strip(), str(exc.stderr or "").strip()]
    merged = "\n".join(part for part in parts if part).strip()
    if not merged:
        merged = str(exc)
    merged = merged[-1500:]
    return f"{fallback}\n\n{merged}".strip()


def ensure_runtime_pip(python_executable: Path, runtime_channel: str) -> None:
    try:
        run_command([str(python_executable), "-m", "pip", "--version"], runtime_channel=runtime_channel, timeout=120)
        return
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        if "No module named pip" not in detail:
            raise

    run_command([str(python_executable), "-m", "ensurepip", "--upgrade"], runtime_channel=runtime_channel, timeout=300)


def install_workspace_packages(python_executable: Path, runtime_channel: str) -> None:
    if is_frozen():
        return

    ensure_runtime_pip(python_executable, runtime_channel)
    root = repo_root()
    run_command(
        [
            str(python_executable),
            "-m",
            "pip",
            "install",
            "--upgrade",
            "pip",
            "setuptools",
            "wheel",
            "hatchling>=1.27.0",
        ],
        runtime_channel=runtime_channel,
        timeout=900,
    )
    run_command(
        [
            str(python_executable),
            "-m",
            "pip",
            "install",
            "--no-build-isolation",
            str(root / "packages" / "infra"),
            str(root / "packages" / "core"),
            str(root / "apps" / "service"),
        ],
        runtime_channel=runtime_channel,
        timeout=1800,
    )


def create_source_runtime(runtime_channel: str) -> Path:
    runtime_dir = managed_runtime_dir(runtime_channel)
    venv.EnvBuilder(with_pip=True, clear=True).create(runtime_dir)
    python_executable = next((candidate for candidate in runtime_python_candidates(runtime_dir) if candidate.exists()), None)
    if python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime creation failed: python.exe missing.")
    install_workspace_packages(python_executable, runtime_channel=runtime_channel)
    return runtime_dir


def ensure_runtime_channel(runtime_channel: str) -> Path | None:
    if runtime_channel == "base":
        bootstrap_managed_runtime("base")
        python_executable = runtime_python_executable("base")
        if python_executable is not None:
            return managed_runtime_dir("base")
        if not is_frozen():
            return create_source_runtime("base")
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
                "localAsrInstalled": False,
                "localAsrAvailable": False,
                "localAsrVersion": "",
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
            "localAsrVersion": "",
            "localAsrInstalled": False,
            "localAsrAvailable": False,
            "ffmpegLocation": "",
            "recommendedModel": "large-v3-turbo" if cuda_available else "base",
            "recommendedDevice": "cuda" if cuda_available else "cpu",
        }
        try:
            payload["localAsrVersion"] = importlib.metadata.version("faster-whisper")
            payload["localAsrInstalled"] = True
            payload["localAsrAvailable"] = True
        except importlib.metadata.PackageNotFoundError:
            pass
        print(json.dumps(payload, ensure_ascii=False))
        """
    ).strip()

    try:
        result = run_command([str(python_executable), "-c", script], runtime_channel=active_channel, timeout=120)
        payload = json.loads(result.stdout.strip() or "{}")
        payload["ffmpegLocation"] = str(ffmpeg_location() or "")
        _environment_probe_failures.pop(active_channel, None)
    except Exception as exc:
        failure_detail = (exc.stderr or exc.stdout or str(exc)).strip() if isinstance(exc, subprocess.CalledProcessError) else str(exc)
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
            "localAsrInstalled": False,
            "localAsrAvailable": False,
            "localAsrVersion": "",
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
    payload["localAsrInstalled"] = bool(payload.get("localAsrInstalled"))
    payload["localAsrAvailable"] = bool(payload.get("localAsrAvailable"))
    payload["localAsrVersion"] = str(payload.get("localAsrVersion") or "")
    payload["runtimeError"] = str(payload.get("runtimeError") or "")
    _environment_probe_cache[active_channel] = dict(payload)
    return payload


def clear_environment_probe_cache(runtime_channel: str | None = None) -> None:
    if runtime_channel is None:
        _environment_probe_cache.clear()
        _environment_probe_failures.clear()
        return
    _environment_probe_cache.pop(runtime_channel, None)
    _environment_probe_failures.pop(runtime_channel, None)


def build_worker(
    repository: SqliteTaskRepository,
    current_settings: ServiceSettings,
    environment_info: dict[str, object] | None = None,
) -> TaskWorker:
    selected_runtime_channel = current_settings.runtime_channel
    if selected_runtime_channel != "base" and runtime_python_executable(selected_runtime_channel) is None:
        logger.warning("runtime channel %s is not ready, falling back to base", selected_runtime_channel)
        selected_runtime_channel = "base"

    bootstrap_managed_runtime(selected_runtime_channel)
    prepend_runtime_path(selected_runtime_channel)
    environment = environment_info or detect_environment(selected_runtime_channel)
    runtime_settings = current_settings.with_resolved_runtime(cuda_available=bool(environment.get("cudaAvailable")))
    pipeline_settings = PipelineSettings(
        tasks_dir=runtime_settings.tasks_dir,
        runtime_channel=selected_runtime_channel,
        transcription_provider=runtime_settings.transcription_provider,
        whisper_model=runtime_settings.whisper_model,
        whisper_device=runtime_settings.whisper_device,
        whisper_compute_type=runtime_settings.whisper_compute_type,
        local_asr_available=bool(environment.get("localAsrAvailable")),
        siliconflow_asr_base_url=runtime_settings.siliconflow_asr_base_url,
        siliconflow_asr_model=runtime_settings.siliconflow_asr_model,
        siliconflow_asr_api_key=runtime_settings.siliconflow_asr_api_key,
        llm_enabled=runtime_settings.llm_enabled,
        llm_api_key=runtime_settings.llm_api_key,
        llm_base_url=runtime_settings.llm_base_url,
        llm_model=runtime_settings.llm_model,
        summary_system_prompt=runtime_settings.summary_system_prompt,
        summary_user_prompt_template=runtime_settings.summary_user_prompt_template,
        mindmap_system_prompt=runtime_settings.mindmap_system_prompt,
        mindmap_user_prompt_template=runtime_settings.mindmap_user_prompt_template,
        summary_chunk_target_chars=runtime_settings.summary_chunk_target_chars,
        summary_chunk_overlap_segments=runtime_settings.summary_chunk_overlap_segments,
        summary_chunk_concurrency=runtime_settings.summary_chunk_concurrency,
        summary_chunk_retry_count=runtime_settings.summary_chunk_retry_count,
    )
    return TaskWorker(
        repository=repository,
        pipeline_runner=RealPipelineRunner(pipeline_settings),
        auto_generate_mindmap=current_settings.auto_generate_mindmap,
    )


def serialize_settings(
    current_settings: ServiceSettings,
    environment_info: dict[str, object] | None = None,
) -> dict[str, object]:
    environment = environment_info or detect_environment(current_settings.runtime_channel)
    runtime_settings = current_settings.with_resolved_runtime(cuda_available=bool(environment.get("cudaAvailable")))
    return {
        "host": current_settings.host,
        "port": current_settings.port,
        "data_dir": str(current_settings.data_dir),
        "cache_dir": str(current_settings.cache_dir),
        "tasks_dir": str(current_settings.tasks_dir),
        "database_url": current_settings.database_url,
        "transcription_provider": current_settings.transcription_provider,
        "whisper_model": runtime_settings.whisper_model,
        "whisper_device": runtime_settings.whisper_device,
        "whisper_compute_type": runtime_settings.whisper_compute_type,
        "device_preference": current_settings.device_preference,
        "compute_type": current_settings.compute_type,
        "model_mode": current_settings.model_mode,
        "fixed_model": current_settings.fixed_model,
        "siliconflow_asr_base_url": current_settings.siliconflow_asr_base_url,
        "siliconflow_asr_model": current_settings.siliconflow_asr_model,
        "siliconflow_asr_api_key": current_settings.siliconflow_asr_api_key,
        "siliconflow_asr_api_key_configured": bool(current_settings.siliconflow_asr_api_key),
        "cuda_variant": current_settings.cuda_variant,
        "runtime_channel": current_settings.runtime_channel,
        "output_dir": str(current_settings.output_dir),
        "preserve_temp_audio": current_settings.preserve_temp_audio,
        "enable_cache": current_settings.enable_cache,
        "language": current_settings.language,
        "summary_mode": current_settings.summary_mode,
        "llm_enabled": current_settings.llm_enabled,
        "auto_generate_mindmap": current_settings.auto_generate_mindmap,
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
        "settings_file_exists": settings_manager.has_persisted_settings,
    }


def install_cuda_support(cuda_variant: str, repository: SqliteTaskRepository) -> tuple[dict[str, object], TaskWorker]:
    if cuda_variant not in {"cu124", "cu126", "cu128"}:
        raise HTTPException(status_code=400, detail="Unsupported CUDA variant.")

    runtime_channel = f"gpu-{cuda_variant}"
    runtime_dir = ensure_runtime_channel(runtime_channel)
    python_executable = runtime_python_executable(runtime_channel)
    if runtime_dir is None or python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime is unavailable.")

    try:
        install_workspace_packages(python_executable, runtime_channel=runtime_channel)
        ensure_runtime_pip(python_executable, runtime_channel)
        result = run_command(
            [
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
            ],
            runtime_channel=runtime_channel,
        )
    except subprocess.CalledProcessError as exc:
        clear_environment_probe_cache(runtime_channel)
        raise HTTPException(status_code=500, detail=command_error_detail(exc, "安装 CUDA 依赖失败。")) from exc

    current_settings = settings_manager.save(SettingsUpdatePayload(cuda_variant=cuda_variant, runtime_channel=runtime_channel))
    clear_environment_probe_cache(runtime_channel)
    clear_environment_probe_cache("base")
    write_runtime_metadata(runtime_channel, {"runtimeChannel": runtime_channel, "cudaVariant": cuda_variant, "python": str(python_executable)})
    environment = detect_environment(runtime_channel)
    worker = build_worker(repository, current_settings, environment_info=environment)
    return {
        "installed": True,
        "cudaVariant": cuda_variant,
        "runtimeChannel": runtime_channel,
        "restartRequired": True,
        "stdoutTail": (result.stdout or "")[-1500:],
        "environment": environment,
    }, worker


def install_local_asr(reinstall: bool, repository: SqliteTaskRepository) -> tuple[dict[str, object], TaskWorker]:
    current_settings = settings_manager.current
    runtime_channel = current_settings.runtime_channel
    runtime_dir = ensure_runtime_channel(runtime_channel)
    python_executable = runtime_python_executable(runtime_channel)
    if runtime_dir is None or python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime is unavailable.")

    try:
        install_workspace_packages(python_executable, runtime_channel=runtime_channel)
        ensure_runtime_pip(python_executable, runtime_channel)
        command = [str(python_executable), "-m", "pip", "install", "--upgrade", "faster-whisper>=1.1.1"]
        if reinstall:
            command.insert(5, "--force-reinstall")
        result = run_command(command, runtime_channel=runtime_channel, timeout=1800)
    except subprocess.CalledProcessError as exc:
        clear_environment_probe_cache(runtime_channel)
        raise HTTPException(status_code=500, detail=((exc.stderr or exc.stdout or str(exc))[-1500:])) from exc

    clear_environment_probe_cache(runtime_channel)
    environment = detect_environment(runtime_channel)
    worker = build_worker(repository, current_settings, environment_info=environment)
    write_runtime_metadata(
        runtime_channel,
        {
            "runtimeChannel": runtime_channel,
            "python": str(python_executable),
            "localAsrInstalled": bool(environment.get("localAsrInstalled")),
            "localAsrVersion": str(environment.get("localAsrVersion") or ""),
        },
    )
    return {
        "installed": bool(environment.get("localAsrInstalled")),
        "runtimeChannel": runtime_channel,
        "stdoutTail": ((result.stdout or "") + "\n" + (result.stderr or "")).strip()[-1500:],
        "environment": environment,
    }, worker
