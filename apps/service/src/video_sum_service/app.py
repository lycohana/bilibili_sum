from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from yt_dlp import YoutubeDL

from video_sum_infra.db import connect_sqlite
from video_sum_infra.runtime import bootstrap_managed_runtime, prepend_runtime_path

from video_sum_service.context import CACHE_STATIC_DIR, WEB_STATIC_DIR, app_info, logger, settings_manager
from video_sum_service.integrations import cache_cover_image
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers.system import router as system_router
from video_sum_service.routers.tasks import router as tasks_router
from video_sum_service.routers.videos import router as videos_router
from video_sum_service.runtime_support import build_worker
import video_sum_service.video_assets as video_assets

probe_video_asset = video_assets.probe_video_asset


@asynccontextmanager
async def lifespan(app: FastAPI):
    current_settings = settings_manager.current
    bootstrap_managed_runtime(current_settings.runtime_channel)
    prepend_runtime_path(current_settings.runtime_channel)
    connection = connect_sqlite(current_settings.database_url)
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    app.state.task_repository = repository
    app.state.task_worker = build_worker(repository=repository, current_settings=current_settings)
    app.state.db_connection = connection
    app.state.settings_manager = settings_manager
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
app.include_router(system_router)
app.include_router(videos_router)
app.include_router(tasks_router)


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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": app_info.name, "version": app_info.version}
