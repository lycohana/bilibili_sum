from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from video_sum_infra.runtime import default_data_dir

DEFAULT_PRESET_ID = "general"
PROMPT_PRESETS_FILENAME = "prompt_presets.json"


@dataclass(frozen=True, slots=True)
class PromptPreset:
    id: str
    name: str
    description: str
    category: str
    system_prompt: str
    user_prompt_template: str
    auto_match_keywords: list[str]

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> PromptPreset | None:
        preset_id = str(payload.get("id") or "").strip()
        if not preset_id:
            return None
        return cls(
            id=preset_id,
            name=str(payload.get("name") or preset_id).strip() or preset_id,
            description=str(payload.get("description") or "").strip(),
            category=str(payload.get("category") or "custom").strip() or "custom",
            system_prompt=str(payload.get("system_prompt") or "").strip(),
            user_prompt_template=str(payload.get("user_prompt_template") or "").strip(),
            auto_match_keywords=_coerce_keywords(payload.get("auto_match_keywords")),
        )

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _summary_template(goal: str, focus: str) -> str:
    return f"""请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：
{goal}

写作重点：
{focus}

强约束：
1. 顶层只允许包含 title、overview、bulletPoints、chapters、chapterGroups 五个字段。
2. overview 写成 3 到 5 句中文，交代主题、关键论点和结论。
3. bulletPoints 输出 5 到 8 条中文要点，优先保留事实、观点、方法、条件和结论。
4. chapters 按内容推进自然切分，每项包含 title、start、summary，start 使用真实秒数。
5. chapterGroups 按真实结构归纳大章节，每项包含 title、start、summary、children。
6. 不要编造视频没有出现的信息，不要补充外部背景。

输出格式示例：
{{
  "title": "",
  "overview": "",
  "bulletPoints": [""],
  "chapters": [{{"title": "", "start": 0, "summary": ""}}],
  "chapterGroups": [{{"title": "", "start": 0, "summary": "", "children": []}}]
}}

视频标题：{{title}}

转写节选：
{{transcript}}

分段数据节选：
{{segments_json}}"""


def _preset(
    preset_id: str,
    name: str,
    description: str,
    category: str,
    keywords: Iterable[str],
    goal: str,
    focus: str,
) -> PromptPreset:
    return PromptPreset(
        id=preset_id,
        name=name,
        description=description,
        category=category,
        system_prompt=(
            "你是一名严谨、克制、信息密度优先的中文视频内容编辑。"
            "所有内容都必须忠实原文，不得编造，不得输出 JSON 以外的任何文字。"
            "You must return valid json only."
        ),
        user_prompt_template=_summary_template(goal, focus),
        auto_match_keywords=list(keywords),
    )


BUILTIN_PRESETS: tuple[PromptPreset, ...] = (
    _preset(
        DEFAULT_PRESET_ID,
        "通用摘要",
        "适合大多数视频的结构化摘要。",
        "general",
        ["通用", "总结", "摘要", "分享", "观点"],
        "生成一个可直接用于详情页展示的结构化摘要。",
        "提炼主题、关键观点、内容推进和最终落点，避免模板化空话。",
    ),
    _preset(
        "technical_tutorial",
        "技术教程",
        "适合编程、软件、硬件、工具和技术演示类视频。",
        "knowledge",
        ["教程", "编程", "代码", "开发", "技术", "架构", "部署", "debug", "api"],
        "把教程内容整理成可复盘的步骤、原理和注意事项。",
        "保留操作步骤、关键参数、代码概念、常见错误和适用条件。",
    ),
    _preset(
        "academic_lecture",
        "学术讲座",
        "适合课程、公开课、论文解读和学术报告。",
        "knowledge",
        ["讲座", "论文", "研究", "学术", "课程", "公开课", "实验", "证明"],
        "把学术内容整理为概念、论证、证据和结论。",
        "突出定义、假设、方法、实验结果、局限和可复习的知识结构。",
    ),
    _preset(
        "meeting_notes",
        "会议记录",
        "适合会议、访谈式沟通、项目同步和复盘。",
        "work",
        ["会议", "纪要", "同步", "复盘", "讨论", "决策", "行动项"],
        "整理会议中的议题、结论、分歧和后续行动。",
        "优先提取决策、负责人、时间点、风险、待确认事项和行动项。",
    ),
    _preset(
        "news",
        "新闻资讯",
        "适合新闻、行业资讯、政策解读和热点事件。",
        "information",
        ["新闻", "资讯", "快讯", "事件", "政策", "发布", "报道", "热点"],
        "整理事件事实、背景脉络、影响范围和后续观察点。",
        "区分事实与观点，保留时间线、涉事主体、关键数据和影响判断。",
    ),
    _preset(
        "documentary_interview",
        "纪录片访谈",
        "适合纪录片、人物访谈和口述经历。",
        "story",
        ["纪录片", "访谈", "采访", "人物", "经历", "故事", "纪实"],
        "还原人物、事件、冲突和观点变化。",
        "抓住叙事线索、关键场景、人物判断、情绪转折和事实依据。",
    ),
    _preset(
        "product_review",
        "产品评测",
        "适合数码、软件、汽车、家电和消费产品评测。",
        "review",
        ["评测", "测评", "体验", "开箱", "对比", "推荐", "产品", "参数"],
        "整理产品定位、体验表现、优缺点和购买建议。",
        "保留测试场景、对比对象、使用条件、缺点边界和推荐人群。",
    ),
    _preset(
        "book_notes",
        "读书笔记",
        "适合书评、读书分享和章节精读。",
        "knowledge",
        ["读书", "书评", "书摘", "阅读", "作者", "章节", "笔记"],
        "把书籍内容整理成主题、观点、论据和可复用的思考框架。",
        "提炼核心概念、章节逻辑、关键例子、作者判断和现实启发。",
    ),
    _preset(
        "entertainment",
        "娱乐综艺",
        "适合综艺、影视解说、直播切片和娱乐评论。",
        "entertainment",
        ["综艺", "娱乐", "影视", "电影", "电视剧", "直播", "reaction", "明星"],
        "整理剧情、看点、观点和讨论焦点。",
        "保留人物关系、情节推进、争议点、笑点或名场面，不做过度拔高。",
    ),
    _preset(
        "language_learning",
        "外语学习",
        "适合英语、日语等语言学习视频。",
        "learning",
        ["英语", "日语", "韩语", "外语", "单词", "语法", "口语", "听力", "翻译"],
        "把语言学习内容整理成表达、规则、例句和练习重点。",
        "保留词汇、语法点、例句、易错点、语境差异和学习建议。",
    ),
    _preset(
        "course_learning",
        "课程学习",
        "适合系统课程、考试复习和知识讲解。",
        "learning",
        ["学习", "复习", "考试", "知识点", "题目", "例题", "训练", "课程"],
        "整理课程知识点、解题思路、例题和复习顺序。",
        "突出概念层级、推理步骤、典型题型、易错点和阶段性结论。",
    ),
)


def default_prompt_presets_path(data_dir: Path | str | None = None) -> Path:
    base_dir = Path(data_dir) if data_dir else default_data_dir()
    return base_dir / PROMPT_PRESETS_FILENAME


def resolve_prompt_presets_path(
    data_dir: Path | str | None = None,
    prompt_presets_path: Path | str | None = None,
) -> Path:
    raw_path = str(prompt_presets_path or "").strip()
    if raw_path:
        return Path(raw_path).expanduser()
    return default_prompt_presets_path(data_dir)


def load_presets(
    data_dir: Path | str | None = None,
    prompt_presets_path: Path | str | None = None,
) -> list[PromptPreset]:
    custom_presets = _read_custom_presets(
        resolve_prompt_presets_path(data_dir, prompt_presets_path)
    )
    return _merge_presets(custom_presets)


def save_custom_preset(
    preset: PromptPreset,
    data_dir: Path | str | None = None,
    prompt_presets_path: Path | str | None = None,
) -> list[PromptPreset]:
    path = resolve_prompt_presets_path(data_dir, prompt_presets_path)
    custom_presets = _read_custom_presets(path)
    updated: list[PromptPreset] = []
    replaced = False
    for current in custom_presets:
        if current.id == preset.id:
            updated.append(preset)
            replaced = True
        else:
            updated.append(current)
    if not replaced:
        updated.append(preset)

    _write_custom_presets(path, updated)
    return _merge_presets(updated)


def delete_custom_preset(
    preset_id: str,
    data_dir: Path | str | None = None,
    prompt_presets_path: Path | str | None = None,
) -> list[PromptPreset]:
    normalized_id = str(preset_id or "").strip()
    path = resolve_prompt_presets_path(data_dir, prompt_presets_path)
    custom_presets = [
        preset for preset in _read_custom_presets(path) if preset.id != normalized_id
    ]
    _write_custom_presets(path, custom_presets)
    return _merge_presets(custom_presets)


def match_preset(
    title: str,
    presets: Sequence[PromptPreset] | None = None,
    data_dir: Path | str | None = None,
    prompt_presets_path: Path | str | None = None,
) -> PromptPreset:
    available_presets = list(presets) if presets is not None else load_presets(
        data_dir=data_dir,
        prompt_presets_path=prompt_presets_path,
    )
    fallback = _find_preset(available_presets, DEFAULT_PRESET_ID) or BUILTIN_PRESETS[0]
    normalized_title = str(title or "").strip().lower()
    if not normalized_title:
        return fallback

    builtin_ids = {preset.id for preset in BUILTIN_PRESETS}
    match_order = [
        preset for preset in available_presets if preset.id not in builtin_ids
    ]
    match_order.extend(
        preset
        for preset in available_presets
        if preset.id in builtin_ids and preset.id != DEFAULT_PRESET_ID
    )
    for preset in match_order:
        for keyword in preset.auto_match_keywords:
            normalized_keyword = str(keyword or "").strip().lower()
            if normalized_keyword and normalized_keyword in normalized_title:
                return preset
    return fallback


def _coerce_keywords(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item or "").strip()]


def _read_custom_presets(path: Path) -> list[PromptPreset]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []

    if isinstance(payload, dict):
        raw_presets = payload.get("presets", [])
    else:
        raw_presets = payload
    if not isinstance(raw_presets, list):
        return []

    presets: list[PromptPreset] = []
    for item in raw_presets:
        if not isinstance(item, Mapping):
            continue
        preset = PromptPreset.from_mapping(item)
        if preset is not None:
            presets.append(preset)
    return presets


def _write_custom_presets(path: Path, presets: Sequence[PromptPreset]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"presets": [preset.to_dict() for preset in presets]}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _merge_presets(custom_presets: Sequence[PromptPreset]) -> list[PromptPreset]:
    presets_by_id = {preset.id: preset for preset in BUILTIN_PRESETS}
    ordered_ids = [preset.id for preset in BUILTIN_PRESETS]
    for preset in custom_presets:
        if preset.id not in presets_by_id:
            ordered_ids.append(preset.id)
        presets_by_id[preset.id] = preset
    return [presets_by_id[preset_id] for preset_id in ordered_ids]


def _find_preset(
    presets: Sequence[PromptPreset],
    preset_id: str,
) -> PromptPreset | None:
    for preset in presets:
        if preset.id == preset_id:
            return preset
    return None


__all__ = [
    "BUILTIN_PRESETS",
    "DEFAULT_PRESET_ID",
    "PROMPT_PRESETS_FILENAME",
    "PromptPreset",
    "default_prompt_presets_path",
    "delete_custom_preset",
    "load_presets",
    "match_preset",
    "resolve_prompt_presets_path",
    "save_custom_preset",
]
