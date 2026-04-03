from __future__ import annotations

import re
from pathlib import Path


def normalize_video_url(value: str) -> tuple[str, str]:
    raw = (value or "").strip()
    match = re.search(r"(BV[0-9A-Za-z]+)", raw, flags=re.IGNORECASE)
    if match:
        bvid = match.group(1)
        return f"https://www.bilibili.com/video/{bvid}", bvid
    return raw, ""


def sanitize_filename(value: str) -> str:
    sanitized = re.sub(r"[\\/:*?\"<>|]+", "_", value).strip()
    return sanitized[:120] or "video_summary"


def ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def format_timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    remaining = total % 60
    if hours:
        return f"{hours:02d}:{minutes:02d}:{remaining:02d}"
    return f"{minutes:02d}:{remaining:02d}"
