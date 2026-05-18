import hashlib
import html
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from typing import Iterable
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.responses import Response

from video_sum_core.models.tasks import InputType, TaskInput
from video_sum_infra.runtime import ffmpeg_location

from video_sum_service.context import LOCAL_MEDIA_UPLOAD_DIR, logger, settings_manager
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.runtime_startup import submit_task_or_queue
from video_sum_service.schemas import (
    AggregateSummaryRequest,
    ResummaryRequest,
    TaskDetailResponse,
    TaskSummaryResponse,
    VideoAssetDetailResponse,
    VideoDirectMediaResponse,
    VideoAssetSummaryResponse,
    VideoAssetRecord,
    VideoProbeRequest,
    VideoProbeResponse,
    VideoTaskBatchPageResponse,
    VideoTaskBatchRequest,
    VideoTaskBatchResponse,
    VideoTaskCreateRequest,
)
from video_sum_service.task_artifacts import cleanup_video_files, load_task_segments
from video_sum_service.video_assets import (
    build_ydl_probe_options,
    extract_video_info,
    infer_local_input_type,
    is_supported_local_media_file,
    localize_video_cover,
    merge_video_asset_metadata,
    probe_local_video_asset,
    probe_video_asset,
    resolve_video_page,
)

router = APIRouter(prefix="/api/v1/videos")
AGGREGATE_SUMMARY_PAGE_NUMBER = 0
AGGREGATE_SUMMARY_PAGE_TITLE = "全集总结"
AGGREGATE_SUMMARY_TITLE_SUFFIX = "｜全集总结"
AGGREGATE_OVERVIEW_LIMIT = 520
AGGREGATE_KEY_POINT_LIMIT = 160
AGGREGATE_CHAPTER_LIMIT = 180
AGGREGATE_NOTE_LIMIT = 360
AGGREGATE_MAX_KEY_POINTS_PER_PAGE = 8
AGGREGATE_MAX_CHAPTERS_PER_PAGE = 8
BILIBILI_DIRECT_MEDIA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}
DIRECT_MEDIA_CACHE_DIRNAME = "direct-media"
_direct_media_cache_locks: dict[str, threading.Lock] = {}
_direct_media_cache_locks_guard = threading.Lock()
_direct_media_probe_cache: dict[str, tuple[float, dict[str, object]]] = {}
_direct_media_probe_cache_ttl = 600.0
_direct_media_probe_cache_guard = threading.Lock()


def _normalize_batch_page_numbers(video: VideoAssetRecord, page_numbers: list[int]) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for raw_page_number in page_numbers:
        if raw_page_number in seen:
            continue
        seen.add(raw_page_number)
        normalized.append(int(raw_page_number))

    if not normalized:
        raise HTTPException(status_code=400, detail="至少选择一个分 P。")
    if not video.pages:
        raise HTTPException(status_code=400, detail="当前视频不包含可批量处理的分 P。")

    existing_pages = {page.page for page in video.pages}
    invalid_pages = [page_number for page_number in normalized if page_number not in existing_pages]
    if invalid_pages:
        raise HTTPException(
            status_code=400,
            detail=f"所选分 P 不存在：{', '.join(f'P{page_number}' for page_number in invalid_pages)}。",
        )
    return normalized


def _find_latest_completed_task_for_page(tasks, page_number: int):
    return next(
        (
            task
            for task in tasks
            if (task.page_number if task.page_number is not None else 1) == page_number
            and task.status.value == "completed"
            and task.result is not None
        ),
        None,
    )


def _find_resummary_source_task(
    task_store: SqliteTaskRepository,
    video_id: str,
    body: ResummaryRequest,
):
    source_task = task_store.get_task(body.task_id) if body.task_id else None
    if source_task is None:
        source_task = next(
            (
                task
                for task in task_store.list_tasks_for_video(video_id)
                if (
                    task.result
                    and task.result.transcript_text.strip()
                    and task.result.artifacts.get("summary_path")
                    and (
                        body.page_number is None
                        or _task_page_number(task) == body.page_number
                    )
                )
            ),
            None,
        )
    return source_task


def _task_page_number(task) -> int:
    return task.page_number if task.page_number is not None else 1


def _compact_text(value: object, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def _has_aggregate_summary_material(result) -> bool:
    return bool(
        str(result.overview or "").strip()
        or any(str(item).strip() for item in result.key_points)
        or any(str(item).strip() for item in result.segment_summaries)
        or any(isinstance(item, dict) and str(item.get("summary") or "").strip() for item in result.timeline)
        or str(result.knowledge_note_markdown or "").strip()
    )


def _int_or_none(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _resolve_video_source_url(video: VideoAssetRecord, page_number: int | None) -> str:
    page = resolve_video_page(video, page_number)
    return str((page.source_url if page else video.source_url) or "")


def _direct_media_probe_cache_key(source_url: str) -> str:
    return hashlib.sha256(source_url.encode("utf-8")).hexdigest()


def _extract_direct_media_info(source_url: str, *, force_refresh: bool = False) -> dict[str, object]:
    cache_key = _direct_media_probe_cache_key(source_url)
    now = time.monotonic()
    if not force_refresh:
        with _direct_media_probe_cache_guard:
            cached = _direct_media_probe_cache.get(cache_key)
            if cached and cached[0] > now:
                return cached[1]
    info = extract_video_info(source_url)
    with _direct_media_probe_cache_guard:
        _direct_media_probe_cache[cache_key] = (now + _direct_media_probe_cache_ttl, info)
        if len(_direct_media_probe_cache) > 64:
            expired = [key for key, (expires_at, _) in _direct_media_probe_cache.items() if expires_at <= now]
            for key in expired:
                _direct_media_probe_cache.pop(key, None)
    return info


def _select_direct_media_format(info: dict[str, object]) -> dict[str, object] | None:
    formats = [item for item in info.get("formats", []) if isinstance(item, dict)]
    candidates: list[dict[str, object]] = []
    for item in formats:
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        acodec = str(item.get("acodec") or "none")
        vcodec = str(item.get("vcodec") or "none")
        ext = str(item.get("ext") or "").lower()
        protocol = str(item.get("protocol") or "").lower()
        if acodec == "none" or vcodec == "none":
            continue
        if ext not in {"mp4", "webm", "m4v", "mov"}:
            continue
        if protocol and protocol not in {"http", "https"}:
            continue
        candidates.append(item)
    if not candidates:
        return None

    def score(item: dict[str, object]) -> tuple[int, int, int]:
        height = _int_or_none(item.get("height")) or 0
        tbr = _int_or_none(item.get("tbr")) or 0
        ext_score = 1 if str(item.get("ext") or "").lower() == "mp4" else 0
        return (ext_score, height, tbr)

    return max(candidates, key=score)


def _streamable_http_url(item: dict[str, object]) -> str:
    url = str(item.get("url") or "").strip()
    if not url:
        return ""
    protocol = str(item.get("protocol") or "").lower()
    if protocol and protocol not in {"http", "https"}:
        return ""
    if not (url.startswith("http://") or url.startswith("https://")):
        return ""
    return url


def _float_or_none(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _select_mux_media_formats(info: dict[str, object]) -> tuple[dict[str, object] | None, dict[str, object] | None]:
    formats = [item for item in info.get("formats", []) if isinstance(item, dict)]
    video_candidates: list[dict[str, object]] = []
    audio_candidates: list[dict[str, object]] = []
    for item in formats:
        if not _streamable_http_url(item):
            continue
        acodec = str(item.get("acodec") or "none")
        vcodec = str(item.get("vcodec") or "none")
        if vcodec != "none" and acodec == "none":
            video_candidates.append(item)
        elif acodec != "none" and vcodec == "none":
            audio_candidates.append(item)

    def video_score(item: dict[str, object]) -> tuple[int, int, int, int, int]:
        ext = str(item.get("ext") or "").lower()
        vcodec = str(item.get("vcodec") or "").lower()
        height = _int_or_none(item.get("height")) or 0
        tbr = _int_or_none(item.get("tbr")) or _int_or_none(item.get("vbr")) or 0
        format_id = _int_or_none(item.get("format_id")) or 0
        ext_score = 1 if ext in {"mp4", "m4s"} else 0
        codec_score = 3 if vcodec.startswith(("avc", "h264")) else 2 if vcodec.startswith("av01") else 1
        return (ext_score, codec_score, height, tbr, format_id)

    def audio_score(item: dict[str, object]) -> tuple[int, int, int, int]:
        ext = str(item.get("ext") or "").lower()
        acodec = str(item.get("acodec") or "").lower()
        abr = _int_or_none(item.get("abr")) or _int_or_none(item.get("tbr")) or 0
        format_id = _int_or_none(item.get("format_id")) or 0
        ext_score = 1 if ext in {"m4a", "mp4", "m4s"} else 0
        codec_score = 1 if acodec.startswith(("mp4a", "aac")) else 0
        return (ext_score, codec_score, abr, format_id)

    selected_video = max(video_candidates, key=video_score) if video_candidates else None
    selected_audio = max(audio_candidates, key=audio_score) if audio_candidates else None
    return selected_video, selected_audio


def _load_ydl_cookies():
    ydl_options = build_ydl_probe_options()
    cookiefile = str(ydl_options.get("cookiefile") or "").strip()
    if not cookiefile:
        return None
    try:
        from yt_dlp.cookies import YoutubeDLCookieJar

        cookie_jar = YoutubeDLCookieJar(cookiefile)
        cookie_jar.load(ignore_discard=True, ignore_expires=True)
        return cookie_jar
    except Exception:
        logger.warning("failed to load yt-dlp cookies for direct media stream", exc_info=True)
        return None


def _cookie_header_for_urls(cookies: Iterable[object] | None, urls: list[str]) -> str:
    if cookies is None:
        return ""
    hosts = {urlparse(url).hostname or "" for url in urls}
    pairs: list[str] = []
    seen: set[str] = set()
    for cookie in cookies:
        name = str(getattr(cookie, "name", "") or "").strip()
        value = str(getattr(cookie, "value", "") or "")
        domain = str(getattr(cookie, "domain", "") or "").lstrip(".")
        if not name or name in seen:
            continue
        if domain and hosts and not any(host == domain or host.endswith(f".{domain}") for host in hosts):
            if "bilibili.com" not in domain:
                continue
        pairs.append(f"{name}={value}")
        seen.add(name)
    return "; ".join(pairs)


def _ffmpeg_header_lines(headers: dict[str, str]) -> str:
    return "".join(f"{key}: {value}\r\n" for key, value in headers.items())


def _hidden_subprocess_kwargs() -> dict[str, object]:
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {
        "creationflags": subprocess.CREATE_NO_WINDOW,
        "startupinfo": startupinfo,
    }


def _direct_media_cache_dir() -> Path:
    cache_dir = settings_manager.current.cache_dir / DIRECT_MEDIA_CACHE_DIRNAME
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _direct_media_cache_lock(cache_key: str) -> threading.Lock:
    with _direct_media_cache_locks_guard:
        lock = _direct_media_cache_locks.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _direct_media_cache_locks[cache_key] = lock
        return lock


def _direct_media_cache_key(
    video: VideoAssetRecord,
    page_number: int | None,
    selected_video: dict[str, object],
    selected_audio: dict[str, object],
) -> str:
    payload = {
        "video_id": video.video_id,
        "page_number": int(page_number or 1),
        "source_url": _resolve_video_source_url(video, page_number),
        "video_format_id": str(selected_video.get("format_id") or ""),
        "audio_format_id": str(selected_audio.get("format_id") or ""),
        "width": _int_or_none(selected_video.get("width")),
        "height": _int_or_none(selected_video.get("height")),
        "vcodec": str(selected_video.get("vcodec") or ""),
        "acodec": str(selected_audio.get("acodec") or ""),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:32]


def _direct_media_cache_path(cache_key: str) -> Path:
    return _direct_media_cache_dir() / f"{cache_key}.mp4"


def _direct_media_split_url(video_id: str, page_number: int | None, track: str) -> str:
    return f"/api/v1/videos/{video_id}/direct-media/track/{track}?page_number={int(page_number or 1)}"


def _direct_media_mpd_url(video_id: str, page_number: int | None) -> str:
    return f"/api/v1/videos/{video_id}/direct-media/manifest.mpd?page_number={int(page_number or 1)}"


def _format_xs_duration(seconds: float | None) -> str:
    duration = max(0.001, float(seconds or 0.001))
    return f"PT{duration:.3f}S"


def _mp4_codec_string(item: dict[str, object], codec_key: str) -> str:
    codec = str(item.get(codec_key) or "").strip()
    if codec and codec != "none":
        return codec
    return "avc1.640028" if codec_key == "vcodec" else "mp4a.40.2"


def _build_direct_media_mpd(
    *,
    video: VideoAssetRecord,
    page_number: int | None,
    info: dict[str, object],
    selected_video: dict[str, object],
    selected_audio: dict[str, object],
) -> str:
    page = resolve_video_page(video, page_number)
    duration = (
        _float_or_none(info.get("duration"))
        or (page.duration if page is not None else None)
        or video.duration
        or 0.001
    )
    video_track_url = html.escape(_direct_media_split_url(video.video_id, page_number, "video"), quote=True)
    audio_track_url = html.escape(_direct_media_split_url(video.video_id, page_number, "audio"), quote=True)
    video_bandwidth = max(1, (_int_or_none(selected_video.get("tbr")) or _int_or_none(selected_video.get("vbr")) or 1000) * 1000)
    audio_bandwidth = max(1, (_int_or_none(selected_audio.get("abr")) or _int_or_none(selected_audio.get("tbr")) or 128) * 1000)
    width = _int_or_none(selected_video.get("width")) or 1280
    height = _int_or_none(selected_video.get("height")) or 720
    frame_rate = html.escape(str(selected_video.get("fps") or "30"), quote=True)
    video_codec = html.escape(_mp4_codec_string(selected_video, "vcodec"), quote=True)
    audio_codec = html.escape(_mp4_codec_string(selected_audio, "acodec"), quote=True)
    audio_sampling_rate = html.escape(str(selected_audio.get("asr") or 48000), quote=True)
    duration_text = _format_xs_duration(duration)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="{duration_text}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period id="0" duration="{duration_text}">
    <AdaptationSet id="0" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
      <Representation id="video" bandwidth="{video_bandwidth}" codecs="{video_codec}" width="{width}" height="{height}" frameRate="{frame_rate}">
        <BaseURL>{video_track_url}</BaseURL>
        <SegmentBase indexRangeExact="true">
          <Initialization range="0-1023" />
        </SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">
      <Representation id="audio" bandwidth="{audio_bandwidth}" codecs="{audio_codec}" audioSamplingRate="{audio_sampling_rate}">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2" />
        <BaseURL>{audio_track_url}</BaseURL>
        <SegmentBase indexRangeExact="true">
          <Initialization range="0-1023" />
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
"""


def _build_mux_command(
    *,
    video_url: str,
    audio_url: str,
    output: str,
) -> list[str]:
    headers = dict(BILIBILI_DIRECT_MEDIA_HEADERS)
    cookie_header = _cookie_header_for_urls(_load_ydl_cookies(), [video_url, audio_url])
    if cookie_header:
        headers["Cookie"] = cookie_header
    header_lines = _ffmpeg_header_lines(headers)
    return [
        str(ffmpeg_location()),
        "-hide_banner",
        "-loglevel",
        "error",
        "-headers",
        header_lines,
        "-i",
        video_url,
        "-headers",
        header_lines,
        "-i",
        audio_url,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        output,
    ]


def _muxed_media_stream_response(
    *,
    request: Request,
    video: VideoAssetRecord,
    page_number: int | None,
    selected_video: dict[str, object],
    selected_audio: dict[str, object],
) -> StreamingResponse:
    video_url = _streamable_http_url(selected_video)
    audio_url = _streamable_http_url(selected_audio)
    ffmpeg_exe = ffmpeg_location()
    if not video_url or not audio_url or ffmpeg_exe is None:
        raise HTTPException(status_code=400, detail="Bilibili 音视频分离流无法合流播放。")

    cache_key = _direct_media_cache_key(video, page_number, selected_video, selected_audio)
    cache_path = _direct_media_cache_path(cache_key)
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return _range_file_response(cache_path, request, media_type="video/mp4")

    lock = _direct_media_cache_lock(cache_key)
    owns_cache_writer = lock.acquire(blocking=False)
    temp_path = cache_path.with_suffix(f".{uuid4().hex}.tmp") if owns_cache_writer else None
    command = _build_mux_command(video_url=video_url, audio_url=audio_url, output="pipe:1")
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            **_hidden_subprocess_kwargs(),
        )
    except OSError as exc:
        if owns_cache_writer:
            lock.release()
        raise HTTPException(status_code=502, detail=f"ffmpeg 启动失败：{exc}") from exc

    def iterator():
        cache_file = None
        wrote_cache = False
        try:
            if temp_path is not None:
                cache_file = temp_path.open("wb")
            if process.stdout is None:
                return
            while True:
                chunk = process.stdout.read(1024 * 256)
                if not chunk:
                    break
                if cache_file is not None:
                    cache_file.write(chunk)
                    wrote_cache = True
                yield chunk
        finally:
            if process.stdout is not None:
                process.stdout.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            else:
                process.wait(timeout=3)
            if cache_file is not None:
                cache_file.close()
            if temp_path is not None:
                if process.returncode == 0 and wrote_cache and temp_path.exists() and temp_path.stat().st_size > 0:
                    temp_path.replace(cache_path)
                else:
                    temp_path.unlink(missing_ok=True)
            if owns_cache_writer:
                lock.release()

    return StreamingResponse(
        iterator(),
        media_type="video/mp4",
        headers={"Cache-Control": "no-store", "Accept-Ranges": "none"},
    )


def _parse_range_header(range_header: str | None, file_size: int) -> tuple[int, int] | None:
    if not range_header or not range_header.startswith("bytes=") or file_size <= 0:
        return None
    raw_range = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
    if "-" not in raw_range:
        return None
    start_text, end_text = raw_range.split("-", 1)
    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else file_size - 1
        else:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                return None
            start = max(0, file_size - suffix_length)
            end = file_size - 1
    except ValueError:
        return None
    if start < 0 or start >= file_size:
        return None
    return start, min(end, file_size - 1)


def _range_file_response(path: Path, request: Request, media_type: str = "video/mp4") -> StreamingResponse:
    file_size = path.stat().st_size
    range_value = _parse_range_header(request.headers.get("range"), file_size)
    start = range_value[0] if range_value else 0
    end = range_value[1] if range_value else file_size - 1
    status_code = 206 if range_value else 200
    content_length = max(0, end - start + 1)
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Cache-Control": "public, max-age=86400",
    }
    if range_value:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    def iterator():
        with path.open("rb") as file:
            file.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = file.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(iterator(), status_code=status_code, media_type=media_type, headers=headers)


def _direct_media_status(video: VideoAssetRecord, page_number: int | None) -> VideoDirectMediaResponse:
    if str(video.platform or "").lower() == "local":
        return VideoDirectMediaResponse(
            available=True,
            mode="local",
            stream_url=f"/api/v1/videos/{video.video_id}/media",
            reason="本地媒体可直接播放。",
        )
    if str(video.platform or "").lower() != "bilibili":
        return VideoDirectMediaResponse(reason="当前仅为 Bilibili 尝试直出底层流。")

    source_url = _resolve_video_source_url(video, page_number)
    if not source_url:
        return VideoDirectMediaResponse(reason="当前视频缺少可解析的来源链接。")

    info = _extract_direct_media_info(source_url)
    selected_video, selected_audio = _select_mux_media_formats(info)
    if selected_video and selected_audio:
        return VideoDirectMediaResponse(
            available=True,
            mode="split",
            stream_url=_direct_media_mpd_url(video.video_id, page_number),
            video_url=_direct_media_split_url(video.video_id, page_number, "video"),
            audio_url=_direct_media_split_url(video.video_id, page_number, "audio"),
            format_id=f"{selected_video.get('format_id') or ''}+{selected_audio.get('format_id') or ''}",
            ext="mpd",
            width=_int_or_none(selected_video.get("width")),
            height=_int_or_none(selected_video.get("height")),
            acodec=str(selected_audio.get("acodec") or "") or None,
            vcodec=str(selected_video.get("vcodec") or "") or None,
            reason="找到 Bilibili 音视频分离 DASH 流，将在动态字幕中使用 Shaka DASH 播放器。",
        )

    selected = _select_direct_media_format(info)
    if selected is None:
        return VideoDirectMediaResponse(reason="未找到浏览器可直接播放的底层视频流。")

    return VideoDirectMediaResponse(
        available=True,
        mode="direct",
        stream_url=f"/api/v1/videos/{video.video_id}/direct-media/stream?page_number={int(page_number or 1)}",
        format_id=str(selected.get("format_id") or "") or None,
        ext=str(selected.get("ext") or "") or None,
        width=_int_or_none(selected.get("width")),
        height=_int_or_none(selected.get("height")),
        acodec=str(selected.get("acodec") or "") or None,
        vcodec=str(selected.get("vcodec") or "") or None,
        reason="找到可由浏览器直接播放的音视频合一流。",
    )


def _select_aggregate_source_tasks(video: VideoAssetRecord, tasks, page_numbers: list[int] | None):
    requested_pages = set(page_numbers) if page_numbers is not None else None
    page_titles = {page.page: page.title for page in video.pages}
    latest_completed_by_page = {}
    for task in tasks:
        page_number = _task_page_number(task)
        if page_number <= 0:
            continue
        if requested_pages is not None and page_number not in requested_pages:
            continue
        if task.status.value != "completed" or task.result is None:
            continue
        if not _has_aggregate_summary_material(task.result):
            continue
        if page_number not in page_titles:
            continue
        latest_completed_by_page.setdefault(page_number, task)
    return [
        latest_completed_by_page[page_number]
        for page_number in sorted(latest_completed_by_page)
    ]


def _build_aggregate_summary_payload(
    video: VideoAssetRecord,
    source_tasks,
) -> tuple[str, str, list[dict[str, object]]]:
    title = f"{video.title}{AGGREGATE_SUMMARY_TITLE_SUFFIX}"
    transcript_parts: list[str] = []
    segments: list[dict[str, object]] = []

    # 根据总 P 数动态调整每 P 的压缩限制
    page_count = len(source_tasks)
    if page_count <= 20:
        overview_limit = 520
        key_point_limit = 160
        chapter_limit = 180
        note_limit = 360
        max_key_points_per_page = 8
        max_chapters_per_page = 8
    elif page_count <= 40:
        overview_limit = 400
        key_point_limit = 120
        chapter_limit = 140
        note_limit = 280
        max_key_points_per_page = 6
        max_chapters_per_page = 6
    elif page_count <= 60:
        overview_limit = 300
        key_point_limit = 100
        chapter_limit = 100
        note_limit = 200
        max_key_points_per_page = 4
        max_chapters_per_page = 4
    else:
        overview_limit = 200
        key_point_limit = 80
        chapter_limit = 70
        note_limit = 140
        max_key_points_per_page = 3
        max_chapters_per_page = 3

    for task in source_tasks:
        result = task.result
        assert result is not None
        page_number = _task_page_number(task)
        page_title = task.page_title or task.task_input.title or f"P{page_number}"
        key_points = [
            _compact_text(item, key_point_limit)
            for item in result.key_points
            if str(item).strip()
        ][:max_key_points_per_page]
        timeline = [item for item in result.timeline if isinstance(item, dict)]
        segment_summaries = [
            _compact_text(item, chapter_limit)
            for item in result.segment_summaries
            if str(item).strip()
        ]
        note = _compact_text(result.knowledge_note_markdown, note_limit)
        overview = _compact_text(result.overview, overview_limit)

        chapter_fragments: list[str] = []
        for chapter in timeline[:max_chapters_per_page]:
            chapter_title = str(chapter.get("title") or "").strip() or "章节"
            chapter_summary = _compact_text(chapter.get("summary"), chapter_limit)
            if chapter_summary:
                chapter_fragments.append(f"{chapter_title}：{chapter_summary}")

        section_lines = [f"## P{page_number} {page_title}"]
        if overview:
            section_lines.append(f"[重点-概览] {overview}")
        if key_points:
            section_lines.append(f"[重点-要点] {'；'.join(key_points)}")
        if chapter_fragments:
            section_lines.append(f"[重点-章节] {'；'.join(chapter_fragments)}")
        elif segment_summaries:
            section_lines.append(
                f"[重点-片段] {'；'.join(segment_summaries[:max_chapters_per_page])}"
            )
        if note:
            section_lines.append(f"[重点-笔记] {note}")

        section_text = "\n".join(section_lines).strip()
        transcript_parts.append(section_text)
        segments.append(
            {
                "start": float(page_number),
                "end": float(page_number),
                "text": f"P{page_number} {page_title}：{overview or page_title}",
            }
        )

        for chapter in timeline[:max_chapters_per_page]:
            chapter_summary = _compact_text(chapter.get("summary"), chapter_limit)
            if not chapter_summary:
                continue
            chapter_title = str(chapter.get("title") or "").strip() or "章节"
            segments.append(
                {
                    "start": float(page_number),
                    "end": float(page_number),
                    "text": f"P{page_number} {page_title} - {chapter_title}\n{chapter_summary}",
                }
            )

    return title, "\n\n".join(transcript_parts).strip(), segments


def _create_video_task_record(
    *,
    app_state,
    task_store: SqliteTaskRepository,
    video: VideoAssetRecord,
    page_number: int | None = None,
    visual_note_mode: str | None = None,
):
    page = resolve_video_page(video, page_number)
    if video.pages and page_number is not None and page is None:
        raise HTTPException(status_code=400, detail="Selected page not found.")

    source_url = page.source_url if page else video.source_url
    title = page.title if page else video.title
    logger.info(
        "create video task video_id=%s page=%s title=%s source=%s visual_note_mode=%s",
        video.video_id,
        page.page if page else None,
        title,
        source_url,
        visual_note_mode,
    )
    input_type = InputType.URL
    if str(video.platform or "").lower() == "local":
        input_type = infer_local_input_type(source_url)
    task_input = TaskInput(input_type=input_type, source=source_url, title=title, platform_hint=video.platform)
    if visual_note_mode is not None:
        task_input.options.visual_note_mode = visual_note_mode
    record = task_store.create_task(
        task_input,
        video_id=video.video_id,
        page_number=page.page if page else None,
        page_title=title,
    )
    submit_task_or_queue(app_state, task_store, record)
    refreshed = task_store.get_task(record.task_id)
    assert refreshed is not None
    return refreshed


def _create_resummary_task_record(
    *,
    app_state,
    task_store: SqliteTaskRepository,
    video: VideoAssetRecord,
    source_task,
):
    if source_task.video_id != video.video_id:
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
        page_number=source_task.page_number,
        page_title=source_task.page_title or source_task.task_input.title or video.title,
    )
    submit_task_or_queue(app_state, task_store, record)
    refreshed = task_store.get_task(record.task_id)
    assert refreshed is not None
    return refreshed


def normalize_uploaded_media_filename(filename: str) -> tuple[str, str]:
    raw_name = Path(str(filename or "").strip()).name
    if not raw_name:
        raise HTTPException(status_code=400, detail="缺少有效文件名。")
    suffix = Path(raw_name).suffix.lower()
    if not suffix or not is_supported_local_media_file(Path(raw_name)):
        raise HTTPException(status_code=400, detail="当前仅支持导入常见本地视频或音频文件。")
    title = Path(raw_name).stem.strip() or "本地媒体"
    return title, suffix


async def cache_uploaded_media_file(request: Request, filename: str) -> tuple[Path, str, str]:
    title, suffix = normalize_uploaded_media_filename(filename)
    LOCAL_MEDIA_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = LOCAL_MEDIA_UPLOAD_DIR / f"{uuid4().hex}.upload"
    digest = hashlib.sha1()
    total_bytes = 0
    try:
        with temp_path.open("wb") as handle:
            async for chunk in request.stream():
                if not chunk:
                    continue
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8")
                handle.write(chunk)
                digest.update(chunk)
                total_bytes += len(chunk)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="保存上传视频时失败。") from exc

    if total_bytes <= 0:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("failed to remove empty upload temp file: %s", temp_path, exc_info=True)
        raise HTTPException(status_code=400, detail="上传文件为空。")

    content_hash = digest.hexdigest()
    final_path = LOCAL_MEDIA_UPLOAD_DIR / f"{content_hash}{suffix}"
    if final_path.exists():
        try:
            temp_path.unlink()
        except OSError:
            logger.warning("failed to remove duplicate upload temp file: %s", temp_path, exc_info=True)
    else:
        try:
            temp_path.replace(final_path)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="整理上传视频文件时失败。") from exc
    return final_path.resolve(), title, content_hash


@router.post("/{video_id}/favorite", response_model=VideoAssetDetailResponse)
def set_video_favorite(video_id: str, payload: dict[str, bool], request: Request) -> VideoAssetDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    updated = task_store.set_video_favorite(video_id, bool(payload.get("is_favorite")))
    if updated is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    return localize_video_cover(task_store, updated).to_detail()


@router.post("/probe", response_model=VideoProbeResponse)
def probe_video(request: VideoProbeRequest, app_request: Request) -> VideoProbeResponse:
    task_store: SqliteTaskRepository = app_request.app.state.task_repository
    logger.info("probe video url=%s force_refresh=%s", request.url, request.force_refresh)
    probed, pages, requires_selection = probe_video_asset(request.url, request.force_refresh)
    existing = task_store.get_video_asset_by_canonical_id(probed.canonical_id)
    cached = existing is not None and not request.force_refresh
    asset = existing if cached else task_store.upsert_video_asset(merge_video_asset_metadata(existing, probed) if existing else probed)
    asset = localize_video_cover(task_store, asset)
    return VideoProbeResponse(
        video=asset.to_summary(),
        cached=cached,
        requires_selection=requires_selection,
        pages=asset.pages or pages,
    )


@router.post("/upload", response_model=VideoProbeResponse)
async def upload_local_video(
    request: Request,
    filename: str = Query(..., min_length=1),
) -> VideoProbeResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    saved_path, title, content_hash = await cache_uploaded_media_file(request, filename)
    logger.info("upload local media filename=%s saved_path=%s", filename, saved_path)
    probed = probe_local_video_asset(
        saved_path,
        title_override=title,
        canonical_id_override=f"local-upload-{content_hash[:24]}",
    )
    existing = task_store.get_video_asset_by_canonical_id(probed.canonical_id)
    cached = existing is not None
    asset = existing if cached else task_store.upsert_video_asset(probed)
    asset = localize_video_cover(task_store, asset)
    return VideoProbeResponse(
        video=asset.to_summary(),
        cached=cached,
        requires_selection=False,
        pages=[],
    )


@router.get("", response_model=list[VideoAssetSummaryResponse])
def list_videos(request: Request) -> list[VideoAssetSummaryResponse]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    return [localize_video_cover(task_store, video).to_summary() for video in task_store.list_video_assets()]


@router.get("/{video_id}", response_model=VideoAssetDetailResponse)
def get_video(video_id: str, request: Request) -> VideoAssetDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    return localize_video_cover(task_store, video).to_detail()


@router.get("/{video_id}/media")
def get_local_video_media(video_id: str, request: Request) -> FileResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    if str(video.platform or "").lower() != "local":
        raise HTTPException(status_code=400, detail="当前视频不支持本地播放器。")

    source_path = Path(str(video.source_url or "")).expanduser()
    try:
        resolved_path = source_path.resolve()
    except OSError:
        resolved_path = source_path
    if not resolved_path.exists() or not resolved_path.is_file():
        raise HTTPException(status_code=404, detail="本地视频文件不存在或已被移动。")
    if not is_supported_local_media_file(resolved_path):
        raise HTTPException(status_code=400, detail="当前文件类型不支持本地播放器。")

    media_type = None
    suffix = resolved_path.suffix.lower()
    if suffix == ".mp4":
        media_type = "video/mp4"
    elif suffix == ".webm":
        media_type = "video/webm"
    elif suffix in {".mov", ".m4v"}:
        media_type = "video/quicktime"
    elif suffix == ".ogg":
        media_type = "audio/ogg"
    elif suffix == ".mp3":
        media_type = "audio/mpeg"
    return FileResponse(resolved_path, media_type=media_type, filename=resolved_path.name)


@router.get("/{video_id}/direct-media/status", response_model=VideoDirectMediaResponse)
def get_video_direct_media_status(
    video_id: str,
    request: Request,
    page_number: int | None = None,
) -> VideoDirectMediaResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    return _direct_media_status(video, page_number)


@router.get("/{video_id}/direct-media/manifest.mpd")
def get_video_direct_media_manifest(
    video_id: str,
    request: Request,
    page_number: int | None = None,
) -> Response:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    if str(video.platform or "").lower() != "bilibili":
        raise HTTPException(status_code=400, detail="当前仅支持 Bilibili 底层 DASH 播放。")

    source_url = _resolve_video_source_url(video, page_number)
    if not source_url:
        raise HTTPException(status_code=400, detail="当前视频缺少可解析的来源链接。")
    info = _extract_direct_media_info(source_url)
    selected_video, selected_audio = _select_mux_media_formats(info)
    if not selected_video or not selected_audio:
        raise HTTPException(status_code=404, detail="未找到可用于 DASH 播放的 Bilibili 音视频分轨。")

    manifest = _build_direct_media_mpd(
        video=video,
        page_number=page_number,
        info=info,
        selected_video=selected_video,
        selected_audio=selected_audio,
    )
    return Response(
        content=manifest,
        media_type="application/dash+xml",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/{video_id}/direct-media/track/{track}")
def stream_video_direct_media_track(
    video_id: str,
    track: str,
    request: Request,
    page_number: int | None = None,
) -> StreamingResponse:
    if track not in {"video", "audio"}:
        raise HTTPException(status_code=404, detail="Unknown direct media track.")
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    if str(video.platform or "").lower() != "bilibili":
        raise HTTPException(status_code=400, detail="当前仅支持 Bilibili 底层分轨播放。")

    source_url = _resolve_video_source_url(video, page_number)
    if not source_url:
        raise HTTPException(status_code=400, detail="当前视频缺少可解析的来源链接。")

    info = _extract_direct_media_info(source_url)
    selected_video, selected_audio = _select_mux_media_formats(info)
    selected = selected_video if track == "video" else selected_audio
    direct_url = _streamable_http_url(selected or {})
    if not direct_url:
        raise HTTPException(status_code=404, detail="底层分轨地址已失效，请刷新后重试。")

    headers = dict(BILIBILI_DIRECT_MEDIA_HEADERS)
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header
    cookies = _load_ydl_cookies()

    client = httpx.Client(timeout=httpx.Timeout(connect=20.0, read=None, write=20.0, pool=20.0), follow_redirects=True)
    try:
        upstream = client.stream("GET", direct_url, headers=headers, cookies=cookies)
        response = upstream.__enter__()
    except httpx.HTTPError as exc:
        client.close()
        raise HTTPException(status_code=502, detail=f"底层分轨连接失败：{exc}") from exc

    response_headers = {
        key: value
        for key, value in response.headers.items()
        if key.lower() in {"content-length", "content-range", "accept-ranges"}
    }
    response_headers["Cache-Control"] = "public, max-age=300"
    content_type = response.headers.get("content-type")
    if not content_type:
        content_type = "video/mp4" if track == "video" else "audio/mp4"

    def iterator():
        try:
            for chunk in response.iter_bytes():
                if chunk:
                    yield chunk
        finally:
            upstream.__exit__(None, None, None)
            client.close()

    return StreamingResponse(
        iterator(),
        status_code=response.status_code,
        media_type=content_type,
        headers=response_headers,
    )


@router.get("/{video_id}/direct-media/stream")
def stream_video_direct_media(
    video_id: str,
    request: Request,
    page_number: int | None = None,
) -> StreamingResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")

    status_payload = _direct_media_status(video, page_number)
    if not status_payload.available or status_payload.mode not in {"direct", "muxed"}:
        raise HTTPException(status_code=400, detail=status_payload.reason or "当前视频没有可直出的底层流。")

    source_url = _resolve_video_source_url(video, page_number)
    info = _extract_direct_media_info(source_url)
    selected = _select_direct_media_format(info)
    if status_payload.mode == "direct":
        direct_url = str((selected or {}).get("url") or "").strip()
        if not direct_url:
            raise HTTPException(status_code=404, detail="底层流地址已失效，请刷新后重试。")

        headers = dict(BILIBILI_DIRECT_MEDIA_HEADERS)
        range_header = request.headers.get("range")
        if range_header:
            headers["Range"] = range_header
        cookies = _load_ydl_cookies()

        client = httpx.Client(timeout=httpx.Timeout(connect=20.0, read=None, write=20.0, pool=20.0), follow_redirects=True)
        try:
            upstream = client.stream("GET", direct_url, headers=headers, cookies=cookies)
            response = upstream.__enter__()
        except httpx.HTTPError as exc:
            client.close()
            raise HTTPException(status_code=502, detail=f"底层流连接失败：{exc}") from exc

        response_headers = {
            key: value
            for key, value in response.headers.items()
            if key.lower() in {"content-length", "content-range", "accept-ranges"}
        }
        media_type = response.headers.get("content-type") or "video/mp4"

        def direct_iterator():
            try:
                for chunk in response.iter_bytes():
                    if chunk:
                        yield chunk
            finally:
                upstream.__exit__(None, None, None)
                client.close()

        return StreamingResponse(
            direct_iterator(),
            status_code=response.status_code,
            media_type=media_type,
            headers=response_headers,
        )

    selected_video, selected_audio = _select_mux_media_formats(info)
    if not selected_video or not selected_audio:
        raise HTTPException(status_code=400, detail="Bilibili 音视频分离流无法合流播放。")

    return _muxed_media_stream_response(
        request=request,
        video=video,
        page_number=page_number,
        selected_video=selected_video,
        selected_audio=selected_audio,
    )


@router.delete("/{video_id}")
def delete_video(video_id: str, request: Request) -> dict[str, object]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    tasks = task_store.list_tasks_for_video(video_id)
    deleted = task_store.delete_video_asset(video_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Video not found.")
    cleanup_video_files(video, tasks, settings_manager.current)
    logger.info("delete video video_id=%s", video_id)
    return {"deleted": True, "video_id": video_id}


@router.get("/{video_id}/tasks", response_model=list[TaskSummaryResponse])
def get_video_tasks(video_id: str, request: Request) -> list[TaskSummaryResponse]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    return [task.to_summary() for task in task_store.list_tasks_for_video(video_id)]


@router.post("/{video_id}/tasks", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_video_task(
    request: Request,
    video_id: str,
    request_body: VideoTaskCreateRequest | None = None,
) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    refreshed = _create_video_task_record(
        app_state=request.app.state,
        task_store=task_store,
        video=video,
        page_number=request_body.page_number if request_body else None,
        visual_note_mode=getattr(request_body, "visual_note_mode", None) if request_body else None,
    )
    return refreshed.to_detail()


@router.post("/{video_id}/tasks/resummary", response_model=TaskDetailResponse, status_code=status.HTTP_201_CREATED)
def create_video_resummary_task(video_id: str, body: ResummaryRequest, request: Request) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")

    source_task = _find_resummary_source_task(task_store, video_id, body)
    if source_task is None:
        raise HTTPException(status_code=400, detail="当前视频还没有可复用的转写结果。")

    refreshed = _create_resummary_task_record(
        app_state=request.app.state,
        task_store=task_store,
        video=video,
        source_task=source_task,
    )
    return refreshed.to_detail()


@router.post(
    "/{video_id}/tasks/aggregate-summary",
    response_model=TaskDetailResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_video_aggregate_summary_task(
    video_id: str,
    request: Request,
    body: AggregateSummaryRequest | None = None,
) -> TaskDetailResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")
    if not video.pages:
        raise HTTPException(status_code=400, detail="当前视频不是多 P 视频，无法生成全集总结。")

    requested_pages = body.page_numbers if body and body.page_numbers is not None else None
    if requested_pages is not None:
        _normalize_batch_page_numbers(video, requested_pages)

    source_tasks = _select_aggregate_source_tasks(
        video,
        task_store.list_tasks_for_video(video_id),
        requested_pages,
    )
    if not source_tasks:
        raise HTTPException(status_code=400, detail="还没有可汇总的分 P 摘要，请先生成至少一个分 P 摘要。")

    title, transcript, segments = _build_aggregate_summary_payload(video, source_tasks)
    payload = json.dumps(
        {
            "title": title,
            "source_kind": "aggregate_series",
            "transcript": transcript,
            "segments": segments,
        },
        ensure_ascii=False,
    )
    record = task_store.create_task(
        TaskInput(
            input_type=InputType.TRANSCRIPT_TEXT,
            source=payload,
            title=title,
            platform_hint=video.platform,
        ),
        video_id=video.video_id,
        page_number=AGGREGATE_SUMMARY_PAGE_NUMBER,
        page_title=AGGREGATE_SUMMARY_PAGE_TITLE,
    )
    submit_task_or_queue(request.app.state, task_store, record)
    refreshed = task_store.get_task(record.task_id)
    assert refreshed is not None
    return refreshed.to_detail()


@router.post("/{video_id}/tasks/batch", response_model=VideoTaskBatchResponse, status_code=status.HTTP_201_CREATED)
def create_video_tasks_batch(video_id: str, body: VideoTaskBatchRequest, request: Request) -> VideoTaskBatchResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")

    page_numbers = _normalize_batch_page_numbers(video, body.page_numbers)
    tasks = task_store.list_tasks_for_video(video_id)

    conflict_pages: list[VideoTaskBatchPageResponse] = []
    skipped_pages: list[VideoTaskBatchPageResponse] = []
    created_tasks: list[TaskDetailResponse] = []
    creatable_page_numbers: list[int] = []

    for page_number in page_numbers:
        page = resolve_video_page(video, page_number)
        assert page is not None
        existing_completed_task = _find_latest_completed_task_for_page(tasks, page_number)
        if existing_completed_task is None:
            creatable_page_numbers.append(page_number)
            continue

        conflict_pages.append(
            VideoTaskBatchPageResponse(
                page_number=page_number,
                page_title=page.title,
                action="skip",
                reason="该分 P 已有成功摘要，批量生成将默认跳过。",
                existing_task_id=existing_completed_task.task_id,
                existing_status=existing_completed_task.status,
                has_existing_result=True,
            )
        )

    if conflict_pages and not body.confirm:
        return VideoTaskBatchResponse(
            operation="create",
            requested_page_numbers=page_numbers,
            requires_confirmation=True,
            created_tasks=[],
            skipped_pages=[],
            conflict_pages=conflict_pages,
        )

    if conflict_pages:
        skipped_pages.extend(conflict_pages)

    for page_number in creatable_page_numbers:
        refreshed = _create_video_task_record(
            app_state=request.app.state,
            task_store=task_store,
            video=video,
            page_number=page_number,
        )
        created_tasks.append(refreshed.to_detail())

    return VideoTaskBatchResponse(
        operation="create",
        requested_page_numbers=page_numbers,
        requires_confirmation=False,
        created_tasks=created_tasks,
        skipped_pages=skipped_pages,
        conflict_pages=[],
    )


@router.post("/{video_id}/tasks/resummary/batch", response_model=VideoTaskBatchResponse, status_code=status.HTTP_201_CREATED)
def create_video_resummary_tasks_batch(video_id: str, body: VideoTaskBatchRequest, request: Request) -> VideoTaskBatchResponse:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    video = task_store.get_video_asset(video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="Video not found.")

    page_numbers = _normalize_batch_page_numbers(video, body.page_numbers)
    conflict_pages: list[VideoTaskBatchPageResponse] = []
    skipped_pages: list[VideoTaskBatchPageResponse] = []
    created_tasks: list[TaskDetailResponse] = []

    source_tasks_by_page = {
        page_number: _find_resummary_source_task(
            task_store,
            video_id,
            ResummaryRequest(page_number=page_number),
        )
        for page_number in page_numbers
    }

    for page_number in page_numbers:
        page = resolve_video_page(video, page_number)
        assert page is not None
        source_task = source_tasks_by_page[page_number]
        if source_task is None:
            skipped_pages.append(
                VideoTaskBatchPageResponse(
                    page_number=page_number,
                    page_title=page.title,
                    action="skip",
                    reason="该分 P 暂无可复用的转写与摘要结果。",
                    has_existing_result=False,
                )
            )
            continue

        conflict_pages.append(
            VideoTaskBatchPageResponse(
                page_number=page_number,
                page_title=page.title,
                action="rerun",
                reason="该分 P 已有成功摘要，确认后将复用转写重新生成摘要。",
                existing_task_id=source_task.task_id,
                existing_status=source_task.status,
                has_existing_result=True,
            )
        )

    if conflict_pages and not body.confirm:
        return VideoTaskBatchResponse(
            operation="resummary",
            requested_page_numbers=page_numbers,
            requires_confirmation=True,
            created_tasks=[],
            skipped_pages=skipped_pages,
            conflict_pages=conflict_pages,
        )

    for page_number in page_numbers:
        source_task = source_tasks_by_page[page_number]
        if source_task is None:
            continue
        refreshed = _create_resummary_task_record(
            app_state=request.app.state,
            task_store=task_store,
            video=video,
            source_task=source_task,
        )
        created_tasks.append(refreshed.to_detail())

    return VideoTaskBatchResponse(
        operation="resummary",
        requested_page_numbers=page_numbers,
        requires_confirmation=False,
        created_tasks=created_tasks,
        skipped_pages=skipped_pages,
        conflict_pages=[],
    )
