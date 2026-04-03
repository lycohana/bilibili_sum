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


class PipelineRunner:
    """Minimal orchestration contract for future pipeline implementations."""

    def run(self, context: PipelineContext) -> tuple[list[PipelineEvent], TaskResult]:
        event = PipelineEvent(
            stage="accepted",
            progress=0,
            message="Pipeline scaffold is ready. Processing implementation is pending.",
        )
        result = TaskResult()
        return [event], result
