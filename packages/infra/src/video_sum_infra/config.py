from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from video_sum_infra.runtime import (
    default_cache_dir,
    default_data_dir,
    default_database_url,
    default_tasks_dir,
)

DEFAULT_SUMMARY_SYSTEM_PROMPT = (
    "你是一名严谨的中文视频摘要助手。"
    "你的唯一任务是基于用户提供的转写和分段信息，生成可直接展示给前端页面的结构化摘要。"
    "不得编造视频中没有出现的信息，不得输出 JSON 以外的任何文字。"
    "You must return valid json only."
)

DEFAULT_SUMMARY_USER_PROMPT_TEMPLATE = """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：生成一个可读性强、信息密度高、适合中文用户阅读的视频摘要。

强约束：
1. 必须输出合法 JSON，对象顶层只允许包含 title、overview、bulletPoints、chapters 四个字段。
2. overview 必须是 2 到 4 句中文，概括视频核心观点、讨论主题和最终结论。
3. bulletPoints 必须是 4 到 6 条中文要点，每条 18 到 60 个字，禁止空字符串，禁止重复改写同一条意思。
4. chapters 必须是 3 到 6 个章节，每个章节必须包含 title、start、summary。
5. chapter.title 要短，像小标题；chapter.summary 要概括该时间段内容，20 到 80 个字。
6. start 必须使用视频里真实出现的时间点，单位为秒，按升序排列。
7. 如果原文信息有限，也必须尽量提炼出非空 bulletPoints 和 chapters，不能返回空数组。
8. 不要写“视频主要讲了”“本视频介绍了”这种空话，直接写内容。
9. 不要引用不存在的数据，不要补充外部背景，不要分析说话者身份之外的隐含动机。

写作要求：
- 保持中文自然、紧凑、具体。
- 优先提炼观点、结论、争议点、使用体验、推荐条件。
- chapters 应体现内容推进，而不是机械平均切分。

输出格式示例：
{{"title":"","overview":"","bulletPoints":["", "", "", ""],"chapters":[{{"title":"","start":0,"summary":""}}]}}

视频标题：{title}

转写节选：
{transcript}

分段数据节选：
{segments_json}"""

LEGACY_SUMMARY_SYSTEM_PROMPT = (
    "你是一名中文视频总结助手。请基于转写内容输出 JSON，包含 title、overview、bulletPoints、chapters。内容必须忠实原文，不要编造。"
)

LEGACY_SUMMARY_USER_PROMPT_TEMPLATE = (
    "请总结下面的视频转写。\n\n转写全文：\n{transcript}\n\n分段（JSON）：\n{segments_json}\n\n"
    "要求：\n1. bulletPoints 返回数组\n2. chapters 返回数组，每项包含 title、start、summary\n3. 输出必须是 JSON"
)


class ServiceSettings(BaseSettings):
    host: str = "127.0.0.1"
    port: int = 3838
    data_dir: Path = Field(default_factory=default_data_dir)
    cache_dir: Path = Field(default_factory=default_cache_dir)
    tasks_dir: Path = Field(default_factory=default_tasks_dir)
    database_url: str = Field(default_factory=default_database_url)
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    device_preference: str = "cpu"
    compute_type: str = "int8"
    model_mode: str = "fixed"
    fixed_model: str = "tiny"
    cuda_variant: str = "cu128"
    runtime_channel: str = "base"
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
    summary_system_prompt: str = DEFAULT_SUMMARY_SYSTEM_PROMPT
    summary_user_prompt_template: str = DEFAULT_SUMMARY_USER_PROMPT_TEMPLATE
    summary_chunk_target_chars: int = 2200
    summary_chunk_overlap_segments: int = 2
    summary_chunk_concurrency: int = 2
    summary_chunk_retry_count: int = 2

    model_config = SettingsConfigDict(
        env_prefix="VIDEO_SUM_",
        env_file=".env",
        extra="ignore",
    )

    def resolve_whisper_runtime(
        self,
        cuda_available: bool,
    ) -> tuple[str, str, str]:
        device_preference = (self.device_preference or "auto").strip().lower()
        # Backward compatibility: older settings used "gpu" instead of "cuda".
        if device_preference == "gpu":
            device_preference = "cuda"

        if self.model_mode == "auto":
            model = "large-v3-turbo" if cuda_available else "base"
        else:
            model = self.fixed_model or self.whisper_model or "tiny"

        if device_preference == "auto":
            device = "cuda" if cuda_available else "cpu"
        elif device_preference == "cuda" and cuda_available:
            device = "cuda"
        elif device_preference == "cuda" and not cuda_available:
            device = "cpu"
        else:
            device = "cpu"

        compute_type_preference = (self.compute_type or "").strip().lower()
        if compute_type_preference == "auto":
            compute_type = "float16" if device == "cuda" else "int8"
        elif device == "cuda" and compute_type_preference == "int8":
            compute_type = "int8_float16"
        else:
            compute_type = compute_type_preference or self.whisper_compute_type or "int8"

        return model, device, compute_type

    def with_resolved_runtime(self, cuda_available: bool) -> "ServiceSettings":
        model, device, compute_type = self.resolve_whisper_runtime(cuda_available=cuda_available)
        return self.model_copy(
            update={
                "whisper_model": model,
                "whisper_device": device,
                "whisper_compute_type": compute_type,
            }
        )
