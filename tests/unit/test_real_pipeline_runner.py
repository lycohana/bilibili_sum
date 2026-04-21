import json
from pathlib import Path

import pytest

from video_sum_core.errors import (
    LLMAuthenticationError,
    TranscriptionAuthenticationError,
    TranscriptionConfigurationError,
    UnsupportedInputError,
)
from video_sum_core.models.tasks import InputType
from video_sum_core.pipeline.base import PipelineContext
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
        source_kind: str | None = None,
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
        source_kind: str | None = None,
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


def test_build_fallback_segments_from_transcript_preserves_order() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path("tests/tmp_tasks")))

    segments = runner._build_fallback_segments_from_transcript(
        "第一句。第二句继续展开。第三句给出结论。",
        duration=30.0,
    )

    assert len(segments) >= 1
    assert segments[0]["start"] == 0.0
    assert float(segments[-1]["end"]) == 30.0
    assert "第一句" in "".join(str(segment["text"]) for segment in segments)


def test_build_fallback_segments_from_long_comma_only_transcript_splits_into_multiple_timestamps() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path("tests/tmp_tasks")))

    transcript = (
        "你的ai正在变得越来越会舔了，那么早期ai最大的问题是幻觉啊，"
        "如果你两三年前用过ai1定会对它的胡言乱语印象深刻，"
        "怕你说啊，这ai加1它等于3，那ai都可能一本正经的回答，"
        "当然，在如今的大模型里，这种离谱的情况已经越来越少了，"
        "但是取而代之的是一种更隐蔽的问题。"
    )

    segments = runner._build_fallback_segments_from_transcript(transcript, duration=75.0)
    rendered = runner._render_transcript_from_segments(segments)

    assert len(segments) >= 3
    assert rendered.count("[") >= 3
    assert "[00:00]" in rendered
    assert "[01:" not in rendered or float(segments[-1]["end"]) <= 75.0


def test_transcribe_uses_siliconflow_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            transcription_provider="siliconflow",
            siliconflow_asr_api_key="test-key",
        )
    )

    called: dict[str, object] = {}

    def fake_siliconflow(
        audio_path: Path,
        duration: float | None,
        emit,
    ) -> tuple[str, list[dict[str, object]]]:
        called["audio_path"] = audio_path
        called["duration"] = duration
        return "mock transcript", [{"start": 0.0, "end": 5.0, "text": "mock"}]

    monkeypatch.setattr(runner, "_transcribe_with_siliconflow", fake_siliconflow)

    transcript, segments = runner._transcribe(Path("sample.mp3"), 12.0, lambda *_args, **_kwargs: None)

    assert transcript == "mock transcript"
    assert segments[0]["text"] == "mock"
    assert called["audio_path"] == Path("sample.mp3")
    assert called["duration"] == 12.0


def test_transcribe_with_siliconflow_requires_api_key() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            transcription_provider="siliconflow",
            siliconflow_asr_api_key="",
        )
    )

    with pytest.raises(TranscriptionConfigurationError, match="API key"):
        runner._transcribe_with_siliconflow(Path("sample.mp3"), 10.0, lambda *_args, **_kwargs: None)


def test_transcribe_with_siliconflow_maps_auth_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            transcription_provider="siliconflow",
            siliconflow_asr_api_key="test-key",
        )
    )
    audio_path = tmp_path / "sample.mp3"
    audio_path.write_bytes(b"fake audio")

    class FakeResponse:
        status_code = 401
        text = '{"error":{"message":"invalid key"}}'

        def json(self) -> dict[str, object]:
            return {"error": {"message": "invalid key"}}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, *args, **kwargs) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr("video_sum_core.pipeline.real.httpx.Client", FakeClient)

    with pytest.raises(TranscriptionAuthenticationError, match="authentication failed"):
        runner._transcribe_with_siliconflow(audio_path, 10.0, lambda *_args, **_kwargs: None)


def test_transcribe_with_local_asr_requires_installed_runtime() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("tests/tmp_tasks"),
            transcription_provider="local",
            local_asr_available=False,
        )
    )

    with pytest.raises(TranscriptionConfigurationError, match="Install local ASR from Settings"):
        runner._transcribe(Path("sample.mp3"), 10.0, lambda *_args, **_kwargs: None)


def test_preflight_checks_llm_before_full_run(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _build_runner()
    events: list[tuple[str, int, str, dict[str, object] | None]] = []

    monkeypatch.setattr(runner, "_preflight_llm_availability", lambda: None)

    runner.preflight(
        PipelineContext(
            task_id="task-1",
            task_input={
                "input_type": InputType.URL,
                "source": "https://www.bilibili.com/video/BV1xx411c7mD",
                "title": "测试视频",
            },
        ),
        on_event=lambda event: events.append((event.stage, event.progress, event.message, event.payload)),
    )

    assert events[0][0] == "preflight"
    assert "正在检查 LLM API 是否可用" in events[0][2]
    assert events[-1][0] == "preflight"
    assert "LLM API 检查通过" in events[-1][2]


def test_run_from_url_accepts_youtube_url(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=tmp_path))
    emitted: list[tuple[str, int, str, dict[str, object] | None]] = []

    monkeypatch.setattr(runner, "_probe_video", lambda _url: {"title": "YouTube 示例", "duration": 30.0})
    monkeypatch.setattr(runner, "_download_audio", lambda *_args, **_kwargs: tmp_path / "sample.mp3")
    monkeypatch.setattr(
        runner,
        "_transcribe",
        lambda *_args, **_kwargs: ("[00:00] 示例", [{"start": 0.0, "end": 3.0, "text": "示例"}]),
    )
    monkeypatch.setattr(
        runner,
        "_export_transcript_snapshot",
        lambda *_args, **_kwargs: type(
            "SnapshotResult",
            (),
            {
                "artifacts": {
                    "transcript_path": str(tmp_path / "transcript.txt"),
                    "summary_path": str(tmp_path / "summary.json"),
                },
                "model_dump": lambda self, mode="json": self.artifacts,
            },
        )(),
    )
    monkeypatch.setattr(
        runner,
        "_summarize",
        lambda *_args, **_kwargs: {
            "overview": "概览",
            "knowledgeNoteMarkdown": "# Note",
            "bulletPoints": [],
            "chapters": [],
            "chapterGroups": [],
        },
    )
    monkeypatch.setattr(
        runner,
        "_export_result",
        lambda *_args, **_kwargs: runner._build_task_result("transcript", {"overview": "概览", "knowledgeNoteMarkdown": "# Note"}),
    )

    result_events, result = runner.run(
        PipelineContext(
            task_id="task-youtube",
            task_input={
                "input_type": InputType.URL,
                "source": "https://youtu.be/dQw4w9WgXcQ",
                "title": None,
            },
        ),
        on_event=lambda event: emitted.append((event.stage, event.progress, event.message, event.payload)),
    )

    assert result.overview == "概览"
    assert emitted[0][0] == "preparing" or result_events[0].stage == "preparing"


def test_run_from_local_video_file_uses_local_media_pipeline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=tmp_path))
    local_video = tmp_path / "sample.mp4"
    local_video.write_bytes(b"fake-video")
    emitted: list[tuple[str, int, str, dict[str, object] | None]] = []

    monkeypatch.setattr(runner, "_prepare_local_audio_source", lambda *_args, **_kwargs: tmp_path / "sample.mp3")
    monkeypatch.setattr(
        runner,
        "_transcribe",
        lambda *_args, **_kwargs: ("[00:00] 本地示例", [{"start": 0.0, "end": 3.0, "text": "本地示例"}]),
    )
    monkeypatch.setattr(
        runner,
        "_export_transcript_snapshot",
        lambda *_args, **_kwargs: type(
            "SnapshotResult",
            (),
            {
                "artifacts": {
                    "transcript_path": str(tmp_path / "transcript.txt"),
                    "summary_path": str(tmp_path / "summary.json"),
                },
                "model_dump": lambda self, mode="json": self.artifacts,
            },
        )(),
    )
    monkeypatch.setattr(
        runner,
        "_summarize",
        lambda *_args, **_kwargs: {
            "overview": "本地概览",
            "knowledgeNoteMarkdown": "# 本地笔记",
            "bulletPoints": [],
            "chapters": [],
            "chapterGroups": [],
        },
    )
    monkeypatch.setattr(
        runner,
        "_export_result",
        lambda *_args, **_kwargs: runner._build_task_result("transcript", {"overview": "本地概览", "knowledgeNoteMarkdown": "# 本地笔记"}),
    )

    result_events, result = runner.run(
        PipelineContext(
            task_id="task-local-video",
            task_input={
                "input_type": InputType.VIDEO_FILE,
                "source": str(local_video),
                "title": "本地示例视频",
            },
        ),
        on_event=lambda event: emitted.append((event.stage, event.progress, event.message, event.payload)),
    )

    assert result.overview == "本地概览"
    assert emitted[0][0] == "preparing" or result_events[0].stage == "preparing"
    assert any("本地视频文件" in message for _, _, message, _ in emitted)


def test_run_from_url_rejects_unsupported_url(tmp_path: Path) -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=tmp_path))

    with pytest.raises(UnsupportedInputError, match="supports Bilibili and YouTube"):
        runner.run(
            PipelineContext(
                task_id="task-unsupported",
                task_input={
                    "input_type": InputType.URL,
                    "source": "https://example.com/video/123",
                    "title": None,
                },
            )
        )


def test_export_transcript_snapshot_creates_resummary_artifacts(tmp_path: Path) -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=tmp_path))

    result = runner._export_transcript_snapshot(
        tmp_path,
        "示例标题",
        "[00:00] 第一条",
        [{"start": 0, "end": 1, "text": "第一条"}],
    )

    assert result.transcript_text == "[00:00] 第一条"
    assert result.artifacts["transcript_path"].endswith("transcript.txt")
    summary_payload = json.loads(Path(result.artifacts["summary_path"]).read_text(encoding="utf-8"))
    assert summary_payload["title"] == "示例标题"
    assert summary_payload["summary"] == {}
    assert summary_payload["segments"][0]["text"] == "第一条"
