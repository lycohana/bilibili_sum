from __future__ import annotations

import asyncio
import json
from queue import Empty, Queue
from threading import BoundedSemaphore, Event, Thread

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from video_sum_service.context import settings_manager
from video_sum_service.knowledge import KnowledgeIndexService, RagService, TagService
from video_sum_service.knowledge.local_llm import knowledge_llm_available
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import (
    KnowledgeAskRequest,
    KnowledgeAskResponse,
    KnowledgeAutoTagRequest,
    KnowledgeAutoTagResponse,
    KnowledgeNetworkResponse,
    KnowledgeRebuildResponse,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeStatsResponse,
    KnowledgeTagCreateRequest,
    TagListResponse,
    VideoTagListResponse,
)

router = APIRouter(prefix="/api/v1/knowledge")
_QUEUE_TIMEOUT = object()
_ASK_STREAM_SEMAPHORE = BoundedSemaphore(2)


def _get_queue_item(event_queue: Queue[object], timeout: float) -> object:
    try:
        return event_queue.get(timeout=timeout)
    except Empty:
        return _QUEUE_TIMEOUT


def _knowledge_settings_signature(settings) -> tuple[object, ...]:
    return (
        bool(settings.llm_enabled),
        str(settings.llm_base_url or ""),
        str(settings.llm_model or ""),
        str(settings.llm_api_key or ""),
        str(getattr(settings, "knowledge_llm_mode", "same_as_main") or "same_as_main"),
        bool(getattr(settings, "knowledge_llm_enabled", False)),
        str(getattr(settings, "knowledge_llm_base_url", "") or ""),
        str(getattr(settings, "knowledge_llm_model", "") or ""),
        str(getattr(settings, "knowledge_llm_api_key", "") or ""),
    )


def _get_services(request: Request) -> tuple[TagService, KnowledgeIndexService, RagService]:
    task_store: SqliteTaskRepository = request.app.state.task_repository
    settings = settings_manager.current
    settings_signature = _knowledge_settings_signature(settings)
    tag_service = getattr(request.app.state, "knowledge_tag_service", None)
    index_service = getattr(request.app.state, "knowledge_index_service", None)
    rag_service = getattr(request.app.state, "knowledge_rag_service", None)
    cached_signature = getattr(request.app.state, "knowledge_settings_signature", None)

    if tag_service is None or index_service is None or rag_service is None or cached_signature != settings_signature:
        tag_service = TagService(task_store, settings)
        index_service = KnowledgeIndexService(task_store, settings)
        rag_service = RagService(task_store, index_service, tag_service, settings)
        request.app.state.knowledge_tag_service = tag_service
        request.app.state.knowledge_index_service = index_service
        request.app.state.knowledge_rag_service = rag_service
        request.app.state.knowledge_settings_signature = settings_signature

    return tag_service, index_service, rag_service


@router.get("/tags", response_model=TagListResponse | VideoTagListResponse)
def get_tags(request: Request, video_id: str | None = None) -> TagListResponse | VideoTagListResponse:
    tag_service, _index_service, _rag_service = _get_services(request)
    if video_id:
        return VideoTagListResponse(video_id=video_id, items=tag_service.get_tags_for_video(video_id))
    return TagListResponse(items=tag_service.get_all_tags())


@router.post("/tags", response_model=VideoTagListResponse)
def create_tag(body: KnowledgeTagCreateRequest, request: Request) -> VideoTagListResponse:
    tag_service, index_service, _rag_service = _get_services(request)
    created = tag_service.add_tag(body.video_id, body.tag)
    if not created:
        raise HTTPException(status_code=404, detail="Video not found.")
    index_service.index_video(body.video_id)
    return VideoTagListResponse(video_id=body.video_id, items=tag_service.get_tags_for_video(body.video_id))


@router.delete("/tags/{video_id}/{tag}", response_model=VideoTagListResponse)
def delete_tag(video_id: str, tag: str, request: Request) -> VideoTagListResponse:
    tag_service, index_service, _rag_service = _get_services(request)
    removed = tag_service.remove_tag(video_id, tag)
    if not removed:
        raise HTTPException(status_code=404, detail="Tag not found.")
    index_service.index_video(video_id)
    return VideoTagListResponse(video_id=video_id, items=tag_service.get_tags_for_video(video_id))


@router.post("/auto-tag", response_model=KnowledgeAutoTagResponse)
def auto_tag(body: KnowledgeAutoTagRequest, request: Request) -> KnowledgeAutoTagResponse:
    tag_service, index_service, _rag_service = _get_services(request)
    response = tag_service.batch_auto_tag(body.video_ids)
    for item in response.items:
        index_service.index_video(item.video_id)
    return response


@router.get("/network", response_model=KnowledgeNetworkResponse)
def get_network(
    request: Request,
    selected_tag: list[str] | None = Query(default=None),
    max_tags: int = 12,
    max_videos: int = 8,
) -> KnowledgeNetworkResponse:
    tag_service, _index_service, _rag_service = _get_services(request)
    selected_values = selected_tag if isinstance(selected_tag, list) else None
    return tag_service.get_network_data(selected_values, max_tags=max_tags, max_videos=max_videos)


@router.post("/search", response_model=KnowledgeSearchResponse)
def search_knowledge(body: KnowledgeSearchRequest, request: Request) -> KnowledgeSearchResponse:
    _tag_service, index_service, _rag_service = _get_services(request)
    filters = body.filters.tags if body.filters is not None else []
    results = index_service.search(body.query, limit=body.limit, tag_filter=filters)
    return KnowledgeSearchResponse(query=body.query, results=results, total=len(results))


@router.post("/ask", response_model=KnowledgeAskResponse)
def ask_knowledge(body: KnowledgeAskRequest, request: Request) -> KnowledgeAskResponse:
    _tag_service, _index_service, rag_service = _get_services(request)
    return rag_service.ask(
        body.query,
        context_limit=body.context_limit,
        history=getattr(body, "history", []),
    )


@router.post("/ask/stream")
async def ask_knowledge_stream(body: KnowledgeAskRequest, request: Request) -> StreamingResponse:
    _tag_service, _index_service, rag_service = _get_services(request)

    async def event_generator():
        event_queue: Queue[object] = Queue()
        cancel_event = Event()

        def produce_events() -> None:
            acquired = _ASK_STREAM_SEMAPHORE.acquire(blocking=False)
            if not acquired:
                event_queue.put(
                    HTTPException(
                        status_code=429,
                        detail="知识库问答任务较多，请等待当前回答结束后再试。",
                    )
                )
                event_queue.put(None)
                return
            try:
                for event in rag_service.ask_stream(
                    body.query,
                    context_limit=body.context_limit,
                    history=getattr(body, "history", []),
                    should_cancel=cancel_event.is_set,
                ):
                    if cancel_event.is_set():
                        return
                    event_queue.put(event)
            except Exception as exc:  # pragma: no cover - surfaced to the SSE client below
                event_queue.put(exc)
            finally:
                _ASK_STREAM_SEMAPHORE.release()
                event_queue.put(None)

        worker = Thread(target=produce_events, daemon=True, name="knowledge-ask-stream")
        worker.start()

        try:
            while True:
                if await request.is_disconnected():
                    cancel_event.set()
                    return
                item = await asyncio.to_thread(_get_queue_item, event_queue, 1.5)
                if item is _QUEUE_TIMEOUT:
                    yield ": keep-alive\n\n"
                    continue
                if item is None:
                    return
                if isinstance(item, HTTPException):
                    raise item
                if isinstance(item, Exception):
                    raise item
                event_name, payload = item
                yield f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except HTTPException as exc:
            yield (
                "event: error\n"
                f"data: {json.dumps({'message': str(exc.detail), 'status_code': exc.status_code}, ensure_ascii=False)}\n\n"
            )
        except Exception as exc:  # pragma: no cover - defensive fallback
            yield f"event: error\ndata: {json.dumps({'message': f'知识库问答失败：{exc}'}, ensure_ascii=False)}\n\n"
        finally:
            cancel_event.set()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/stats", response_model=KnowledgeStatsResponse)
def get_knowledge_stats(request: Request) -> KnowledgeStatsResponse:
    tag_service, index_service, _rag_service = _get_services(request)
    task_store: SqliteTaskRepository = request.app.state.task_repository
    settings = settings_manager.current
    return KnowledgeStatsResponse(
        video_count=len(task_store.list_video_assets()),
        indexed_chunk_count=task_store.get_knowledge_chunk_count(),
        tag_count=len(tag_service.get_all_tags()),
        untagged_video_count=len(task_store.list_untagged_video_ids()),
        knowledge_llm_available=knowledge_llm_available(settings),
    )


@router.post("/rebuild-index", response_model=KnowledgeRebuildResponse)
def rebuild_index(request: Request) -> KnowledgeRebuildResponse:
    _tag_service, index_service, _rag_service = _get_services(request)
    return KnowledgeRebuildResponse(indexed_videos=index_service.rebuild_index(force=True))
