from pathlib import Path

import pytest

from video_sum_core.errors import LLMAuthenticationError
from video_sum_core.pipeline.real import PipelineSettings, RealPipelineRunner


def _build_runner() -> RealPipelineRunner:
    return RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            llm_enabled=True,
            llm_api_key="test-key",
            llm_base_url="https://example.com/v1",
            llm_model="test-model",
        )
    )


def test_summarize_falls_back_to_rules_when_llm_auth_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _build_runner()
    transcript = "[00:00] 第一条\n[00:10] 第二条\n[00:20] 第三条"
    segments = [
        {"start": 0, "text": "第一条"},
        {"start": 10, "text": "第二条"},
        {"start": 20, "text": "第三条"},
    ]
    events: list[tuple[str, int, str, dict[str, object] | None]] = []

    def fake_llm_summary(
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
        emit,
    ) -> dict[str, object]:
        raise LLMAuthenticationError("token 已失效")

    monkeypatch.setattr(runner, "_summarize_with_llm", fake_llm_summary)

    summary = runner._summarize(
        transcript=transcript,
        segments=segments,
        title="示例视频",
        emit=lambda stage, progress, message, payload=None: events.append((stage, progress, message, payload)),
    )

    assert summary["title"] == "示例视频"
    assert summary["overview"]
    assert summary["bulletPoints"]
    assert summary["chapters"]
    assert any("已切换为本地规则摘要" in message for _, _, message, _ in events)


def test_summarize_falls_back_to_rules_when_llm_config_is_incomplete() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            llm_enabled=True,
            llm_api_key="test-key",
            llm_base_url="",
            llm_model="",
        )
    )
    transcript = "[00:00] 第一条\n[00:10] 第二条"
    segments = [
        {"start": 0, "text": "第一条"},
        {"start": 10, "text": "第二条"},
    ]

    summary = runner._summarize(
        transcript=transcript,
        segments=segments,
        title="配置缺失示例",
        emit=lambda *_args, **_kwargs: None,
    )

    assert summary["title"] == "配置缺失示例"
    assert summary["overview"]
    assert summary["bulletPoints"]


def test_summarize_emits_partial_result_payloads() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            llm_enabled=True,
            llm_api_key="test-key",
            llm_base_url="https://example.com/v1",
            llm_model="test-model",
        )
    )
    transcript = "[00:00] 第一条\n[00:10] 第二条"
    segments = [
        {"start": 0, "text": "第一条"},
        {"start": 10, "text": "第二条"},
    ]
    events: list[tuple[str, int, str, dict[str, object] | None]] = []

    def fake_llm_summary(
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
        emit,
    ) -> dict[str, object]:
        return {
            "title": title,
            "overview": "整体概览",
            "bulletPoints": ["要点一", "要点二", "要点三", "要点四", "要点五"],
            "chapters": [{"title": "章节一", "start": 0, "summary": "章节摘要"}],
            "chapterGroups": [{"title": "主题一", "start": 0, "summary": "主题摘要", "children": [{"title": "章节一", "start": 0, "summary": "章节摘要"}]}],
        }

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(runner, "_summarize_with_llm", fake_llm_summary)
    monkeypatch.setattr(
        runner,
        "_generate_knowledge_note_with_llm",
        lambda **_kwargs: {
            "knowledgeNoteMarkdown": "# 知识笔记\n\n内容",
            "llm_prompt_tokens": 12,
            "llm_completion_tokens": 8,
            "llm_total_tokens": 20,
        },
    )

    try:
        summary = runner._summarize(
            transcript=transcript,
            segments=segments,
            title="阶段产出示例",
            emit=lambda stage, progress, message, payload=None: events.append((stage, progress, message, payload)),
        )
    finally:
        monkeypatch.undo()

    knowledge_cards_event = next(payload for _, _, message, payload in events if message == "知识卡片摘要生成完成")
    knowledge_note_event = next(payload for _, _, message, payload in events if message == "知识笔记生成完成")

    assert knowledge_cards_event is not None
    assert knowledge_cards_event["result_scope"] == "knowledge_cards"
    assert knowledge_cards_event["result"]["overview"] == "整体概览"
    assert knowledge_cards_event["result"]["knowledge_note_markdown"]
    assert knowledge_note_event is not None
    assert knowledge_note_event["result_scope"] == "knowledge_note"
    assert knowledge_note_event["result"]["knowledge_note_markdown"] == "# 知识笔记\n\n内容"
    assert summary["knowledgeNoteMarkdown"] == "# 知识笔记\n\n内容"
