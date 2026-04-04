from pathlib import Path

from video_sum_core.models.tasks import InputType, TaskInput, TaskStatus
from video_sum_core.pipeline.real import PipelineSettings, RealPipelineRunner
from video_sum_core.pipeline.base import PipelineContext
from video_sum_infra.config import ServiceSettings


def test_task_input_defaults() -> None:
    task_input = TaskInput(input_type=InputType.URL, source="https://example.com/video")

    assert task_input.options.language == "zh"
    assert "json" in task_input.options.export_formats


def test_task_status_values_stable() -> None:
    assert TaskStatus.QUEUED.value == "queued"
    assert TaskStatus.COMPLETED.value == "completed"


def test_pipeline_context_requires_task_id() -> None:
    context = PipelineContext(
        task_id="task-1",
        task_input=TaskInput(input_type=InputType.URL, source="https://example.com/video"),
    )

    assert context.task_id == "task-1"


def test_service_settings_resolve_cuda_runtime() -> None:
    settings = ServiceSettings(
        device_preference="cuda",
        compute_type="auto",
        model_mode="fixed",
        fixed_model="large-v3-turbo",
    )

    model, device, compute_type = settings.resolve_whisper_runtime(cuda_available=True)

    assert model == "large-v3-turbo"
    assert device == "cuda"
    assert compute_type == "float16"


def test_real_pipeline_normalizes_empty_llm_summary() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path(".")))
    transcript = "[00:00] 第一条信息\n[00:10] 第二条信息\n[00:20] 第三条信息"
    segments = [
        {"start": 0.0, "end": 5.0, "text": "第一段内容"},
        {"start": 10.0, "end": 15.0, "text": "第二段内容"},
        {"start": 20.0, "end": 25.0, "text": "第三段内容"},
        {"start": 30.0, "end": 35.0, "text": "第四段内容"},
    ]

    summary = runner._normalize_summary(
        {
            "title": "测试视频",
            "overview": "这是一个测试概览。",
            "bulletPoints": [],
            "chapters": [],
        },
        transcript,
        segments,
        "测试视频",
    )

    assert summary["overview"] == "这是一个测试概览。"
    assert len(summary["bulletPoints"]) >= 1
    assert len(summary["chapters"]) >= 1


def test_real_pipeline_builds_strict_summary_prompt() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path(".")))

    messages = runner._build_summary_messages(
        "测试视频",
        "这是一段转写。",
        '[{"start":0,"text":"第一段"}]',
    )

    assert len(messages) == 2
    assert "json" in messages[0]["content"].lower() or "json" in messages[1]["content"].lower()
    assert "不能返回空数组" in messages[1]["content"]
    assert "bulletPoints 必须是 4 到 6 条中文要点" in messages[1]["content"]
    assert "chapters 必须是 3 到 6 个章节" in messages[1]["content"]


def test_real_pipeline_uses_custom_prompt_template() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("."),
            summary_system_prompt="自定义系统提示词",
            summary_user_prompt_template="标题={title}\n转写={transcript_excerpt}\n分段={segments_excerpt}",
        )
    )

    messages = runner._build_summary_messages("测试标题", "转写内容", "分段内容")

    assert messages[0]["content"] == "自定义系统提示词"
    assert "标题=测试标题" in messages[1]["content"]
    assert "转写=转写内容" in messages[1]["content"]
    assert "分段=分段内容" in messages[1]["content"]


def test_llm_payload_forces_json_keyword_when_custom_prompts_miss_it() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(
            tasks_dir=Path("."),
            summary_system_prompt="你是摘要助手。",
            summary_user_prompt_template="标题={title}\n正文={transcript_excerpt}",
        )
    )

    payload = runner._build_llm_summary_payload("测试标题", "转写内容", "分段内容")
    contents = "\n".join(str(message.get("content") or "") for message in payload["messages"])

    assert "json" in contents.lower()


def test_export_result_preserves_llm_usage() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path(".")))
    task_dir = Path("tests") / "tmp_export_result"
    task_dir.mkdir(parents=True, exist_ok=True)

    result = runner._export_result(
        task_dir=task_dir,
        title="测试标题",
        transcript="转写内容",
        segments=[{"start": 0.0, "end": 1.0, "text": "第一段"}],
        summary={
            "overview": "概览",
            "bulletPoints": ["要点一"],
            "chapters": [{"title": "章节 1", "start": 0.0, "summary": "章节摘要"}],
            "llm_prompt_tokens": 123,
            "llm_completion_tokens": 456,
            "llm_total_tokens": 579,
        },
    )

    assert result.llm_prompt_tokens == 123
    assert result.llm_completion_tokens == 456
    assert result.llm_total_tokens == 579


def test_build_summary_chunks_splits_large_segments() -> None:
    runner = RealPipelineRunner(
        PipelineSettings(tasks_dir=Path("."), summary_chunk_target_chars=80, summary_chunk_overlap_segments=1)
    )
    segments = [
        {
            "start": float(index * 10),
            "text": f"这是第{index}段内容，用来测试分块摘要是否会自动切分。" * 12,
        }
        for index in range(10)
    ]

    chunks = runner._build_summary_chunks(segments)

    assert len(chunks) > 1
    assert all(chunk["transcript"] for chunk in chunks)
    assert all(chunk["segments_json"] for chunk in chunks)


def test_build_aggregate_summary_inputs_collects_partial_summaries() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path(".")))

    transcript, segments_json = runner._build_aggregate_summary_inputs(
        [
            {
                "chunk_index": 1,
                "title": "分块一",
                "overview": "这里是第一块概览。",
                "bulletPoints": ["要点一", "要点二"],
                "chapters": [{"title": "章节 A", "start": 10.0, "summary": "章节摘要 A"}],
            },
            {
                "chunk_index": 2,
                "title": "分块二",
                "overview": "这里是第二块概览。",
                "bulletPoints": ["要点三"],
                "chapters": [{"title": "章节 B", "start": 20.0, "summary": "章节摘要 B"}],
            },
        ]
    )

    assert "分块 1" in transcript
    assert "章节 A" in transcript
    assert "章节摘要 B" in transcript
    assert "章节 A" in segments_json


def test_parse_llm_json_content_accepts_fenced_json() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path(".")))

    parsed = runner._parse_llm_json_content(
        '```json\n{"title":"测试","overview":"概览","bulletPoints":[],"chapters":[]}\n```'
    )

    assert parsed["title"] == "测试"


def test_parse_llm_json_content_accepts_control_characters_with_strict_false() -> None:
    runner = RealPipelineRunner(PipelineSettings(tasks_dir=Path(".")))

    parsed = runner._parse_llm_json_content(
        '{"title":"测试","overview":"第一行\n第二行","bulletPoints":[],"chapters":[]}'
    )

    assert "第一行" in parsed["overview"]
