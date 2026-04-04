from enum import Enum

from pydantic import BaseModel, Field


class InputType(str, Enum):
    URL = "url"
    VIDEO_FILE = "video_file"
    AUDIO_FILE = "audio_file"
    TRANSCRIPT_TEXT = "transcript_text"


class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskOptions(BaseModel):
    language: str = "zh"
    summary_mode: str = "auto"
    prefer_subtitles: bool = True
    export_formats: list[str] = Field(default_factory=lambda: ["md", "json"])


class TaskInput(BaseModel):
    input_type: InputType
    source: str
    title: str | None = None
    platform_hint: str | None = None
    options: TaskOptions = Field(default_factory=TaskOptions)


class TaskResult(BaseModel):
    overview: str = ""
    transcript_text: str = ""
    segment_summaries: list[str] = Field(default_factory=list)
    key_points: list[str] = Field(default_factory=list)
    timeline: list[dict[str, object]] = Field(default_factory=list)
    artifacts: dict[str, str] = Field(default_factory=dict)
    llm_prompt_tokens: int | None = None
    llm_completion_tokens: int | None = None
    llm_total_tokens: int | None = None
