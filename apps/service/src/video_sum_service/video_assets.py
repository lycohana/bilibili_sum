import json
import logging
import re
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import HTTPException
from yt_dlp import YoutubeDL

from video_sum_core.utils import extract_bilibili_page, normalize_video_url

from video_sum_service.integrations import cache_cover_image
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import VideoAssetRecord, VideoPageOptionResponse

logger = logging.getLogger("video_sum_service.app")


def with_bilibili_page(url: str, page: int) -> str:
    parsed = urlparse(url)
    query_pairs: list[tuple[str, str]] = []
    if parsed.query:
        for chunk in parsed.query.split("&"):
            if not chunk:
                continue
            key, _, value = chunk.partition("=")
            if key != "p":
                query_pairs.append((key, value))
    query_pairs.append(("p", str(page)))
    encoded_query = urlencode(query_pairs)
    return parsed._replace(query=encoded_query).geturl()


def build_page_canonical_id(base_id: str, page: int) -> str:
    return f"{base_id}?p={page}"


def extract_page_part_from_title(base_title: str, page: int, title: str) -> str:
    candidate = str(title or "").strip()
    if not candidate:
        return ""

    normalized_base = re.sub(r"\s+", " ", base_title).strip()
    normalized_candidate = re.sub(r"\s+", " ", candidate).strip()
    if normalized_base and normalized_candidate.startswith(normalized_base):
        candidate = normalized_candidate[len(normalized_base):].strip(" -_")
    else:
        candidate = normalized_candidate

    candidate = re.sub(rf"^[Pp]0*{page}\s*", "", candidate).strip(" -_")
    candidate = re.sub(rf"^第?\s*0*{page}\s*[Pp]?\s*", "", candidate).strip(" -_")
    return candidate


def build_page_title(base_title: str, page: int, info: dict[str, object]) -> str:
    part = str(info.get("part") or "").strip()
    title = str(info.get("title") or "").strip()
    candidate = part or extract_page_part_from_title(base_title, page, title)
    if not candidate:
        return f"P{page}"
    return f"P{page} {candidate}"


def extract_video_info(url: str, *, extract_flat: bool = False) -> dict[str, object]:
    options: dict[str, object] = {"quiet": True, "no_warnings": True}
    if extract_flat:
        options["extract_flat"] = "in_playlist"
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    if not isinstance(info, dict):
        raise HTTPException(status_code=400, detail="无法读取视频信息。")
    return info


def fetch_bilibili_page_catalog(url: str) -> list[dict[str, object]]:
    try:
        response = httpx.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.bilibili.com/",
            },
            follow_redirects=True,
            timeout=30.0,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        logger.warning("failed to fetch bilibili page catalog: %s", url, exc_info=True)
        return []

    match = re.search(r"__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;\s*\(function", response.text, re.S)
    if not match:
        return []

    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        logger.warning("failed to parse bilibili page catalog payload: %s", url, exc_info=True)
        return []

    video_data = payload.get("videoData") or {}
    pages = video_data.get("pages") or []
    return [item for item in pages if isinstance(item, dict)]


def build_base_video_asset(
    *,
    canonical_id: str,
    platform: str,
    title: str,
    source_url: str,
    cover_url: str,
    duration: float | None,
    pages: list[VideoPageOptionResponse],
) -> VideoAssetRecord:
    return VideoAssetRecord(
        canonical_id=canonical_id,
        platform=platform,
        title=title,
        source_url=source_url,
        cover_url=cover_url,
        duration=duration,
        pages=pages,
    )


def resolve_video_page(video: VideoAssetRecord, page_number: int | None) -> VideoPageOptionResponse | None:
    if not video.pages:
        return None
    target_page = page_number or 1
    return next((page for page in video.pages if page.page == target_page), None)


def probe_video_asset(
    url: str,
    force_refresh: bool = False,
) -> tuple[VideoAssetRecord, list[VideoPageOptionResponse], bool]:
    del force_refresh

    normalized = normalize_video_url(url)
    normalized_url = normalized.normalized_url
    canonical_id = normalized.canonical_id
    platform = normalized.platform

    if platform not in {"bilibili", "youtube"}:
        raise HTTPException(status_code=400, detail="当前仅支持 Bilibili 或 YouTube 单条视频链接。")

    if platform == "youtube":
        info = extract_video_info(normalized_url)
        title = str(info.get("title") or canonical_id or normalized_url)
        thumbnail = str(info.get("thumbnail") or "")
        duration = float(info.get("duration")) if info.get("duration") else None
        actual_id = str(info.get("id") or canonical_id or normalized_url)
        cached_cover_url = cache_cover_image(thumbnail, actual_id, referer_url=normalized_url)
        return (
            build_base_video_asset(
                canonical_id=actual_id,
                platform="youtube",
                title=title,
                source_url=normalized_url,
                cover_url=cached_cover_url,
                duration=duration,
                pages=[],
            ),
            [],
            False,
        )

    requested_page = extract_bilibili_page(normalized_url)

    if requested_page is None:
        flat_info = extract_video_info(normalized_url, extract_flat=True)
        flat_entries = [entry for entry in flat_info.get("entries", []) if isinstance(entry, dict)]
        if len(flat_entries) > 1:
            top_title = str(flat_info.get("title") or canonical_id or normalized_url)
            top_id = str(flat_info.get("id") or canonical_id or normalized_url)
            catalog_entries = fetch_bilibili_page_catalog(normalized_url)
            pages: list[VideoPageOptionResponse] = []
            for index, entry in enumerate(flat_entries, start=1):
                page_url = str(
                    entry.get("url")
                    or with_bilibili_page(f"https://www.bilibili.com/video/{canonical_id}", index)
                )
                catalog_entry = next(
                    (
                        item
                        for item in catalog_entries
                        if int(item.get("page") or 0) == index
                    ),
                    None,
                )
                page_title = build_page_title(
                    top_title,
                    index,
                    {
                        "part": str((catalog_entry or {}).get("part") or "").strip(),
                        "title": str(entry.get("title") or "").strip(),
                    },
                )
                pages.append(
                    VideoPageOptionResponse(
                        page=index,
                        title=page_title,
                        source_url=page_url,
                        cover_url="",
                        duration=None,
                    )
                )

            return (
                build_base_video_asset(
                    canonical_id=top_id,
                    platform=str(flat_info.get("extractor_key") or "video").lower(),
                    title=top_title,
                    source_url=f"https://www.bilibili.com/video/{canonical_id}",
                    cover_url="",
                    duration=None,
                    pages=pages,
                ),
                pages,
                True,
            )

    info = extract_video_info(normalized_url)

    title = str(info.get("title") or canonical_id or normalized_url)
    thumbnail = str(info.get("thumbnail") or "")
    duration = float(info.get("duration")) if info.get("duration") else None
    platform = str(info.get("extractor_key") or "video").lower()
    actual_id = str(info.get("id") or canonical_id or normalized_url)
    entries = [entry for entry in info.get("entries", []) if isinstance(entry, dict)]

    if entries:
        pages: list[VideoPageOptionResponse] = []
        for index, entry in enumerate(entries, start=1):
            page = int(entry.get("page") or entry.get("playlist_index") or index)
            page_title = build_page_title(title, page, entry)
            page_url = with_bilibili_page(f"https://www.bilibili.com/video/{canonical_id}", page)
            page_cover = str(entry.get("thumbnail") or thumbnail or "")
            page_duration = float(entry.get("duration")) if entry.get("duration") else None
            pages.append(
                VideoPageOptionResponse(
                    page=page,
                    title=page_title,
                    source_url=page_url,
                    cover_url=page_cover,
                    duration=page_duration,
                )
            )

        selected_page = requested_page or pages[0].page
        selected = next((item for item in pages if item.page == selected_page), pages[0])
        selected_cover = cache_cover_image(
            selected.cover_url or thumbnail,
            actual_id,
            referer_url=selected.source_url,
        )
        return (
            build_base_video_asset(
                canonical_id=actual_id,
                platform=platform,
                title=title,
                source_url=f"https://www.bilibili.com/video/{canonical_id}",
                cover_url=selected_cover,
                duration=duration,
                pages=pages,
            ),
            pages,
            requested_page is None and len(pages) > 1,
        )

    cached_cover_url = cache_cover_image(thumbnail, actual_id, referer_url=normalized_url)
    return (
        build_base_video_asset(
            canonical_id=actual_id,
            platform=platform,
            title=title,
            source_url=normalized_url,
            cover_url=cached_cover_url,
            duration=duration,
            pages=[],
        ),
        [],
        False,
    )


def localize_video_cover(task_store: SqliteTaskRepository, video: VideoAssetRecord) -> VideoAssetRecord:
    if not video.cover_url or video.cover_url.startswith("/media/"):
        return video
    localized = cache_cover_image(video.cover_url, video.canonical_id, referer_url=video.source_url)
    if localized == video.cover_url:
        return video
    updated = video.model_copy(update={"cover_url": localized})
    return task_store.upsert_video_asset(updated)
