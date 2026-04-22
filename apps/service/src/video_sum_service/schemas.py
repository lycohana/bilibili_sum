from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from video_sum_core.models.tasks import MindMapNode, TaskInput, TaskMindMap, TaskResult, TaskStatus
from video_sum_core.utils import extract_bilibili_page


class TaskCreateRequest(TaskInput):
    video_id: str | None = None


class ResummaryRequest(BaseModel):
    task_id: str | None = None
    page_number: int | None = None


class VideoTaskCreateRequest(BaseModel):
    page_number: int | None = None


class VideoTaskBatchRequest(BaseModel):
    page_numbers: list[int] = Field(default_factory=list)
    confirm: bool = False


class AggregateSummaryRequest(BaseModel):
    page_numbers: list[int] | None = None


class TaskMarkdownExportRequest(BaseModel):
    target: Literal["markdown", "obsidian"] = "obsidian"


class VideoTaskBatchPageResponse(BaseModel):
    page_number: int
    page_title: str | None = None
    action: str
    reason: str | None = None
    existing_task_id: str | None = None
    existing_status: TaskStatus | None = None
    has_existing_result: bool = False
    task: "TaskDetailResponse | None" = None


class VideoTaskBatchResponse(BaseModel):
    operation: str
    requested_page_numbers: list[int] = Field(default_factory=list)
    requires_confirmation: bool = False
    created_tasks: list["TaskDetailResponse"] = Field(default_factory=list)
    skipped_pages: list[VideoTaskBatchPageResponse] = Field(default_factory=list)
    conflict_pages: list[VideoTaskBatchPageResponse] = Field(default_factory=list)


class VideoProbeRequest(BaseModel):
    url: str
    force_refresh: bool = False


class VideoPageOptionResponse(BaseModel):
    page: int
    title: str
    source_url: str
    cover_url: str = ""
    duration: float | None = None


class VideoAssetSummaryResponse(BaseModel):
    video_id: str
    canonical_id: str
    platform: str
    title: str
    source_url: str
    cover_url: str = ""
    duration: float | None = None
    latest_task_id: str | None = None
    latest_status: TaskStatus | None = None
    latest_stage: str | None = None
    has_result: bool = False
    is_favorite: bool = False
    favorite_updated_at: datetime | None = None
    pages: list[VideoPageOptionResponse] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class VideoAssetDetailResponse(VideoAssetSummaryResponse):
    latest_result: TaskResult | None = None
    latest_error_message: str | None = None


class VideoAssetRecord(BaseModel):
    video_id: str = Field(default_factory=lambda: uuid4().hex)
    canonical_id: str
    platform: str = "bilibili"
    title: str
    source_url: str
    cover_url: str = ""
    duration: float | None = None
    latest_task_id: str | None = None
    latest_status: TaskStatus | None = None
    latest_stage: str | None = None
    latest_result: TaskResult | None = None
    latest_error_message: str | None = None
    is_favorite: bool = False
    favorite_updated_at: datetime | None = None
    pages: list[VideoPageOptionResponse] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def to_summary(self) -> VideoAssetSummaryResponse:
        return VideoAssetSummaryResponse(
            video_id=self.video_id,
            canonical_id=self.canonical_id,
            platform=self.platform,
            title=self.title,
            source_url=self.source_url,
            cover_url=self.cover_url,
            duration=self.duration,
            latest_task_id=self.latest_task_id,
            latest_status=self.latest_status,
            latest_stage=self.latest_stage,
            has_result=self.latest_result is not None,
            is_favorite=self.is_favorite,
            favorite_updated_at=self.favorite_updated_at,
            pages=self.pages,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )

    def to_detail(self) -> VideoAssetDetailResponse:
        return VideoAssetDetailResponse(
            **self.to_summary().model_dump(),
            latest_result=self.latest_result,
            latest_error_message=self.latest_error_message,
        )


class VideoProbeResponse(BaseModel):
    video: VideoAssetSummaryResponse
    cached: bool = False
    requires_selection: bool = False
    pages: list[VideoPageOptionResponse] = Field(default_factory=list)


class TaskSummaryResponse(BaseModel):
    task_id: str
    video_id: str | None = None
    status: TaskStatus
    input_type: str
    source: str
    title: str | None = None
    page_number: int | None = None
    page_title: str | None = None
    created_at: datetime
    updated_at: datetime
    llm_total_tokens: int | None = None
    task_duration_seconds: float | None = None


class TaskDetailResponse(TaskSummaryResponse):
    result: TaskResult | None = None
    error_code: str | None = None
    error_message: str | None = None


class TaskMindMapResponse(BaseModel):
    task_id: str
    status: str = "idle"
    error_message: str | None = None
    updated_at: datetime | None = None
    mindmap: TaskMindMap | None = None


class TaskMarkdownExportResponse(BaseModel):
    task_id: str
    target_format: Literal["markdown", "obsidian"]
    path: str
    directory: str
    file_name: str
    overwritten: bool = False
    artifact_key: str


class TaskEventResponse(BaseModel):
    event_id: str
    task_id: str
    stage: str
    progress: int
    message: str
    created_at: datetime
    payload: dict[str, object] = Field(default_factory=dict)


class TaskProgressResponse(BaseModel):
    task_id: str
    status: TaskStatus
    progress: int = 0
    latest_stage: str | None = None
    latest_message: str | None = None
    updated_at: datetime


class TaskRecord(BaseModel):
    task_id: str = Field(default_factory=lambda: uuid4().hex)
    video_id: str | None = None
    status: TaskStatus = TaskStatus.QUEUED
    task_input: TaskInput
    page_number: int | None = None
    page_title: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    result: TaskResult | None = None
    error_code: str | None = None
    error_message: str | None = None

    @property
    def task_duration_seconds(self) -> float | None:
        if not self.created_at or not self.updated_at:
            return None
        return max(0.0, (self.updated_at - self.created_at).total_seconds())

    def to_summary(self) -> TaskSummaryResponse:
        page_number = self.page_number if self.page_number is not None else extract_bilibili_page(self.task_input.source)
        return TaskSummaryResponse(
            task_id=self.task_id,
            video_id=self.video_id,
            status=self.status,
            input_type=self.task_input.input_type.value,
            source=self.task_input.source,
            title=self.task_input.title,
            page_number=page_number,
            page_title=self.page_title or self.task_input.title,
            created_at=self.created_at,
            updated_at=self.updated_at,
            llm_total_tokens=self.result.llm_total_tokens if self.result else None,
            task_duration_seconds=self.task_duration_seconds,
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
