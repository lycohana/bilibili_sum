from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ServiceSettings(BaseSettings):
    host: str = "127.0.0.1"
    port: int = 3838
    data_dir: Path = Field(default_factory=lambda: Path.cwd() / ".data")
    cache_dir: Path = Field(default_factory=lambda: Path.cwd() / ".data" / "cache")
    tasks_dir: Path = Field(default_factory=lambda: Path.cwd() / ".data" / "tasks")
    database_url: str = "sqlite:///./.data/video_sum.db"
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    device_preference: str = "cpu"
    compute_type: str = "int8"
    model_mode: str = "fixed"
    fixed_model: str = "tiny"
    cuda_variant: str = "cu128"
    output_dir: str = ""
    preserve_temp_audio: bool = False
    enable_cache: bool = True
    language: str = "zh"
    summary_mode: str = "llm"
    llm_enabled: bool = False
    llm_provider: str = "openai-compatible"
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""
    summary_system_prompt: str = (
        "你是一名中文视频总结助手。请基于转写内容输出 JSON，包含 title、overview、bulletPoints、chapters。内容必须忠实原文，不要编造。"
    )
    summary_user_prompt_template: str = (
        "请总结下面的视频转写。\n\n转写全文：\n{transcript}\n\n分段（JSON）：\n{segments_json}\n\n"
        "要求：\n1. bulletPoints 返回数组\n2. chapters 返回数组，每项包含 title、start、summary\n3. 输出必须是 JSON"
    )

    model_config = SettingsConfigDict(
        env_prefix="VIDEO_SUM_",
        env_file=".env",
        extra="ignore",
    )
