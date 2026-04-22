from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from video_sum_infra.config import ServiceSettings
from video_sum_infra.runtime import app_data_root
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import KnowledgeIndexChunkRecord, KnowledgeSearchResult


def format_anchor_seconds(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    total = max(0, int(seconds))
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{sec:02d}"
    return f"{minutes:02d}:{sec:02d}"


class KnowledgeIndexService:
    def __init__(
        self,
        repository: SqliteTaskRepository,
        settings: ServiceSettings,
        chroma_path: str | Path | None = None,
        model_name: str = "BAAI/bge-small-zh-v1.5",
    ) -> None:
        self._repository = repository
        self._settings = settings
        self._model_name = model_name
        self._chroma_path = Path(chroma_path or (app_data_root() / "knowledge_index"))
        self._embedder = None
        self._collection = None

    def _get_embedder(self):
        if self._embedder is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as exc:
                raise HTTPException(status_code=500, detail="缺少 sentence-transformers 依赖，无法构建知识库索引。") from exc
            self._embedder = SentenceTransformer(self._model_name)
        return self._embedder

    def _get_collection(self):
        if self._collection is None:
            try:
                import chromadb
            except ImportError as exc:
                raise HTTPException(status_code=500, detail="缺少 chromadb 依赖，无法构建知识库索引。") from exc
            self._chroma_path.mkdir(parents=True, exist_ok=True)
            client = chromadb.PersistentClient(path=str(self._chroma_path))
            self._collection = client.get_or_create_collection(
                name="briefvid_knowledge",
                metadata={"hnsw:space": "cosine"},
            )
        return self._collection

    def _embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors = self._get_embedder().encode(texts, normalize_embeddings=True)
        return [list(map(float, vector)) for vector in vectors]

    def _split_markdown_sections(self, markdown: str) -> list[tuple[str, str]]:
        content = str(markdown or "").strip()
        if not content:
            return []
        sections: list[tuple[str, str]] = []
        current_title = "知识笔记"
        current_lines: list[str] = []
        for line in content.splitlines():
            if re.match(r"^\s{0,3}#{1,3}\s+", line):
                if current_lines:
                    section_body = "\n".join(current_lines).strip()
                    if section_body:
                        sections.append((current_title, section_body))
                current_title = re.sub(r"^\s{0,3}#{1,3}\s+", "", line).strip() or "知识笔记"
                current_lines = []
                continue
            current_lines.append(line)
        if current_lines:
            section_body = "\n".join(current_lines).strip()
            if section_body:
                sections.append((current_title, section_body))
        return sections

    def _build_chunks_for_video(self, video_id: str) -> tuple[Any, list[KnowledgeIndexChunkRecord]]:
        asset = self._repository.get_video_asset(video_id)
        if asset is None or asset.latest_result is None:
            return None, []
        result = asset.latest_result
        now = datetime.now(timezone.utc)
        chunk_specs: list[dict[str, object]] = []

        overview_parts = [str(result.overview or "").strip(), *[str(item).strip() for item in result.key_points if str(item).strip()]]
        overview_text = "\n".join([part for part in overview_parts if part]).strip()
        if overview_text:
            chunk_specs.append(
                {
                    "index_type": "video_summary",
                    "segment_order": 0,
                    "anchor_label": None,
                    "anchor_seconds": None,
                    "content": f"{asset.title}\n{overview_text}",
                }
            )

        for index, chapter in enumerate(result.timeline):
            if not isinstance(chapter, dict):
                continue
            title = str(chapter.get("title") or f"章节 {index + 1}").strip()
            summary = str(chapter.get("summary") or "").strip()
            start_raw = chapter.get("start")
            start = float(start_raw) if isinstance(start_raw, (int, float)) else None
            content = "\n".join([asset.title, title, summary]).strip()
            if summary:
                chunk_specs.append(
                    {
                        "index_type": "chapter",
                        "segment_order": index + 1,
                        "anchor_label": title,
                        "anchor_seconds": start,
                        "content": content,
                    }
                )

        for index, (title, body) in enumerate(self._split_markdown_sections(result.knowledge_note_markdown)):
            chunk_specs.append(
                {
                    "index_type": "knowledge_note",
                    "segment_order": index + 1,
                    "anchor_label": title,
                    "anchor_seconds": None,
                    "content": f"{asset.title}\n{title}\n{body}".strip(),
                }
            )

        chunk_specs = [item for item in chunk_specs if str(item["content"]).strip()]
        if not chunk_specs:
            return asset, []

        vectors = self._embed_texts([str(item["content"]) for item in chunk_specs])
        chunks = [
            KnowledgeIndexChunkRecord(
                chunk_id=f"{video_id}:{item['index_type']}:{item['segment_order'] or 0}",
                video_id=video_id,
                embedding_json=json.dumps(vectors[index], ensure_ascii=False),
                indexed_content=str(item["content"]),
                index_type=str(item["index_type"]),
                segment_order=int(item["segment_order"]) if item["segment_order"] is not None else None,
                anchor_label=str(item["anchor_label"]) if item["anchor_label"] else None,
                anchor_seconds=float(item["anchor_seconds"]) if item["anchor_seconds"] is not None else None,
                created_at=now,
                updated_at=now,
            )
            for index, item in enumerate(chunk_specs)
        ]
        return asset, chunks

    def index_video(self, video_id: str, content: str | None = None) -> bool:
        del content
        asset, chunks = self._build_chunks_for_video(video_id)
        if asset is None:
            return False

        collection = self._get_collection()
        try:
            collection.delete(where={"video_id": video_id})
        except Exception:
            pass

        self._repository.replace_knowledge_chunks(video_id, chunks)
        if not chunks:
            return True

        tags = [item.tag for item in self._repository.list_video_tags(video_id)]
        collection.add(
            ids=[chunk.chunk_id for chunk in chunks],
            documents=[chunk.indexed_content for chunk in chunks],
            embeddings=[json.loads(chunk.embedding_json) for chunk in chunks],
            metadatas=[
                {
                    "video_id": chunk.video_id,
                    "index_type": chunk.index_type,
                    "anchor_label": chunk.anchor_label or "",
                    "anchor_seconds": float(chunk.anchor_seconds) if chunk.anchor_seconds is not None else -1.0,
                    "title": asset.title,
                    "cover_url": asset.cover_url or "",
                    "tags_json": json.dumps(tags, ensure_ascii=False),
                }
                for chunk in chunks
            ],
        )
        return True

    def remove_video(self, video_id: str) -> bool:
        self._repository.delete_knowledge_chunks(video_id)
        try:
            self._get_collection().delete(where={"video_id": video_id})
        except HTTPException:
            raise
        except Exception:
            pass
        return True

    def rebuild_index(self, force: bool = False) -> int:
        del force
        videos = [video for video in self._repository.list_video_assets() if video.latest_result is not None]
        collection = self._get_collection()
        try:
            existing = collection.get()
            ids = existing.get("ids") if isinstance(existing, dict) else None
            if ids:
                collection.delete(ids=ids)
        except Exception:
            pass

        self._repository.clear_knowledge_chunks()
        count = 0
        for video in videos:
            if self.index_video(video.video_id):
                count += 1
        return count

    def _fetch_candidate_chunks(self, query: str, limit: int = 10, tag_filter: list[str] | None = None) -> list[dict[str, object]]:
        cleaned_query = str(query or "").strip()
        if not cleaned_query:
            return []
        if self._repository.get_knowledge_chunk_count() == 0:
            self.rebuild_index()

        effective_limit = max(limit * 4, 12)
        query_embedding = self._embed_texts([cleaned_query])[0]
        query_result = self._get_collection().query(
            query_embeddings=[query_embedding],
            n_results=effective_limit,
        )
        ids = query_result.get("ids", [[]])[0] if isinstance(query_result, dict) else []
        documents = query_result.get("documents", [[]])[0] if isinstance(query_result, dict) else []
        metadatas = query_result.get("metadatas", [[]])[0] if isinstance(query_result, dict) else []
        distances = query_result.get("distances", [[]])[0] if isinstance(query_result, dict) else []

        allowed_video_ids: set[str] | None = None
        if tag_filter:
            selected = {tag.strip() for tag in tag_filter if str(tag).strip()}
            if selected:
                allowed_video_ids = {
                    item.video_id
                    for item in self._repository.list_all_video_tags()
                    if item.tag in selected
                }

        candidates: list[dict[str, object]] = []
        for index, chunk_id in enumerate(ids):
            metadata = metadatas[index] if index < len(metadatas) and isinstance(metadatas[index], dict) else {}
            video_id = str(metadata.get("video_id") or "")
            if allowed_video_ids is not None and video_id not in allowed_video_ids:
                continue
            distance = float(distances[index]) if index < len(distances) else 1.0
            relevance = max(0.0, 1.0 - distance / 2.0)
            candidates.append(
                {
                    "chunk_id": chunk_id,
                    "video_id": video_id,
                    "document": documents[index] if index < len(documents) else "",
                    "metadata": metadata,
                    "relevance_score": round(relevance, 4),
                }
            )
        return candidates

    def search(self, query: str, limit: int = 10, tag_filter: list[str] | None = None) -> list[KnowledgeSearchResult]:
        candidates = self._fetch_candidate_chunks(query, limit=limit, tag_filter=tag_filter)
        if not candidates:
            return []

        grouped: dict[str, dict[str, object]] = {}
        for candidate in candidates:
            video_id = str(candidate["video_id"])
            current = grouped.get(video_id)
            if current is None or float(candidate["relevance_score"]) > float(current["relevance_score"]):
                grouped[video_id] = candidate

        ordered = sorted(grouped.values(), key=lambda item: float(item["relevance_score"]), reverse=True)[: max(1, limit)]
        results: list[KnowledgeSearchResult] = []
        for candidate in ordered:
            video_id = str(candidate["video_id"])
            asset = self._repository.get_video_asset(video_id)
            metadata = candidate["metadata"] if isinstance(candidate["metadata"], dict) else {}
            snippet = str(candidate["document"]).strip().replace("\n", " ")
            snippet = snippet[:180].rstrip() + ("..." if len(snippet) > 180 else "")
            tags = [item.tag for item in self._repository.list_video_tags(video_id)]
            results.append(
                KnowledgeSearchResult(
                    video_id=video_id,
                    title=asset.title if asset is not None else str(metadata.get("title") or "未知视频"),
                    relevance_score=float(candidate["relevance_score"]),
                    snippet=snippet,
                    tags=tags,
                    cover_url=asset.cover_url if asset is not None else str(metadata.get("cover_url") or ""),
                    timestamp=format_anchor_seconds(
                        float(metadata["anchor_seconds"])
                        if metadata.get("anchor_seconds") not in {None, "", -1, -1.0}
                        else None
                    ),
                )
            )
        return results

    def search_chunks(self, query: str, limit: int = 5, tag_filter: list[str] | None = None) -> list[dict[str, object]]:
        return self._fetch_candidate_chunks(query, limit=limit, tag_filter=tag_filter)[: max(1, limit)]
