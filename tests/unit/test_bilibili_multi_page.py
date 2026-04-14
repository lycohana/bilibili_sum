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
    normalized, canonical = normalize_video_url("https://www.bilibili.com/video/BV1xx411c7mD?p=3")

    assert normalized == "https://www.bilibili.com/video/BV1xx411c7mD?p=3"
    assert canonical == "BV1xx411c7mD"


def test_normalize_video_url_accepts_raw_bvid() -> None:
    normalized, canonical = normalize_video_url("BV1xx411c7mD")

    assert normalized == "https://www.bilibili.com/video/BV1xx411c7mD"
    assert canonical == "BV1xx411c7mD"


def test_normalize_video_url_accepts_raw_bvid_with_page() -> None:
    normalized, canonical = normalize_video_url("BV1xx411c7mD?p=2")

    assert normalized == "https://www.bilibili.com/video/BV1xx411c7mD?p=2"
    assert canonical == "BV1xx411c7mD"


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

    monkeypatch.setattr(service_app, "YoutubeDL", lambda options: _FakeYoutubeDL(payload))
    monkeypatch.setattr(service_app, "cache_cover_image", lambda source_url, canonical_id, referer_url=None: source_url)

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

    monkeypatch.setattr(service_app, "YoutubeDL", lambda options: _FakeYoutubeDL(payload))
    monkeypatch.setattr(service_app, "cache_cover_image", lambda source_url, canonical_id, referer_url=None: source_url)

    asset, pages, requires_selection = service_app.probe_video_asset("https://www.bilibili.com/video/BV1xx411c7mD?p=2")

    assert requires_selection is False
    assert asset.canonical_id == "BV1xx411c7mD"
    assert asset.source_url == "https://www.bilibili.com/video/BV1xx411c7mD"
    assert asset.title == "测试合集"
    assert asset.pages[1].title == "P2 正片"
    assert len(pages) == 2
