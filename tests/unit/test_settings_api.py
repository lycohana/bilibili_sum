from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

import video_sum_service.app as service_app
from video_sum_infra.config import ServiceSettings
from video_sum_service.app import (
    app,
    install_local_asr,
    probe_asr_connection,
    probe_llm_connection,
    serialize_settings,
    settings_manager,
    update_settings,
)
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


def test_serialize_settings_includes_persisted_file_flag(monkeypatch, tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
    )
    settings_manager._settings = current
    monkeypatch.setattr(settings_manager, "_settings_path", tmp_path / "data" / "settings.json")

    payload = serialize_settings(current, environment_info={"cudaAvailable": False, "runtimeChannel": "base"})

    assert payload["settings_file_exists"] is False

    settings_manager._settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_manager._settings_path.write_text("{}", encoding="utf-8")

    payload = serialize_settings(current, environment_info={"cudaAvailable": False, "runtimeChannel": "base"})

    assert payload["settings_file_exists"] is True


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


def test_llm_connection_uses_unsaved_payload(monkeypatch, tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        llm_enabled=True,
        llm_base_url="https://old.example/v1",
        llm_api_key="old-key",
        llm_model="old-model",
    )
    settings_manager._settings = current

    calls: list[dict[str, object]] = []

    class FakeResponse:
        status_code = 200
        text = '{"choices":[{"message":{"content":"{\\"ok\\":true,\\"message\\":\\"test\\"}"}}]}'

        def json(self) -> dict[str, object]:
            return {"choices": [{"message": {"content": '{"ok":true,"message":"test"}'}}]}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, headers: dict[str, str], json: dict[str, object]) -> FakeResponse:
            calls.append({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setattr(service_app.httpx, "Client", FakeClient)

    response = probe_llm_connection(
        SettingsUpdatePayload(
            llm_base_url="https://api.example.com/v1",
            llm_api_key="new-key",
            llm_model="new-model",
        )
    )

    assert response["ok"] is True
    assert response["model"] == "new-model"
    assert response["jsonOutputAvailable"] is True
    assert response["jsonPreview"] == '{"ok": true, "message": "test"}'
    assert calls[0]["url"] == "https://api.example.com/v1/chat/completions"
    assert calls[0]["headers"]["Authorization"] == "Bearer new-key"
    assert calls[0]["json"]["model"] == "new-model"


def test_llm_connection_requires_base_url(tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        llm_enabled=True,
        llm_base_url="",
        llm_api_key="test-key",
        llm_model="test-model",
    )
    settings_manager._settings = current

    try:
        probe_llm_connection()
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "请先填写 API Base URL。"
    else:
        raise AssertionError("expected HTTPException")


def test_llm_connection_rejects_invalid_json_response(monkeypatch, tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        llm_enabled=True,
        llm_base_url="https://api.example.com/v1",
        llm_api_key="test-key",
        llm_model="test-model",
    )
    settings_manager._settings = current

    class FakeResponse:
        status_code = 200
        text = '{"choices":[{"message":{"content":"not json"}}]}'

        def json(self) -> dict[str, object]:
            return {"choices": [{"message": {"content": "not json"}}]}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, headers: dict[str, str], json: dict[str, object]) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(service_app.httpx, "Client", FakeClient)

    try:
        probe_llm_connection()
    except HTTPException as exc:
        assert exc.status_code == 502
        assert "未返回合法 JSON" in str(exc.detail)
    else:
        raise AssertionError("expected HTTPException")


def test_asr_connection_uses_unsaved_payload(monkeypatch, tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        siliconflow_asr_base_url="https://old.example/v1",
        siliconflow_asr_api_key="old-key",
        siliconflow_asr_model="old-model",
    )
    settings_manager._settings = current

    calls: list[dict[str, object]] = []

    class FakeResponse:
        status_code = 200
        text = '{"text":"test transcript"}'

        def json(self) -> dict[str, object]:
            return {"text": "test transcript"}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, headers: dict[str, str], data: dict[str, object], files: dict[str, object]) -> FakeResponse:
            calls.append({"url": url, "headers": headers, "data": data, "files": files})
            return FakeResponse()

    monkeypatch.setattr(service_app.httpx, "Client", FakeClient)

    response = probe_asr_connection(
        SettingsUpdatePayload(
            siliconflow_asr_base_url="https://api.example.com/v1",
            siliconflow_asr_api_key="new-key",
            siliconflow_asr_model="new-model",
        )
    )

    assert response["ok"] is True
    assert response["model"] == "new-model"
    assert response["responsePreview"] == "test transcript"
    assert calls[0]["url"] == "https://api.example.com/v1/audio/transcriptions"
    assert calls[0]["headers"]["Authorization"] == "Bearer new-key"
    assert calls[0]["data"]["model"] == "new-model"


def test_asr_connection_requires_api_key(tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        siliconflow_asr_base_url="https://api.example.com/v1",
        siliconflow_asr_api_key="",
        siliconflow_asr_model="TeleAI/TeleSpeechASR",
    )
    settings_manager._settings = current

    try:
        probe_asr_connection()
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "请先填写 SiliconFlow API Key。"
    else:
        raise AssertionError("expected HTTPException")


def test_asr_connection_accepts_empty_transcript_when_endpoint_responds(monkeypatch, tmp_path: Path) -> None:
    current = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        runtime_channel="base",
        siliconflow_asr_base_url="https://api.example.com/v1",
        siliconflow_asr_api_key="test-key",
        siliconflow_asr_model="TeleAI/TeleSpeechASR",
    )
    settings_manager._settings = current

    class FakeResponse:
        status_code = 200
        text = '{"text":""}'

        def json(self) -> dict[str, object]:
            return {"text": ""}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, url: str, headers: dict[str, str], data: dict[str, object], files: dict[str, object]) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(service_app.httpx, "Client", FakeClient)

    response = probe_asr_connection()

    assert response["ok"] is True
    assert "接口已响应，但测试音频未返回文本" in str(response["message"])
    assert response["responsePreview"] == ""
