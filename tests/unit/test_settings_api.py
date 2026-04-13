from __future__ import annotations

from pathlib import Path

import video_sum_service.app as service_app
from video_sum_infra.config import ServiceSettings
from video_sum_service.app import app, install_local_asr, settings_manager, update_settings
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


def test_install_local_asr_refreshes_environment(monkeypatch, tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
    )
    settings_manager._settings = current
    app.state.task_repository = object()
    app.state.task_worker = object()

    monkeypatch.setattr("video_sum_service.app.ensure_runtime_channel", lambda runtime_channel: tmp_path / runtime_channel)
    monkeypatch.setattr("video_sum_service.app.runtime_python_executable", lambda runtime_channel: tmp_path / "python.exe")
    monkeypatch.setattr("video_sum_service.app._install_workspace_packages", lambda python_executable, runtime_channel: None)
    monkeypatch.setattr("video_sum_service.app._ensure_runtime_pip", lambda python_executable, runtime_channel: None)
    monkeypatch.setattr(
        "video_sum_service.app._run_command",
        lambda command, runtime_channel, timeout=1800: type("Result", (), {"stdout": "ok", "stderr": ""})(),
    )
    monkeypatch.setattr("video_sum_service.app.clear_environment_probe_cache", lambda runtime_channel=None: None)
    monkeypatch.setattr(
        "video_sum_service.app.detect_environment",
        lambda runtime_channel=None: {
            "runtimeChannel": runtime_channel or "base",
            "localAsrInstalled": True,
            "localAsrAvailable": True,
            "localAsrVersion": "1.1.1",
        },
    )
    monkeypatch.setattr(
        "video_sum_service.app.build_worker",
        lambda repository, current_settings, environment_info=None: {
            "repository": repository,
            "environment": environment_info,
        },
    )
    monkeypatch.setattr("video_sum_service.app.write_runtime_metadata", lambda runtime_channel, payload: None)

    response = install_local_asr()

    assert response["installed"] is True
    assert response["runtimeChannel"] == "base"
    assert response["environment"]["localAsrVersion"] == "1.1.1"


def test_install_workspace_packages_bootstraps_hatchling_before_local_packages(
    monkeypatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []

    monkeypatch.setattr(service_app, "is_frozen", lambda: False)
    monkeypatch.setattr(service_app, "_ensure_runtime_pip", lambda python_executable, runtime_channel: None)
    monkeypatch.setattr(service_app, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(
        service_app,
        "_run_command",
        lambda command, runtime_channel, timeout=1800: commands.append(command) or type("Result", (), {"stdout": "", "stderr": ""})(),
    )

    service_app._install_workspace_packages(tmp_path / "python.exe", runtime_channel="gpu-cu128")

    assert len(commands) == 2
    assert commands[0][:7] == [
        str(tmp_path / "python.exe"),
        "-m",
        "pip",
        "install",
        "--upgrade",
        "pip",
        "setuptools",
    ]
    assert "wheel" in commands[0]
    assert "hatchling>=1.27.0" in commands[0]
    assert commands[1][:5] == [
        str(tmp_path / "python.exe"),
        "-m",
        "pip",
        "install",
        "--no-build-isolation",
    ]
    assert str(tmp_path / "packages" / "infra") in commands[1]
    assert str(tmp_path / "packages" / "core") in commands[1]
    assert str(tmp_path / "apps" / "service") in commands[1]
