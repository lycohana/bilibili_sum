from __future__ import annotations

from collections import Counter
from itertools import combinations

from fastapi import HTTPException

from video_sum_infra.config import ServiceSettings
from video_sum_service.knowledge.local_llm import chat_knowledge_llm, parse_json_payload
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import (
    KnowledgeAutoTagResponse,
    KnowledgeAutoTagVideoResult,
    KnowledgeNetworkLink,
    KnowledgeNetworkNode,
    KnowledgeNetworkResponse,
    TagItem,
    VideoTagRecord,
)


class TagService:
    def __init__(self, repository: SqliteTaskRepository, settings: ServiceSettings) -> None:
        self._repository = repository
        self._settings = settings

    def add_tag(self, video_id: str, tag: str, source: str = "manual", confidence: float = 1.0) -> bool:
        return self._repository.add_video_tag(video_id, tag, source=source, confidence=confidence)

    def remove_tag(self, video_id: str, tag: str) -> bool:
        return self._repository.remove_video_tag(video_id, tag)

    def get_tags_for_video(self, video_id: str) -> list[VideoTagRecord]:
        return self._repository.list_video_tags(video_id)

    def get_all_tags(self) -> list[TagItem]:
        return [TagItem.model_validate(item) for item in self._repository.list_all_tags()]

    def auto_tag_video(self, video_id: str, llm_model: str | None = None) -> list[str]:
        del llm_model
        video = self._repository.get_video_asset(video_id)
        if video is None or video.latest_result is None:
            raise HTTPException(status_code=404, detail="Video not found or has no summary result.")

        result = video.latest_result
        content = "\n\n".join(
            [
                f"标题：{video.title}",
                f"概览：{result.overview}",
                "知识笔记：",
                result.knowledge_note_markdown or "",
                "章节：",
                "\n".join(
                    f"- {chapter.get('title')}: {chapter.get('summary')}"
                    for chapter in result.timeline
                    if isinstance(chapter, dict)
                ),
            ]
        ).strip()

        response_text, _body = chat_knowledge_llm(
            self._settings,
            system_prompt=(
                "你是一个知识库标签助手。请根据视频摘要和知识笔记，为视频生成 3 到 8 个简洁中文标签。"
                "只返回合法 JSON，对象格式必须为 {\"tags\": [\"标签1\", \"标签2\"]}。"
            ),
            user_prompt=content,
            require_json=True,
            max_tokens=200,
            temperature=0.1,
        )
        payload = parse_json_payload(response_text)
        raw_tags = payload.get("tags")
        if not isinstance(raw_tags, list):
            raise HTTPException(status_code=502, detail="知识库 LLM 返回的标签格式不正确。")

        normalized_tags: list[str] = []
        seen: set[str] = set()
        for item in raw_tags:
            tag = str(item or "").strip()
            if not tag or tag in seen:
                continue
            seen.add(tag)
            normalized_tags.append(tag)
            self._repository.add_video_tag(video_id, tag, source="auto_llm", confidence=0.8)
        return normalized_tags

    def batch_auto_tag(self, video_ids: list[str] | None = None) -> KnowledgeAutoTagResponse:
        target_video_ids = video_ids or self._repository.list_untagged_video_ids()
        items: list[KnowledgeAutoTagVideoResult] = []
        for video_id in target_video_ids:
            tags = self.auto_tag_video(video_id)
            items.append(KnowledgeAutoTagVideoResult(video_id=video_id, tags=tags))
        return KnowledgeAutoTagResponse(items=items)

    def get_network_data(
        self,
        selected_tags: list[str] | None = None,
        *,
        max_tags: int = 12,
        max_videos: int = 8,
    ) -> KnowledgeNetworkResponse:
        all_tags = self._repository.list_all_tags()
        all_video_tags = self._repository.list_all_video_tags()
        selected = [tag for tag in dict.fromkeys(selected_tags or []) if tag]
        tag_counts = {str(item["tag"]): int(item["count"]) for item in all_tags}
        video_tag_map: dict[str, list[str]] = {}
        for item in all_video_tags:
            video_tag_map.setdefault(item.video_id, []).append(item.tag)

        tag_video_map: dict[str, set[str]] = {}
        cooccurrence: Counter[tuple[str, str]] = Counter()
        for video_id, tags in video_tag_map.items():
            unique_tags = sorted({tag for tag in tags if tag})
            for tag in unique_tags:
                tag_video_map.setdefault(tag, set()).add(video_id)
            for left, right in combinations(unique_tags, 2):
                cooccurrence[(left, right)] += 1

        tag_degree: Counter[str] = Counter()
        for (left, right), weight in cooccurrence.items():
            tag_degree[left] += weight
            tag_degree[right] += weight

        def tag_rank(tag: str) -> tuple[int, int, str]:
            return (tag_degree.get(tag, 0), tag_counts.get(tag, 0), tag)

        if selected:
            existing_selected = [tag for tag in selected if tag in tag_counts]
            related_scores: Counter[str] = Counter()
            for current_tag in existing_selected:
                for (left, right), weight in cooccurrence.items():
                    if left == current_tag and right not in existing_selected:
                        related_scores[right] += weight
                    elif right == current_tag and left not in existing_selected:
                        related_scores[left] += weight
            related_tags = [
                tag
                for tag, _score in sorted(
                    related_scores.items(),
                    key=lambda item: (item[1], tag_degree.get(item[0], 0), tag_counts.get(item[0], 0), item[0]),
                    reverse=True,
                )
            ]
            visible_tags = existing_selected + [
                tag for tag in related_tags if tag not in existing_selected
            ][: max(0, max_tags - len(existing_selected))]
            candidate_videos = []
            for video_id, tags in video_tag_map.items():
                overlap = len(set(tags) & set(existing_selected))
                if overlap <= 0:
                    continue
                candidate_videos.append((video_id, overlap, len(tags)))
            candidate_videos.sort(key=lambda item: (item[1], item[2], item[0]), reverse=True)
            visible_video_ids = [video_id for video_id, _overlap, _tag_total in candidate_videos[:max_videos]]
            mode = "focus"
        else:
            ranked_tags = sorted(tag_counts, key=tag_rank, reverse=True)
            visible_tags = ranked_tags[:max_tags]
            visible_video_ids: list[str] = []
            mode = "overview"

        visible_tag_set = set(visible_tags)
        nodes: list[KnowledgeNetworkNode] = []
        for tag in visible_tags:
            nodes.append(
                KnowledgeNetworkNode(
                    id=f"tag_{tag}",
                    label=tag,
                    type="tag",
                    count=tag_counts.get(tag, 0),
                    degree=tag_degree.get(tag, 0),
                    focus=tag in selected,
                    video_count=len(tag_video_map.get(tag, set())),
                )
            )

        links: list[KnowledgeNetworkLink] = []
        if selected:
            for video_id in visible_video_ids:
                video = self._repository.get_video_asset(video_id)
                if video is None:
                    continue
                video_tags = sorted(tag for tag in set(video_tag_map.get(video_id, [])) if tag in visible_tag_set)
                if not video_tags:
                    continue
                nodes.append(
                    KnowledgeNetworkNode(
                        id=f"video_{video.video_id}",
                        label=video.title,
                        type="video",
                        tags=video_tags,
                        video_count=1,
                    )
                )
                for tag in video_tags[:3]:
                    links.append(
                        KnowledgeNetworkLink(
                            source=f"tag_{tag}",
                            target=f"video_{video.video_id}",
                            weight=1.0,
                            kind="association",
                        )
                    )
            for (left, right), weight in cooccurrence.most_common():
                if left in visible_tag_set and right in visible_tag_set:
                    links.append(
                        KnowledgeNetworkLink(
                            source=f"tag_{left}",
                            target=f"tag_{right}",
                            weight=float(weight),
                            kind="cooccurrence",
                        )
                    )
                if len([item for item in links if item.kind == "cooccurrence"]) >= max(8, len(visible_tags) * 2):
                    break
        else:
            fallback_links: list[KnowledgeNetworkLink] = []
            for (left, right), weight in cooccurrence.most_common():
                if left in visible_tag_set and right in visible_tag_set:
                    candidate = KnowledgeNetworkLink(
                        source=f"tag_{left}",
                        target=f"tag_{right}",
                        weight=float(weight),
                        kind="cooccurrence",
                    )
                    if weight >= 2:
                        links.append(candidate)
                    else:
                        fallback_links.append(candidate)
                if len(links) >= max(10, len(visible_tags) * 2):
                    break
            if not links:
                links.extend(fallback_links[: max(1, min(6, len(fallback_links)))])

        return KnowledgeNetworkResponse(
            nodes=nodes,
            links=links,
            mode=mode,
            hidden_tag_count=max(0, len(tag_counts) - len(visible_tags)),
            selected_tags=selected,
        )
