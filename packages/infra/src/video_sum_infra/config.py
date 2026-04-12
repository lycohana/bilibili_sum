from pathlib import Path
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from video_sum_infra.runtime import (
    default_cache_dir,
    default_data_dir,
    default_database_url,
    default_tasks_dir,
)

PREVIOUS_DEFAULT_SUMMARY_SYSTEM_PROMPT = (
    "你是一名严谨的中文视频摘要助手。"
    "你的唯一任务是基于用户提供的转写和分段信息，生成可直接展示给前端页面的结构化摘要。"
    "不得编造视频中没有出现的信息，不得输出 JSON 以外的任何文字。"
    "You must return valid json only."
)

PREVIOUS_DEFAULT_SUMMARY_USER_PROMPT_TEMPLATE = """请阅读下面的视频资料，并输出一个 JSON 对象。
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

DEFAULT_SUMMARY_SYSTEM_PROMPT = (
    "你是一名严谨、克制、信息密度优先的中文视频内容编辑。"
    "你的任务不是泛泛总结，而是基于转写和分段信息，产出可以直接用于“知识卡片”页面的结构化内容。"
    "所有内容都必须忠实原文，不得编造，不得补充外部资料，不得输出 JSON 以外的任何文字。"
    "You must return valid json only."
)

DEFAULT_SUMMARY_USER_PROMPT_TEMPLATE = """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：
生成一个适合详情页展示的结构化摘要，让用户在不看完整视频的情况下，也能快速理解：
1. 这支视频核心在讲什么；
2. 有哪些关键观点、论据、案例、争议和结论；
3. 内容是如何逐步展开的。

强约束：
1. 必须输出合法 JSON，对象顶层只允许包含 title、overview、bulletPoints、chapters、chapterGroups 五个字段。
2. title 必须是简洁、准确的中文标题，避免口号式空话。
3. overview 必须写成 3 到 5 句中文，整体形成一段完整概述：
   - 第 1 句交代主题或讨论对象；
   - 中间句交代关键论点、论据、背景、冲突或方法；
   - 最后 1 句交代结论、判断、影响或最终落点；
   - 总体要具体、完整，适合单独作为“核心概览”展示。
4. bulletPoints 必须是 5 到 8 条中文要点，每条 28 到 88 个字：
   - 每条都要能单独成为一张知识卡片；
   - 优先提炼事实、观点、因果、对比、条件、风险、建议、争议；
   - 不要把同一件事拆成多条近义重复表达；
   - 不要写“作者认为”“视频提到”这类低信息密度前缀，直接写结论。
5. chapters 必须按内容自然分布生成，每个章节必须包含 title、start、summary：
   - chapter.title 要像小标题，短而具体，能体现这一段的主题推进；
   - chapter.summary 必须比普通概述更详细，写成 2 到 3 个短句或 40 到 120 个字，说明这一段具体讲了什么、举了什么例子、得出了什么判断；
   - chapters 应体现内容推进关系，而不是机械平均切分；
   - 章节数量不要预设固定值，应根据内容转折、主题切换、论证层次和视频时长自适应决定；
   - 短视频可以较少章节，长视频或知识密度高的视频应适当增加章节，必要时可达到 9 到 12 个；
   - 只有在确实进入新主题、新问题、新案例或新结论时才切出新章节，不要为了凑数量硬拆。
6. chapterGroups 用来表示“大章节 / 小章节”层级，按真实结构归纳大章节；每个大章节必须包含 title、start、summary、children。
   - chapterGroups.title 必须是有内容的主题名，禁止使用“大章节1”“第一部分”“Part 1”“Section 1”这类占位标题；
   - 当原文层级明显时，大章节数量也应随内容自适应，不要固定成 2 到 4 组；
   - 如果层级不明显，可以少量归并；如果层级明显，可以返回更多组，但不要机械平均分配。
7. start 必须使用视频里真实出现的时间点，单位为秒，按升序排列。
8. 如果原文信息有限，也必须尽量提炼出非空 bulletPoints 和 chapters，不能返回空数组。
9. 不要写“视频主要讲了”“本视频介绍了”“作者首先”这类模板化空话，直接进入信息本体。
10. 不要引用不存在的数据，不要补充外部背景，不要猜测说话者未明确表达的动机。

写作要求：
- 保持中文自然、清楚、具体，避免官话和营销口吻。
- 优先保留高价值信息：定义、判断、证据、例子、条件、限制、影响、结论。
- 如果视频包含多个层次，overview 负责总览，bulletPoints 负责拆出关键结论，chapters 负责还原内容推进，chapterGroups 负责归纳章节层级。
- 标题必须像真实目录项，而不是编号占位符；宁可少而准，也不要为了数量固定而硬拆。

输出格式示例：
{{"title":"","overview":"","bulletPoints":["", "", "", "", ""],"chapters":[{{"title":"","start":0,"summary":""}}],"chapterGroups":[{{"title":"","start":0,"summary":"","children":[{{"title":"","start":0,"summary":""}}]}}]}}

视频标题：{title}

转写节选：
{transcript}

分段数据节选：
{segments_json}"""

DEFAULT_MINDMAP_SYSTEM_PROMPT = (
    "你是一名擅长把学习内容重新组织为知识导图的中文内容编辑。"
    "你的任务是基于已有结构化摘要和知识笔记，输出一个适合思维导图展示、信息密度充足、覆盖完整的 JSON 树。"
    "所有内容都必须忠实原文，不得编造，不得补充外部资料，不得输出 JSON 以外的任何文字。"
    "You must return valid json only."
)

DEFAULT_MINDMAP_USER_PROMPT_TEMPLATE = """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：
把当前视频内容组织成一棵真正“像思维导图”的知识树。它必须以概念、主题、方法、结论之间的关系为核心，而不是把章节标题换个层级重新排列。最末层节点仍然必须能回到原视频片段。

强约束：
1. 顶层只允许包含 title、root、nodes 三个字段。
2. root 必须是整棵导图的根节点 id。
3. nodes 必须是数组，其中包含唯一的根节点；每个节点必须包含：
   - id
   - label
   - type（只能是 root、theme、topic、leaf 之一）
   - summary
   - children
   - time_anchor（仅 leaf 必填，其余可为空）
   - source_chapter_titles
   - source_chapter_starts
4. 整体结构必须是树，不要输出交叉引用；最大深度为 root -> theme -> topic/leaf -> leaf。
5. 顶层 theme 数量应为 4 到 8 个，每个 theme 下应有 3 到 6 个 topic 或 leaf；除非原内容本身很短，否则不要生成过于稀疏的导图。
6. leaf 节点必须能映射到原章节，并带真实时间点；time_anchor 必须取自 source_chapter_starts 中最早的时间点。
7. source_chapter_titles 和 source_chapter_starts 只保留最相关的 1 到 3 项，且数量一致。
8. label 必须是有内容的主题名，禁止“主题1”“Part 1”“Section 1”等占位标题。
9. summary 要适合学习复盘，直接写信息本体，不要重复整段知识笔记；theme/topic 的 summary 尽量写成 2 到 4 句，leaf 的 summary 至少要交代“结论 / 方法 / 条件 / 例子”中的两项。
10. label 和 summary 内如果出现数学内容，优先使用 KaTeX 兼容的 LaTeX 写法，例如 `$\\frac{1}{n}$`、`$(-1)^n$`、`$\\varepsilon$-$N$`；不要输出无法解析的伪公式。
11. 只允许输出 JSON；但 JSON 字符串内部允许包含少量 Markdown 和 `$...$` / `$$...$$` 数学公式。
12. 不要输出空 children 字段以外的多余字段，不要输出解释说明。
13. 不要把 `chapters` 或 `chapterGroups` 直接一一平移成 theme/topic；必须先做语义归纳，再组织层级。
14. 如果多个章节都在讲同一个概念、同一种方法、同一类例子，应该聚合成一个主题，而不是拆成多个并列节点。
15. 导图的每一层都应体现“父主题如何拆成子主题”，而不是简单的时间顺序。

写作要求：
- 优先按“概念定义 / 推导方法 / 典型例子 / 易错点 / 结论判断 / 应用条件”这类知识结构重组。
- 根节点应该是整支视频真正的学习主题，不要只是视频标题原样重复，除非标题本身已经是明确概念。
- theme 层应该是 4 到 8 个最核心的大主题，彼此之间要有明显区分。
- topic 层应承担细化作用，只有当某个 theme 下确实存在两到三类不同子议题时才保留 topic；否则可直接挂 leaf。
- leaf 节点要具体、短促、可点击后立刻看懂，不要写成长句，也不要只是“第X部分”。
- 允许把多个来源章节压缩成一个更抽象、更像脑图节点的表达。
- 如果原文本身是教程或知识讲解，优先提炼“知识结构”；如果原文是评论或资讯，优先提炼“观点结构”和“因果关系”。
- 若视频包含公式、定义、判别条件、证明步骤、典型例题，不要省略它们；应把它们拆成独立主题或叶子节点，而不是只保留一个笼统标题。
- 不要怕信息多，只要层级清楚即可；优先保证“覆盖完整”和“节点可学”，不要只给每个主题一个空泛标签。
- 对于数学/理工类内容，优先把“定义、命题、判别条件、证明思路、典型例题、易错点”拆成不同节点；不要把整段证明压成一句泛泛描述。
- 如果一个 theme 下只生成了 1 个叶子节点，优先继续细化，除非原文确实只讲了这一点。
- 如果知识笔记已经给出分点、例题或条件，你应该把这些信息展开到对应节点，而不是只复述 theme 名称。
- 最终观感要像学习者自己整理出来的脑图，而不是讲稿目录。

输出格式示例：
{{"title":"","root":"root","nodes":[{{"id":"root","label":"","type":"root","summary":"","children":[{{"id":"theme-1","label":"","type":"theme","summary":"","children":[{{"id":"leaf-1","label":"","type":"leaf","summary":"","children":[],"time_anchor":0,"source_chapter_titles":[""],"source_chapter_starts":[0]}}],"source_chapter_titles":[],"source_chapter_starts":[]}}],"source_chapter_titles":[],"source_chapter_starts":[]}}]}}

视频标题：
{title}

已有结构化摘要：
{summary_json}

知识笔记：
{knowledge_note_markdown}
"""

LEGACY_SUMMARY_SYSTEM_PROMPT = (
    "你是一名中文视频总结助手。请基于转写内容输出 JSON，包含 title、overview、bulletPoints、chapters。内容必须忠实原文，不要编造。"
)

LEGACY_SUMMARY_USER_PROMPT_TEMPLATE = (
    "请总结下面的视频转写。\n\n转写全文：\n{transcript}\n\n分段（JSON）：\n{segments_json}\n\n"
    "要求：\n1. bulletPoints 返回数组\n2. chapters 返回数组，每项包含 title、start、summary\n3. 输出必须是 JSON"
)

DEVICE_PREFERENCE_ALIASES = {
    "auto": "auto",
    "automatic": "auto",
    "default": "auto",
    "cpu": "cpu",
    "cuda": "cuda",
    "gpu": "cuda",
}


def normalize_device_preference(value: str | None, default: str = "cpu") -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return default
    return DEVICE_PREFERENCE_ALIASES.get(normalized, default)


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
    mindmap_system_prompt: str = DEFAULT_MINDMAP_SYSTEM_PROMPT
    mindmap_user_prompt_template: str = DEFAULT_MINDMAP_USER_PROMPT_TEMPLATE
    summary_chunk_target_chars: int = 2200
    summary_chunk_overlap_segments: int = 2
    summary_chunk_concurrency: int = 2
    summary_chunk_retry_count: int = 2

    model_config = SettingsConfigDict(
        env_prefix="VIDEO_SUM_",
        env_file=".env",
        extra="ignore",
    )

    @field_validator("device_preference", mode="before")
    @classmethod
    def _normalize_device_preference(cls, value: str | None) -> str:
        return normalize_device_preference(value)

    def resolve_whisper_runtime(
        self,
        cuda_available: bool,
    ) -> tuple[str, str, str]:
        if self.model_mode == "auto":
            model = "large-v3-turbo" if cuda_available else "base"
        else:
            model = self.fixed_model or self.whisper_model or "tiny"

        device_preference = normalize_device_preference(self.device_preference)

        if device_preference == "auto":
            device = "cuda" if cuda_available else "cpu"
        elif device_preference == "cuda" and cuda_available:
            device = "cuda"
        elif device_preference == "cuda" and not cuda_available:
            device = "cpu"
        else:
            device = "cpu"

        if self.compute_type == "auto":
            compute_type = "float16" if device == "cuda" else "int8"
        elif device == "cuda" and self.compute_type == "int8":
            compute_type = "int8_float16"
        else:
            compute_type = self.compute_type or self.whisper_compute_type or "int8"

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
