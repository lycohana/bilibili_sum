from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from video_sum_infra.config import ServiceSettings
from video_sum_service.app import app, settings_manager
from video_sum_service.auth import ACCESS_TOKEN_ENV, AccessTokenManager, SESSION_COOKIE_NAME
from video_sum_service.auth import is_auth_exempt_path
import video_sum_service.app as service_app
import video_sum_service.routers.system as system_router


@pytest.fixture(autouse=True)
def restore_app_state():
    original_repository = getattr(app.state, "task_repository", None)
    original_worker = getattr(app.state, "task_worker", None)
    original_runtime_startup = getattr(app.state, "runtime_startup", None)
    original_runtime_startup_lock = getattr(app.state, "runtime_startup_lock", None)
    original_runtime_startup_shutdown = getattr(app.state, "runtime_startup_shutdown", None)
    original_pending_mindmap_jobs = getattr(app.state, "pending_mindmap_jobs", None)
    original_settings = settings_manager.current
    original_app_manager = service_app.access_token_manager
    original_router_manager = system_router.access_token_manager
    yield
    app.state.task_repository = original_repository
    app.state.task_worker = original_worker
    app.state.runtime_startup = original_runtime_startup
    app.state.runtime_startup_lock = original_runtime_startup_lock
    app.state.runtime_startup_shutdown = original_runtime_startup_shutdown
    app.state.pending_mindmap_jobs = original_pending_mindmap_jobs
    settings_manager._settings = original_settings
    service_app.access_token_manager = original_app_manager
    system_router.access_token_manager = original_router_manager


def test_access_token_manager_accepts_short_env_token() -> None:
    manager = AccessTokenManager(Path("unused"), env={ACCESS_TOKEN_ENV: "abc"})

    assert manager.get_token() == "abc"
    assert manager.verify("abc") is True
    assert manager.verify("wrong") is False


def test_access_token_manager_generates_and_reuses_token(tmp_path: Path) -> None:
    manager = AccessTokenManager(tmp_path, env={})
    token = manager.get_token()

    assert len(token) > 20
    assert manager.token_file.exists()
    assert AccessTokenManager(tmp_path, env={}).get_token() == token


def test_api_requires_access_token(monkeypatch) -> None:
    manager = AccessTokenManager(Path("unused"), env={ACCESS_TOKEN_ENV: "test-token"})
    monkeypatch.setattr(service_app, "access_token_manager", manager)
    monkeypatch.setattr(system_router, "access_token_manager", manager)

    with TestClient(app) as client:
        response = client.get("/api/v1/settings")
        assert response.status_code == 401

        response = client.get("/api/v1/settings", headers={"Authorization": "Bearer test-token"})
        assert response.status_code == 200


def test_visual_evidence_media_path_is_auth_exempt_for_image_tags() -> None:
    assert is_auth_exempt_path("/api/v1/tasks/task-1/visual-evidence/media/f0001.jpg", "GET") is True
    assert is_auth_exempt_path("/api/v1/tasks/task-1/visual-evidence", "GET") is False
    assert is_auth_exempt_path("/api/v1/tasks/task-1/visual-evidence/media/f0001.jpg", "POST") is False


def test_auth_session_cookie_allows_api_access(monkeypatch) -> None:
    manager = AccessTokenManager(Path("unused"), env={ACCESS_TOKEN_ENV: "short"})
    monkeypatch.setattr(service_app, "access_token_manager", manager)
    monkeypatch.setattr(system_router, "access_token_manager", manager)

    with TestClient(app) as client:
        login = client.post("/api/v1/auth/session", headers={"Authorization": "Bearer short"})
        assert login.status_code == 200
        assert login.cookies.get(SESSION_COOKIE_NAME) == "short"

        response = client.get("/api/v1/settings")
        assert response.status_code == 200


def test_settings_do_not_echo_provider_api_keys(monkeypatch, tmp_path: Path) -> None:
    manager = AccessTokenManager(Path("unused"), env={ACCESS_TOKEN_ENV: "test-token"})
    monkeypatch.setattr(service_app, "access_token_manager", manager)
    monkeypatch.setattr(system_router, "access_token_manager", manager)

    settings_manager._settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        siliconflow_asr_api_key="asr-secret",
        llm_api_key="llm-secret",
        knowledge_llm_api_key="knowledge-secret",
    )

    with TestClient(app) as client:
        response = client.get("/api/v1/settings", headers={"Authorization": "Bearer test-token"})
        assert response.status_code == 200
        payload = response.json()

    assert payload["siliconflow_asr_api_key"] == ""
    assert payload["llm_api_key"] == ""
    assert payload["knowledge_llm_api_key"] == ""
    assert payload["siliconflow_asr_api_key_configured"] is True
    assert payload["llm_api_key_configured"] is True
    assert payload["knowledge_llm_api_key_configured"] is True
