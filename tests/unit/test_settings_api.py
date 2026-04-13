from __future__ import annotations

from pathlib import Path

from video_sum_infra.config import ServiceSettings
from video_sum_service.app import app, settings_manager, update_settings
from video_sum_service.settings_manager import SettingsUpdatePayload


def test_update_settings_reuses_environment_probe(monkeypatch, tmp_path: Path) -> None:
    previous = ServiceSettings(
        data_dir=tmp_path / "data-prev",
        cache_dir=tmp_path / "cache-prev",
        tasks_dir=tmp_path / "tasks-prev",
        runtime_channel="base",
    )
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        llm_enabled=True,
    )
    settings_manager._settings = previous
    monkeypatch.setattr(settings_manager, "save", lambda payload: current)
    app.state.task_repository = object()

    detect_calls: list[str | None] = []

    monkeypatch.setattr("video_sum_service.app.bootstrap_managed_runtime", lambda runtime_channel: None)
    monkeypatch.setattr("video_sum_service.app.prepend_runtime_path", lambda runtime_channel: None)
    monkeypatch.setattr(
        "video_sum_service.app.detect_environment",
        lambda runtime_channel=None: detect_calls.append(runtime_channel) or {"cudaAvailable": False, "runtimeChannel": runtime_channel or "base"},
    )
    monkeypatch.setattr(
        "video_sum_service.app.build_worker",
        lambda repository, current_settings, environment_info=None: {
            "repository": repository,
            "runtime_channel": current_settings.runtime_channel,
            "environment": environment_info,
        },
    )

    response = update_settings(SettingsUpdatePayload(llm_enabled=True))

    assert response["saved"] is True
    assert response["settings"]["runtime_channel"] == "base"
    assert detect_calls == ["base"]

