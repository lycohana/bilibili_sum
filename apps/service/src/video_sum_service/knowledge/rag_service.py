from __future__ import annotations

from collections.abc import Iterator

from fastapi import HTTPException

from video_sum_infra.config import ServiceSettings
from video_sum_service.knowledge.index_service import KnowledgeIndexService, format_anchor_seconds
from video_sum_service.knowledge.local_llm import chat_knowledge_llm, stream_knowledge_llm
from video_sum_service.knowledge.tag_service import TagService
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import KnowledgeAskResponse, KnowledgeSourceRef


class RagService:
    def __init__(
        self,
        repository: SqliteTaskRepository,
        index_service: KnowledgeIndexService,
        tag_service: TagService,
        settings: ServiceSettings,
    ) -> None:
        self._repository = repository
        self._index_service = index_service
        self._tag_service = tag_service
        self._settings = settings

    def _collect_context(
        self,
        query: str,
        context_limit: int = 5,
    ) -> tuple[str, list[dict[str, object]], list[str], list[KnowledgeSourceRef]]:
        cleaned_query = str(query or "").strip()
        if not cleaned_query:
            raise HTTPException(status_code=400, detail="问题不能为空。")

        chunks = self._index_service.search_chunks(cleaned_query, limit=max(1, context_limit))
        if not chunks:
            return cleaned_query, [], [], []

        context_blocks: list[str] = []
        sources: list[KnowledgeSourceRef] = []
        seen_sources: set[tuple[str, str | None]] = set()
        for item in chunks:
            video_id = str(item["video_id"])
            metadata = item["metadata"] if isinstance(item["metadata"], dict) else {}
            asset = self._repository.get_video_asset(video_id)
            title = asset.title if asset is not None else str(metadata.get("title") or "未知视频")
            anchor_seconds = (
                float(metadata["anchor_seconds"])
                if metadata.get("anchor_seconds") not in {None, "", -1, -1.0}
                else None
            )
            timestamp = format_anchor_seconds(anchor_seconds)
            context_blocks.append(
                "\n".join(
                    [
                        f"[视频：{title}]",
                        f"[时间：{timestamp or '未标注'}]",
                        str(item["document"]).strip(),
                    ]
                )
            )
            key = (video_id, timestamp)
            if key not in seen_sources:
                seen_sources.add(key)
                sources.append(
                    KnowledgeSourceRef(
                        video_id=video_id,
                        title=title,
                        relevance_score=float(item["relevance_score"]),
                        timestamp=timestamp,
                    )
                )

        return cleaned_query, chunks, context_blocks, sources

    def ask(self, query: str, context_limit: int = 5) -> KnowledgeAskResponse:
        cleaned_query, chunks, context_blocks, sources = self._collect_context(query, context_limit)
        if not chunks:
            return KnowledgeAskResponse(query=cleaned_query, answer="知识库中暂无相关内容。", sources=[])

        answer, _body = chat_knowledge_llm(
            self._settings,
            system_prompt=(
                "你是 BriefVid 的本地知识库助手。请严格根据给出的知识库片段回答问题。"
                "如果信息不足，请明确回答“知识库中暂无相关内容”。"
                "回答使用中文，保持简洁清楚。"
            ),
            user_prompt=f"用户问题：{cleaned_query}\n\n相关视频内容：\n---\n" + "\n\n".join(context_blocks) + "\n---",
            max_tokens=700,
            temperature=0.2,
        )
        return KnowledgeAskResponse(query=cleaned_query, answer=answer.strip(), sources=sources)

    def ask_stream(self, query: str, context_limit: int = 5) -> Iterator[tuple[str, dict[str, object]]]:
        cleaned_query, chunks, context_blocks, sources = self._collect_context(query, context_limit)
        yield (
            "tool",
            {
                "id": "semantic_search",
                "label": "语义检索",
                "status": "running",
                "detail": "正在检索与你问题最相关的知识片段。",
            },
        )

        if not chunks:
            yield (
                "tool",
                {
                    "id": "semantic_search",
                    "label": "语义检索",
                    "status": "completed",
                    "detail": "没有检索到相关知识片段。",
                },
            )
            yield ("text_delta", {"delta": "知识库中暂无相关内容。"})
            yield ("sources", {"sources": []})
            yield ("done", {"query": cleaned_query, "answer": "知识库中暂无相关内容。", "sources": []})
            return

        matched_videos = len({source.video_id for source in sources})
        yield (
            "tool",
            {
                "id": "semantic_search",
                "label": "语义检索",
                "status": "completed",
                "detail": f"命中 {len(chunks)} 个片段，来自 {matched_videos} 个视频。",
                "meta": {
                    "chunk_count": len(chunks),
                    "video_count": matched_videos,
                },
            },
        )
        yield (
            "tool",
            {
                "id": "context_builder",
                "label": "上下文拼装",
                "status": "running",
                "detail": "正在整理片段、时间点和来源引用。",
            },
        )
        yield (
            "tool",
            {
                "id": "context_builder",
                "label": "上下文拼装",
                "status": "completed",
                "detail": "已生成回答上下文，并保留来源视频与时间点。",
                "meta": {
                    "sources": [
                        {
                            "title": source.title,
                            "timestamp": source.timestamp,
                            "score": round(source.relevance_score, 3),
                        }
                        for source in sources[:4]
                    ],
                },
            },
        )
        yield (
            "tool",
            {
                "id": "knowledge_llm",
                "label": "知识库 LLM",
                "status": "running",
                "detail": "正在根据检索片段生成回答。",
            },
        )

        answer_parts: list[str] = []
        for delta in stream_knowledge_llm(
            self._settings,
            system_prompt=(
                "你是 BriefVid 的本地知识库助手。请严格根据给出的知识库片段回答问题。"
                "如果信息不足，请明确回答“知识库中暂无相关内容”。"
                "回答使用中文，保持简洁清楚。"
            ),
            user_prompt=f"用户问题：{cleaned_query}\n\n相关视频内容：\n---\n" + "\n\n".join(context_blocks) + "\n---",
            max_tokens=700,
            temperature=0.2,
        ):
            answer_parts.append(delta)
            yield ("text_delta", {"delta": delta})

        answer = "".join(answer_parts).strip() or "知识库中暂无相关内容。"
        yield (
            "tool",
            {
                "id": "knowledge_llm",
                "label": "知识库 LLM",
                "status": "completed",
                "detail": "回答生成完成。",
                "meta": {
                    "character_count": len(answer),
                },
            },
        )
        yield ("sources", {"sources": [source.model_dump(mode="json") for source in sources]})
        yield ("done", {"query": cleaned_query, "answer": answer, "sources": [source.model_dump(mode="json") for source in sources]})
