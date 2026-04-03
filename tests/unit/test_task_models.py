from video_sum_core.models.tasks import InputType, TaskInput, TaskStatus
from video_sum_core.pipeline.base import PipelineContext


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
