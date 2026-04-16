import logging

from video_sum_infra.app import AppInfo
from video_sum_infra.config import ServiceSettings
from video_sum_infra.runtime import log_dir, web_static_dir

from video_sum_service.settings_manager import SettingsManager

logger = logging.getLogger("video_sum_service.app")

settings_manager = SettingsManager(ServiceSettings())
settings = settings_manager.load()
app_info = AppInfo.load()

WEB_STATIC_DIR = web_static_dir()
CACHE_STATIC_DIR = settings.cache_dir
COVER_CACHE_DIR = CACHE_STATIC_DIR / "covers"
LOCAL_MEDIA_UPLOAD_DIR = CACHE_STATIC_DIR / "uploads"

settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.cache_dir.mkdir(parents=True, exist_ok=True)
settings.tasks_dir.mkdir(parents=True, exist_ok=True)
LOCAL_MEDIA_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
log_dir().mkdir(parents=True, exist_ok=True)
