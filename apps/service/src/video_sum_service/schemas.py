from datetime import datetime, timezone
from uuid import uuid4

from pydantic import BaseModel, Field

from video_sum_core.models.tasks import TaskInput, TaskResult, TaskStatus


class TaskCreateRequest(TaskInput):
    """Initial request model for creating a task."""


class TaskSummaryResponse(BaseModel):
    task_id: str
    status: TaskStatus
    input_type: str
    source: str
    title: str | None = None
    created_at: datetime
    updated_at: datetime


class TaskDetailResponse(TaskSummaryResponse):
    result: TaskResult | None = None
    error_code: str | None = None
    error_message: str | None = None


class TaskEventResponse(BaseModel):
    event_id: str
    task_id: str
    stage: str
    progress: int
    message: str
    created_at: datetime
    payload: dict[str, object] = Field(default_factory=dict)


class TaskRecord(BaseModel):
    task_id: str = Field(default_factory=lambda: uuid4().hex)
    status: TaskStatus = TaskStatus.QUEUED
    task_input: TaskInput
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    result: TaskResult | None = None
    error_code: str | None = None
    error_message: str | None = None

    def to_summary(self) -> TaskSummaryResponse:
        return TaskSummaryResponse(
            task_id=self.task_id,
            status=self.status,
            input_type=self.task_input.input_type.value,
            source=self.task_input.source,
            title=self.task_input.title,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )

    def to_detail(self) -> TaskDetailResponse:
        return TaskDetailResponse(
            **self.to_summary().model_dump(),
            result=self.result,
            error_code=self.error_code,
            error_message=self.error_message,
        )


class TaskEventRecord(BaseModel):
    event_id: str = Field(default_factory=lambda: uuid4().hex)
    task_id: str
    stage: str
    progress: int = 0
    message: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    payload: dict[str, object] = Field(default_factory=dict)

    def to_response(self) -> TaskEventResponse:
        return TaskEventResponse(
            event_id=self.event_id,
            task_id=self.task_id,
            stage=self.stage,
            progress=self.progress,
            message=self.message,
            created_at=self.created_at,
            payload=self.payload,
        )
