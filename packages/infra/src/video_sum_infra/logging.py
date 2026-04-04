import logging
import logging.config


LOG_FORMAT = "%(asctime)s %(levelname)s [pid=%(process)d tid=%(threadName)s] %(name)s | %(message)s"


def configure_logging() -> None:
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "standard": {
                    "format": LOG_FORMAT,
                }
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "standard",
                    "level": "INFO",
                }
            },
            "root": {
                "handlers": ["console"],
                "level": "INFO",
            },
            "loggers": {
                "uvicorn.access": {"level": "WARNING", "propagate": False, "handlers": ["console"]},
                "httpx": {"level": "WARNING", "propagate": False, "handlers": ["console"]},
                "httpcore": {"level": "WARNING", "propagate": False, "handlers": ["console"]},
                "faster_whisper": {"level": "WARNING", "propagate": False, "handlers": ["console"]},
                "asyncio": {"level": "WARNING", "propagate": True},
                "video_sum_service": {"level": "INFO", "propagate": True},
                "video_sum_core": {"level": "INFO", "propagate": True},
            },
        }
    )
