from pathlib import Path

from video_sum_infra.config import ServiceSettings
from video_sum_infra.prompt_library import PromptPreset, save_custom_preset
from video_sum_service.routers import system as system_router
from video_sum_service.schemas import PromptMatchRequest, PromptPresetCreateRequest


def test_prompt_api_crud_and_match(monkeypatch, tmp_path: Path) -> None:
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        prompt_presets_path=str(tmp_path / "prompt_presets.json"),
    )
    monkeypatch.setattr(system_router.settings_manager, "_settings", settings)

    created = system_router.save_prompt_preset(
        PromptPresetCreateRequest(
            name="Pytest Notes",
            description="测试类视频",
            category="learning",
            system_prompt="system",
            user_prompt_template="user {title} {transcript} {segments_json}",
            auto_match_keywords=["pytest"],
        )
    )
    matched = system_router.match_prompt_preset(PromptMatchRequest(title="pytest fixtures 教程"))
    listed = system_router.list_prompt_presets()
    deleted = system_router.delete_prompt_preset(created.id)

    assert created.id == "pytest_notes"
    assert created.is_builtin is False
    assert matched.preset.id == "pytest_notes"
    assert matched.match_type == "keyword"
    assert any(preset.id == "pytest_notes" for preset in listed)
    assert deleted == {"deleted": True, "preset_id": "pytest_notes"}

def test_legacy_custom_prompt_preset_is_not_builtin(monkeypatch, tmp_path: Path) -> None:
    preset_path = tmp_path / "prompt_presets.json"
    settings = ServiceSettings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        tasks_dir=tmp_path / "tasks",
        prompt_presets_path=str(preset_path),
    )
    monkeypatch.setattr(system_router.settings_manager, "_settings", settings)
    save_custom_preset(
        PromptPreset(
            id="custom",
            name="个人预设",
            description="旧版本迁移来的用户预设",
            category="personal",
            system_prompt="system",
            user_prompt_template="user {title} {transcript} {segments_json}",
            auto_match_keywords=["个人"],
        ),
        prompt_presets_path=preset_path,
    )

    listed = system_router.list_prompt_presets()
    custom_preset = next(preset for preset in listed if preset.id == "custom")
    deleted = system_router.delete_prompt_preset("custom")

    assert custom_preset.is_builtin is False
    assert custom_preset.name == "个人预设"
    assert deleted == {"deleted": True, "preset_id": "custom"}
