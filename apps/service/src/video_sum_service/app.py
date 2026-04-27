import httpx
import importlib
from contextlib import asynccontextmanager
import os
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from yt_dlp import YoutubeDL

from video_sum_core.models.tasks import TaskStatus
from video_sum_infra.db import connect_sqlite
from video_sum_infra.runtime import (
    activate_runtime_pythonpath,
    bootstrap_managed_runtime,
    is_frozen,
    prepend_runtime_path,
    repo_root,
    runtime_python_executable,
    write_runtime_metadata,
)

from video_sum_service.context import CACHE_STATIC_DIR, WEB_STATIC_DIR, app_info, logger, settings_manager
from video_sum_service.integrations import cache_cover_image, probe_asr_connection, probe_llm_connection
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers.system import router as system_router
from video_sum_service.routers.knowledge import router as knowledge_router
from video_sum_service.routers.tasks import router as tasks_router
from video_sum_service.routers.videos import router as videos_router
from video_sum_service.runtime_support import (
    build_worker,
    clear_environment_probe_cache,
    detect_environment,
    ensure_runtime_channel,
    ensure_runtime_pip,
    install_workspace_packages,
    pip_install_with_fallbacks,
    replace_task_worker,
    run_command,
    serialize_settings,
)
from video_sum_service.schemas import TaskMindMapResponse
from video_sum_service.settings_manager import SettingsUpdatePayload
from video_sum_service.task_artifacts import cleanup_video_files, load_task_mindmap
import video_sum_service.video_assets as video_assets

probe_video_asset = video_assets.probe_video_asset

_cleanup_video_files = cleanup_video_files


def _uses_current_service_python(runtime_channel: str) -> bool:
    return not is_frozen() and runtime_channel == "base"


def _run_host_command(command: list[str], timeout: int = 3600):
    env = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"):
        env.pop(key, None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=True,
        env=env,
        cwd=repo_root(),
    )


def recover_incomplete_tasks(repository: SqliteTaskRepository, task_worker) -> int:
    recoverable = sorted(
        (
            record
            for record in repository.list_tasks()
            if record.status in {TaskStatus.QUEUED, TaskStatus.RUNNING}
        ),
        key=lambda record: (record.created_at, record.task_id),
    )
    if not recoverable:
        return 0

    recovered_count = 0
    for record in recoverable:
        if record.status == TaskStatus.RUNNING:
            logger.warning("recover interrupted running task task_id=%s video_id=%s", record.task_id, record.video_id)
        else:
            logger.info("recover queued task task_id=%s video_id=%s", record.task_id, record.video_id)
        task_worker.submit(record)
        recovered_count += 1

    logger.info("recovered incomplete tasks count=%d", recovered_count)
    return recovered_count


@asynccontextmanager
async def lifespan(app: FastAPI):
    current_settings = settings_manager.current
    bootstrap_managed_runtime(current_settings.runtime_channel)
    prepend_runtime_path(current_settings.runtime_channel)
    activate_runtime_pythonpath(current_settings.runtime_channel)
    connection = connect_sqlite(current_settings.database_url)
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    app.state.task_repository = repository
    task_worker = build_worker(repository=repository, current_settings=current_settings)
    replace_task_worker(app.state, task_worker)
    app.state.db_connection = connection
    app.state.settings_manager = settings_manager
    recover_incomplete_tasks(repository, task_worker)
    logger.info("application startup complete database=%s", current_settings.database_url)
    try:
        yield
    finally:
        task_worker = getattr(app.state, "task_worker", None)
        if task_worker is not None:
            task_worker.shutdown(wait=False)
        logger.info("application shutdown")
        connection.close()


app = FastAPI(
    title="BiliSum Service",
    version=app_info.version,
    description="Local-first backend service for BiliSum video summarization tasks.",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=WEB_STATIC_DIR), name="static")
app.mount("/media", StaticFiles(directory=CACHE_STATIC_DIR), name="media")
app.include_router(system_router)
app.include_router(videos_router)
app.include_router(tasks_router)
app.include_router(knowledge_router)


def frontend_shell_response() -> FileResponse:
    return FileResponse(
        WEB_STATIC_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return frontend_shell_response()


@app.get("/videos/{video_id}", include_in_schema=False)
def video_detail_page(video_id: str) -> FileResponse:
    del video_id
    return frontend_shell_response()


@app.get("/settings", include_in_schema=False)
@app.get("/settings/{subpath:path}", include_in_schema=False)
def settings_page(subpath: str = "") -> FileResponse:
    del subpath
    return frontend_shell_response()


@app.get("/knowledge", include_in_schema=False)
@app.get("/knowledge/{subpath:path}", include_in_schema=False)
def knowledge_page(subpath: str = "") -> FileResponse:
    del subpath
    return frontend_shell_response()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": app_info.name, "version": app_info.version}


def _run_command(command: list[str], runtime_channel: str, timeout: int = 3600):
    return run_command(command, runtime_channel=runtime_channel, timeout=timeout)


def _ensure_runtime_pip(python_executable, runtime_channel: str) -> None:
    return ensure_runtime_pip(python_executable, runtime_channel)


def _install_workspace_packages(python_executable, runtime_channel: str) -> None:
    if is_frozen():
        return

    _ensure_runtime_pip(python_executable, runtime_channel)
    root = repo_root()
    _run_command(
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
    command = [
        str(python_executable),
        "-m",
        "pip",
        "install",
        "--no-build-isolation",
    ]
    if runtime_channel != "base":
        command.append("--no-deps")
    command.extend(
        [
            str(root / "packages" / "infra"),
            str(root / "packages" / "core"),
            str(root / "apps" / "service"),
        ]
    )
    _run_command(command, runtime_channel=runtime_channel, timeout=1800)


def update_settings(payload: SettingsUpdatePayload) -> dict[str, object]:
    previous_settings = settings_manager.current
    current_settings = settings_manager.save(payload)
    bootstrap_managed_runtime(current_settings.runtime_channel)
    prepend_runtime_path(current_settings.runtime_channel)
    activate_runtime_pythonpath(current_settings.runtime_channel)
    current_settings.data_dir.mkdir(parents=True, exist_ok=True)
    current_settings.cache_dir.mkdir(parents=True, exist_ok=True)
    current_settings.tasks_dir.mkdir(parents=True, exist_ok=True)
    runtime_channel_changed = previous_settings.runtime_channel != current_settings.runtime_channel
    if runtime_channel_changed:
        clear_environment_probe_cache(previous_settings.runtime_channel)
        clear_environment_probe_cache(current_settings.runtime_channel)
    environment = detect_environment(current_settings.runtime_channel)
    replace_task_worker(
        app.state,
        build_worker(
            app.state.task_repository,
            current_settings,
            environment_info=environment,
        ),
    )
    return {
        "saved": True,
        "settings": serialize_settings(current_settings, environment_info=environment),
        "message": "设置已保存。涉及服务监听地址的修改将在下次启动后生效。",
    }


def install_local_asr(reinstall: bool = False) -> dict[str, object]:
    current_settings = settings_manager.current
    runtime_channel = current_settings.runtime_channel
    runtime_dir = ensure_runtime_channel(runtime_channel)
    python_executable = runtime_python_executable(runtime_channel)
    if runtime_dir is None or python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime is unavailable.")

    try:
        _install_workspace_packages(python_executable, runtime_channel=runtime_channel)
        _ensure_runtime_pip(python_executable, runtime_channel)
        result = pip_install_with_fallbacks(
            python_executable,
            runtime_channel,
            ["faster-whisper>=1.1.1"],
            reinstall=reinstall,
            timeout=1800,
            runner=_run_command,
        )
    except Exception as exc:
        clear_environment_probe_cache(runtime_channel)
        if isinstance(exc, HTTPException):
            raise
        detail = getattr(exc, "stderr", None) or getattr(exc, "stdout", None) or str(exc)
        raise HTTPException(status_code=500, detail=str(detail)[-1500:]) from exc

    clear_environment_probe_cache(runtime_channel)
    environment = detect_environment(runtime_channel)
    replace_task_worker(
        app.state,
        build_worker(
            app.state.task_repository,
            current_settings,
            environment_info=environment,
        ),
    )
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
        "stdoutTail": ((getattr(result, "stdout", "") or "") + "\n" + (getattr(result, "stderr", "") or "")).strip()[-1500:],
        "environment": environment,
    }


def install_knowledge_dependencies(reinstall: bool = False) -> dict[str, object]:
    current_settings = settings_manager.current
    runtime_channel = current_settings.runtime_channel
    use_current_python = _uses_current_service_python(runtime_channel)
    if use_current_python:
        runtime_dir = repo_root()
        python_executable = Path(sys.executable).resolve()
        runner = lambda command, runtime_channel, timeout=1800: _run_host_command(command, timeout=timeout)
    else:
        runtime_dir = ensure_runtime_channel(runtime_channel)
        python_executable = runtime_python_executable(runtime_channel)
        runner = _run_command
    if runtime_dir is None or python_executable is None:
        raise HTTPException(status_code=500, detail="Managed runtime is unavailable.")

    try:
        if not use_current_python:
            _install_workspace_packages(python_executable, runtime_channel=runtime_channel)
            _ensure_runtime_pip(python_executable, runtime_channel)
        result = pip_install_with_fallbacks(
            python_executable,
            runtime_channel,
            ["chromadb>=1.0.0", "sentence-transformers>=3.0"],
            package_label="知识库依赖",
            reinstall=reinstall,
            timeout=1800,
            runner=runner,
        )
    except Exception as exc:
        clear_environment_probe_cache(runtime_channel)
        if isinstance(exc, HTTPException):
            raise
        detail = getattr(exc, "stderr", None) or getattr(exc, "stdout", None) or str(exc)
        raise HTTPException(status_code=500, detail=str(detail)[-1500:]) from exc

    importlib.invalidate_caches()
    activate_runtime_pythonpath(runtime_channel)
    clear_environment_probe_cache(runtime_channel)
    environment = detect_environment(runtime_channel)
    replace_task_worker(
        app.state,
        build_worker(
            app.state.task_repository,
            current_settings,
            environment_info=environment,
        ),
    )
    write_runtime_metadata(
        runtime_channel,
        {
            "runtimeChannel": runtime_channel,
            "python": str(python_executable),
            "chromadbInstalled": bool(environment.get("chromadbInstalled")),
            "chromadbVersion": str(environment.get("chromadbVersion") or ""),
            "sentenceTransformersInstalled": bool(environment.get("sentenceTransformersInstalled")),
            "sentenceTransformersVersion": str(environment.get("sentenceTransformersVersion") or ""),
            "knowledgeDependenciesReady": bool(environment.get("knowledgeDependenciesReady")),
        },
    )
    return {
        "installed": bool(environment.get("knowledgeDependenciesReady")),
        "runtimeChannel": runtime_channel,
        "stdoutTail": ((getattr(result, "stdout", "") or "") + "\n" + (getattr(result, "stderr", "") or "")).strip()[-1500:],
        "environment": environment,
    }


def get_task_mindmap(task_id: str) -> TaskMindMapResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    record = task_store.get_task(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Task not found.")

    result = record.result
    if result is None:
        return TaskMindMapResponse(task_id=task_id, status="idle")

    mindmap_path = result.mindmap_artifact_path or result.artifacts.get("mindmap_path")
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

    mindmap = None
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


def generate_task_mindmap(task_id: str, force: bool = False) -> TaskMindMapResponse:
    task_store: SqliteTaskRepository = app.state.task_repository
    task_worker = app.state.task_worker
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
