import os
import re
import threading

import httpx
from fastapi import APIRouter, HTTPException, Request

from video_sum_core.models.tasks import TaskStatus
from video_sum_infra.runtime import bootstrap_managed_runtime, log_dir, prepend_runtime_path, service_log_path

from video_sum_service.context import app_info, settings_manager
from video_sum_service.integrations import (
    extract_http_error_detail,
    probe_asr_connection,
    probe_llm_connection,
    read_log_tail,
)
from video_sum_service.runtime_support import (
    build_worker,
    clear_environment_probe_cache,
    detect_environment,
    install_cuda_support,
    install_local_asr,
    serialize_settings,
)
from video_sum_service.settings_manager import SettingsUpdatePayload

router = APIRouter(prefix="/api/v1")
LATEST_RELEASE_URL = "https://api.github.com/repos/lycohana/BriefVid/releases/latest"


def _normalize_version(value: str | None) -> str:
    return str(value or "").strip().removeprefix("v").removeprefix("V")


def _version_key(value: str | None) -> tuple[int | str, ...]:
    normalized = _normalize_version(value)
    if not normalized:
        return (0,)

    parts: list[int | str] = []
    for chunk in re.split(r"[.\-+_]", normalized):
        if not chunk:
            continue
        parts.append(int(chunk) if chunk.isdigit() else chunk.lower())
    return tuple(parts) or (0,)


@router.get("/system/info")
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


@router.get("/settings")
def get_settings() -> dict[str, object]:
    return serialize_settings(settings_manager.current)


@router.get("/app/update")
def get_app_update() -> dict[str, object]:
    current_version = app_info.version
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"{app_info.name}/{current_version}",
    }

    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers=headers) as client:
            response = client.get(LATEST_RELEASE_URL)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"获取最新版本信息失败：{exc}") from exc

    if response.status_code >= 400:
        detail = extract_http_error_detail(response)
        raise HTTPException(status_code=response.status_code, detail=f"获取最新版本信息失败：{detail}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="获取最新版本信息失败：响应格式无效。") from exc

    latest_version = _normalize_version(payload.get("tag_name") or payload.get("name") or current_version)
    if not latest_version:
        raise HTTPException(status_code=502, detail="获取最新版本信息失败：缺少版本号。")

    current_key = _version_key(current_version)
    latest_key = _version_key(latest_version)
    is_newer_available = latest_key > current_key

    return {
        "status": "available" if is_newer_available else "not-available",
        "version": latest_version if is_newer_available else _normalize_version(current_version),
        "releaseDate": payload.get("published_at") or payload.get("created_at") or "",
        "releaseNotes": str(payload.get("body") or "").strip() or None,
        "downloadProgress": 0,
        "errorMessage": None,
    }


@router.put("/settings")
def update_settings(payload: SettingsUpdatePayload, request: Request) -> dict[str, object]:
    previous_settings = settings_manager.current
    current_settings = settings_manager.save(payload)
    bootstrap_managed_runtime(current_settings.runtime_channel)
    prepend_runtime_path(current_settings.runtime_channel)
    current_settings.data_dir.mkdir(parents=True, exist_ok=True)
    current_settings.cache_dir.mkdir(parents=True, exist_ok=True)
    current_settings.tasks_dir.mkdir(parents=True, exist_ok=True)
    runtime_channel_changed = previous_settings.runtime_channel != current_settings.runtime_channel
    if runtime_channel_changed:
        clear_environment_probe_cache(previous_settings.runtime_channel)
        clear_environment_probe_cache(current_settings.runtime_channel)
    environment = detect_environment(current_settings.runtime_channel)
    request.app.state.task_worker = build_worker(
        request.app.state.task_repository,
        current_settings,
        environment_info=environment,
    )
    return {
        "saved": True,
        "settings": serialize_settings(current_settings, environment_info=environment),
        "message": "设置已保存。涉及服务监听地址的修改将在下次启动后生效。",
    }


@router.post("/llm/test")
def post_llm_test(payload: SettingsUpdatePayload | None = None) -> dict[str, object]:
    return probe_llm_connection(payload)


@router.post("/asr/test")
def post_asr_test(payload: SettingsUpdatePayload | None = None) -> dict[str, object]:
    return probe_asr_connection(payload)


@router.get("/environment")
def get_environment(runtime_channel: str | None = None, refresh: bool = False) -> dict[str, object]:
    active_channel = runtime_channel or settings_manager.current.runtime_channel
    if refresh:
        clear_environment_probe_cache(active_channel)
    return detect_environment(active_channel)


@router.get("/system/logs")
def get_system_logs(lines: int = 200) -> dict[str, object]:
    line_count = max(20, min(int(lines), 1000))
    return {
        "path": str(service_log_path()),
        "lines": line_count,
        "content": read_log_tail(line_count),
    }


@router.post("/system/shutdown")
def shutdown_service() -> dict[str, object]:
    def shutdown() -> None:
        os._exit(0)

    threading.Timer(0.5, shutdown).start()
    return {"shuttingDown": True, "message": "服务正在关闭。"}


@router.post("/cuda/install")
def post_cuda_install(payload: dict[str, object], request: Request) -> dict[str, object]:
    requested_variant = payload.get("cuda_variant", payload.get("cudaVariant", "cu128"))
    result, worker = install_cuda_support(str(requested_variant), request.app.state.task_repository)
    request.app.state.task_worker = worker
    return result


@router.post("/asr/local/install")
def post_local_asr_install(request: Request, payload: dict[str, object] | None = None) -> dict[str, object]:
    reinstall = bool((payload or {}).get("reinstall"))
    result, worker = install_local_asr(reinstall=reinstall, repository=request.app.state.task_repository)
    request.app.state.task_worker = worker
    return result
