from __future__ import annotations

from video_sum_core.utils import normalize_video_url
from video_sum_service import app as service_app


class _FakeYoutubeDL:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def __enter__(self) -> "_FakeYoutubeDL":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def extract_info(self, url: str, download: bool = False) -> dict[str, object]:
        return self._payload


def test_normalize_video_url_preserves_requested_page() -> None:
    result = normalize_video_url("https://www.bilibili.com/video/BV1xx411c7mD?p=3")

    assert result.normalized_url == "https://www.bilibili.com/video/BV1xx411c7mD?p=3"
    assert result.canonical_id == "BV1xx411c7mD"
    assert result.platform == "bilibili"
    assert result.page_number == 3


def test_normalize_video_url_accepts_raw_bvid() -> None:
    result = normalize_video_url("BV1xx411c7mD")

    assert result.normalized_url == "https://www.bilibili.com/video/BV1xx411c7mD"
    assert result.canonical_id == "BV1xx411c7mD"
    assert result.platform == "bilibili"


def test_normalize_video_url_accepts_raw_bvid_with_page() -> None:
    result = normalize_video_url("BV1xx411c7mD?p=2")

    assert result.normalized_url == "https://www.bilibili.com/video/BV1xx411c7mD?p=2"
    assert result.canonical_id == "BV1xx411c7mD"
    assert result.platform == "bilibili"
    assert result.page_number == 2


def test_normalize_video_url_accepts_youtube_watch_url() -> None:
    result = normalize_video_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123")

    assert result.normalized_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert result.canonical_id == "dQw4w9WgXcQ"
    assert result.platform == "youtube"
    assert result.page_number is None


def test_normalize_video_url_accepts_youtu_be_and_shorts() -> None:
    short_link = normalize_video_url("https://youtu.be/dQw4w9WgXcQ?t=43")
    shorts_link = normalize_video_url("https://www.youtube.com/shorts/dQw4w9WgXcQ")

    assert short_link.normalized_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert short_link.canonical_id == "dQw4w9WgXcQ"
    assert short_link.platform == "youtube"
    assert shorts_link.normalized_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert shorts_link.canonical_id == "dQw4w9WgXcQ"
    assert shorts_link.platform == "youtube"


def test_probe_video_asset_requires_page_selection_for_multi_page(monkeypatch) -> None:
    payload = {
        "id": "BV1xx411c7mD",
        "title": "测试合集",
        "thumbnail": "https://example.com/cover.jpg",
        "extractor_key": "BiliBili",
        "entries": [
            {"page": 1, "title": "P1 开场", "duration": 61, "thumbnail": "https://example.com/p1.jpg"},
            {"page": 2, "title": "P2 正片", "duration": 95, "thumbnail": "https://example.com/p2.jpg"},
        ],
    }

    monkeypatch.setattr(service_app.video_assets, "YoutubeDL", lambda options: _FakeYoutubeDL(payload))
    monkeypatch.setattr(service_app.video_assets, "cache_cover_image", lambda source_url, canonical_id, referer_url=None: source_url)

    asset, pages, requires_selection = service_app.probe_video_asset("https://www.bilibili.com/video/BV1xx411c7mD")

    assert requires_selection is True
    assert asset.canonical_id == "BV1xx411c7mD"
    assert asset.source_url == "https://www.bilibili.com/video/BV1xx411c7mD"
    assert len(pages) == 2
    assert pages[1].page == 2
    assert pages[1].source_url == "https://www.bilibili.com/video/BV1xx411c7mD?p=2"


def test_probe_video_asset_returns_selected_page_when_page_is_explicit(monkeypatch) -> None:
    payload = {
        "id": "BV1xx411c7mD",
        "title": "测试合集",
        "thumbnail": "https://example.com/cover.jpg",
        "extractor_key": "BiliBili",
        "entries": [
            {"page": 1, "title": "P1 开场", "duration": 61, "thumbnail": "https://example.com/p1.jpg"},
            {"page": 2, "title": "P2 正片", "duration": 95, "thumbnail": "https://example.com/p2.jpg"},
        ],
    }

    monkeypatch.setattr(service_app.video_assets, "YoutubeDL", lambda options: _FakeYoutubeDL(payload))
    monkeypatch.setattr(service_app.video_assets, "cache_cover_image", lambda source_url, canonical_id, referer_url=None: source_url)

    asset, pages, requires_selection = service_app.probe_video_asset("https://www.bilibili.com/video/BV1xx411c7mD?p=2")

    assert requires_selection is False
    assert asset.canonical_id == "BV1xx411c7mD"
    assert asset.source_url == "https://www.bilibili.com/video/BV1xx411c7mD"
    assert asset.title == "测试合集"
    assert asset.pages[1].title == "P2 正片"
    assert len(pages) == 2


def test_probe_video_asset_returns_youtube_single_video(monkeypatch) -> None:
    payload = {
        "id": "dQw4w9WgXcQ",
        "title": "示例 YouTube 视频",
        "thumbnail": "https://example.com/youtube-cover.jpg",
        "duration": 123,
        "extractor_key": "Youtube",
    }

    monkeypatch.setattr(service_app.video_assets, "YoutubeDL", lambda options: _FakeYoutubeDL(payload))
    monkeypatch.setattr(service_app.video_assets, "cache_cover_image", lambda source_url, canonical_id, referer_url=None: source_url)

    asset, pages, requires_selection = service_app.probe_video_asset("https://youtu.be/dQw4w9WgXcQ")

    assert requires_selection is False
    assert asset.canonical_id == "dQw4w9WgXcQ"
    assert asset.platform == "youtube"
    assert asset.source_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert asset.title == "示例 YouTube 视频"
    assert pages == []


def test_probe_video_asset_returns_local_video_from_file_path(monkeypatch, tmp_path) -> None:
    local_file = tmp_path / "本地演示视频.mp4"
    local_file.write_bytes(b"fake-video")

    monkeypatch.setattr(service_app.video_assets, "probe_local_media_duration", lambda path: 93.5)
    monkeypatch.setattr(
        service_app.video_assets,
        "extract_local_video_cover",
        lambda path, canonical_id, duration, force_refresh=False: f"/media/covers/{canonical_id}.jpg",
    )

    asset, pages, requires_selection = service_app.probe_video_asset(str(local_file))

    assert requires_selection is False
    assert pages == []
    assert asset.platform == "local"
    assert asset.title == "本地演示视频"
    assert asset.source_url == str(local_file.resolve())
    assert asset.cover_url.startswith("/media/covers/local-")
    assert asset.duration == 93.5
