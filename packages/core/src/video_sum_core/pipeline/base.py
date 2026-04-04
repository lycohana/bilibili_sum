from typing import Callable

from pydantic import BaseModel, Field

from video_sum_core.models.tasks import TaskInput, TaskResult


class PipelineEvent(BaseModel):
    stage: str
    progress: int = 0
    message: str
    payload: dict[str, object] = Field(default_factory=dict)


class PipelineContext(BaseModel):
    task_id: str
    task_input: TaskInput


PipelineEventReporter = Callable[[PipelineEvent], None]


class PipelineRunner:
    """Minimal orchestration contract for future pipeline implementations."""

    def run(
        self,
        context: PipelineContext,
        on_event: PipelineEventReporter | None = None,
    ) -> tuple[list[PipelineEvent], TaskResult]:
        event = PipelineEvent(
            stage="accepted",
            progress=0,
            message="Pipeline scaffold is ready. Processing implementation is pending.",
        )
        if on_event is not None:
            on_event(event)
        result = TaskResult()
        return [event], result
