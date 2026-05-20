from pathlib import Path

from video_sum_core.pipeline.real import PipelineSettings, RealPipelineRunner
from video_sum_infra.prompt_library import (
    DEFAULT_PRESET_ID,
    PromptPreset,
    delete_custom_preset,
    load_presets,
    match_preset,
    save_custom_preset,
)


def test_prompt_library_persists_custom_presets_and_matches_keywords(tmp_path: Path) -> None:
    preset_path = tmp_path / "prompt_presets.json"
    preset = PromptPreset(
        id="pytest_notes",
        name="Pytest 笔记",
        description="测试学习内容",
        category="learning",
        system_prompt="system",
        user_prompt_template="用户模板 {title} {transcript} {segments_json}",
        auto_match_keywords=["pytest", "单元测试"],
    )

    presets = save_custom_preset(preset, prompt_presets_path=preset_path)

    assert any(item.id == DEFAULT_PRESET_ID for item in presets)
    assert load_presets(prompt_presets_path=preset_path)[-1].id == "pytest_notes"
    assert match_preset("pytest fixture 教程", prompt_presets_path=preset_path).id == "pytest_notes"
    assert match_preset("普通视频", prompt_presets_path=preset_path).id == DEFAULT_PRESET_ID

    remaining = delete_custom_preset("pytest_notes", prompt_presets_path=preset_path)

    assert all(item.id != "pytest_notes" for item in remaining)


def test_pipeline_resolves_prompt_preset_overrides(tmp_path: Path) -> None:
    preset_path = tmp_path / "prompt_presets.json"
    save_custom_preset(
        PromptPreset(
            id="custom_summary",
            name="个人摘要",
            description="",
            category="custom",
            system_prompt="custom system",
            user_prompt_template="custom user {title} {transcript} {segments_json}",
            auto_match_keywords=[],
        ),
        prompt_presets_path=preset_path,
    )
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=tmp_path / "tasks",
            data_dir=tmp_path,
            prompt_presets_path=str(preset_path),
            summary_system_prompt="settings system",
            summary_user_prompt_template="settings user {title} {transcript} {segments_json}",
        )
    )

    system_prompt, user_prompt = runner._resolve_prompt("custom_summary")
    messages = runner._build_summary_messages(
        "标题",
        "转写",
        "分段",
        system_prompt_override=system_prompt,
        user_prompt_override=user_prompt,
    )

    assert messages[0]["content"] == "custom system"
    assert messages[1]["content"] == "custom user 标题 转写 分段"
