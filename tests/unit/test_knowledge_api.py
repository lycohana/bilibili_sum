import sqlite3

import httpx
from fastapi import HTTPException

from video_sum_core.models.tasks import TaskResult
from video_sum_infra.config import ServiceSettings
from video_sum_service.app import app
from video_sum_service.knowledge.index_service import KnowledgeIndexService
from video_sum_service.knowledge.local_llm import chat_knowledge_llm
from video_sum_service.knowledge.rag_service import RagService
from video_sum_service.knowledge.tag_service import TagService
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.routers import knowledge as knowledge_router
from video_sum_service.schemas import VideoAssetRecord


class FakeEmbedder:
    def encode(self, texts, normalize_embeddings=True):
        del normalize_embeddings
        return [[float(index + 1), 1.0, 0.5] for index, _text in enumerate(texts)]


class FakeCollection:
    def __init__(self) -> None:
        self.items: list[dict[str, object]] = []

    def add(self, ids, documents, embeddings, metadatas):
        for index, chunk_id in enumerate(ids):
            self.items = [item for item in self.items if item["id"] != chunk_id]
            self.items.append(
                {
                    "id": chunk_id,
                    "document": documents[index],
                    "embedding": embeddings[index],
                    "metadata": metadatas[index],
                }
            )

    def delete(self, ids=None, where=None):
        if ids is not None:
            id_set = set(ids)
            self.items = [item for item in self.items if item["id"] not in id_set]
        elif where and "video_id" in where:
            self.items = [item for item in self.items if item["metadata"].get("video_id") != where["video_id"]]

    def get(self):
        return {"ids": [item["id"] for item in self.items]}

    def query(self, query_embeddings, n_results):
        del query_embeddings
        ranked = sorted(
            self.items,
            key=lambda item: (
                0 if float(item["metadata"].get("anchor_seconds", -1.0) or -1.0) >= 0 else 1,
                str(item["id"]),
            ),
        )[:n_results]
        return {
            "ids": [[item["id"] for item in ranked]],
            "documents": [[item["document"] for item in ranked]],
            "metadatas": [[item["metadata"] for item in ranked]],
            "distances": [[0.1 + index * 0.05 for index, _item in enumerate(ranked)]],
        }


class FakeKnowledgeIndexService(KnowledgeIndexService):
    def __init__(self, repository, settings) -> None:
        super().__init__(repository, settings)
        self._fake_collection = FakeCollection()
        self._embedder = FakeEmbedder()

    def _get_embedder(self):
        return self._embedder

    def _get_collection(self):
        return self._fake_collection


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def create_request(repository: SqliteTaskRepository):
    app.state.task_repository = repository
    return type("Request", (), {"app": app})()


def seed_video(repository: SqliteTaskRepository, video_id_suffix: str = "knowledge") -> VideoAssetRecord:
    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id=f"BV-{video_id_suffix}",
            platform="bilibili",
            title="答题卡识别判卷",
            source_url=f"https://www.bilibili.com/video/BV-{video_id_suffix}",
        )
    )
    repository.save_result(
        repository.create_task(
            task_input=type("TaskInputProxy", (), {"model_dump": lambda self, mode='json': {}})(),  # type: ignore[arg-type]
        ).task_id,
        TaskResult(),
    )
    result = TaskResult(
        overview="视频讲解了答题卡识别和判卷流程。",
        knowledge_note_markdown="# 判卷流程\n\n先做轮廓检测，再进行填涂识别。",
        key_points=["轮廓检测是前置步骤", "填涂识别依赖透视校正"],
        timeline=[
            {"title": "轮廓检测", "start": 12, "summary": "先定位答题卡外轮廓。"},
            {"title": "填涂识别", "start": 87, "summary": "再识别涂黑区域并判分。"},
        ],
        artifacts={"summary_path": "C:/tmp/summary.json"},
    )
    task = repository.create_task(
        type("TaskInputProxy", (), {"model_dump": lambda self, mode='json': {}})(),  # type: ignore[arg-type]
        video_id=video.video_id,
    )
    repository.save_result(task.task_id, result)
    repository.update_status(task.task_id, "completed")  # type: ignore[arg-type]
    return repository.get_video_asset(video.video_id) or video


def seed_video_with_real_task(repository: SqliteTaskRepository, video_id_suffix: str = "knowledge") -> VideoAssetRecord:
    from video_sum_core.models.tasks import InputType, TaskInput, TaskStatus

    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id=f"BV-{video_id_suffix}",
            platform="bilibili",
            title="答题卡识别判卷",
            source_url=f"https://www.bilibili.com/video/BV-{video_id_suffix}",
        )
    )
    task = repository.create_task(TaskInput(input_type=InputType.URL, source=video.source_url, title=video.title), video_id=video.video_id)
    repository.save_result(
        task.task_id,
        TaskResult(
            overview="视频讲解了答题卡识别和判卷流程。",
            knowledge_note_markdown="# 判卷流程\n\n先做轮廓检测，再进行填涂识别。",
            key_points=["轮廓检测是前置步骤", "填涂识别依赖透视校正"],
            timeline=[
                {"title": "轮廓检测", "start": 12, "summary": "先定位答题卡外轮廓。"},
                {"title": "填涂识别", "start": 87, "summary": "再识别涂黑区域并判分。"},
            ],
            artifacts={"summary_path": "C:/tmp/summary.json"},
        ),
    )
    repository.update_status(task.task_id, TaskStatus.COMPLETED)
    return repository.get_video_asset(video.video_id) or video


def test_knowledge_tag_crud_and_network() -> None:
    repository = create_repository()
    video = seed_video_with_real_task(repository, "tag-network")
    repository.add_video_tag(video.video_id, "AI")
    repository.add_video_tag(video.video_id, "OpenCV")
    second_video = seed_video_with_real_task(repository, "tag-network-2")
    repository.add_video_tag(second_video.video_id, "AI")
    repository.add_video_tag(second_video.video_id, "CV")
    request = create_request(repository)
    settings = ServiceSettings(llm_enabled=False)
    tag_service = TagService(repository, settings)
    index_service = FakeKnowledgeIndexService(repository, settings)
    rag_service = RagService(repository, index_service, tag_service, settings)
    knowledge_router._get_services = lambda req: (tag_service, index_service, rag_service)  # type: ignore[assignment]

    all_tags = knowledge_router.get_tags(request)
    network = knowledge_router.get_network(request)
    focused_network = knowledge_router.get_network(request, selected_tag=["AI"], max_tags=12, max_videos=8)
    deleted = knowledge_router.delete_tag(video.video_id, "OpenCV", request)

    assert {item.tag for item in all_tags.items} >= {"AI", "OpenCV", "CV"}
    assert network.mode == "overview"
    assert all(node.type == "tag" for node in network.nodes)
    assert any(link.kind == "cooccurrence" for link in network.links)
    assert focused_network.mode == "focus"
    assert any(node.type == "video" for node in focused_network.nodes)
    assert any(link.kind == "association" for link in focused_network.links)
    assert all(item.tag != "OpenCV" for item in deleted.items)


def test_knowledge_search_returns_snippet_and_timestamp() -> None:
    repository = create_repository()
    video = seed_video_with_real_task(repository, "search")
    repository.add_video_tag(video.video_id, "CV")
    request = create_request(repository)
    settings = ServiceSettings(llm_enabled=False)
    tag_service = TagService(repository, settings)
    index_service = FakeKnowledgeIndexService(repository, settings)
    rag_service = RagService(repository, index_service, tag_service, settings)
    knowledge_router._get_services = lambda req: (tag_service, index_service, rag_service)  # type: ignore[assignment]
    index_service.index_video(video.video_id)

    response = knowledge_router.search_knowledge(
        type("Body", (), {"query": "轮廓检测", "limit": 10, "filters": type("Filters", (), {"tags": ["CV"]})()})(),
        request,
    )

    assert response.total >= 1
    assert response.results[0].snippet
    assert response.results[0].timestamp is not None


def test_knowledge_ask_accepts_remote_custom_llm(monkeypatch) -> None:
    repository = create_repository()
    video = seed_video_with_real_task(repository, "ask")
    request = create_request(repository)
    settings = ServiceSettings(
        knowledge_llm_mode="custom",
        knowledge_llm_enabled=True,
        knowledge_llm_base_url="https://api.example.com/v1",
        knowledge_llm_model="remote-model",
    )
    tag_service = TagService(repository, settings)
    index_service = FakeKnowledgeIndexService(repository, settings)
    rag_service = RagService(repository, index_service, tag_service, settings)
    knowledge_router._get_services = lambda req: (tag_service, index_service, rag_service)  # type: ignore[assignment]
    index_service.index_video(video.video_id)
    monkeypatch.setattr(
        "video_sum_service.knowledge.rag_service.chat_knowledge_llm",
        lambda *args, **kwargs: ("先做轮廓检测，再做填涂识别。", {"choices": []}),
    )

    response = knowledge_router.ask_knowledge(type("Body", (), {"query": "讲了哪些步骤", "context_limit": 3})(), request)

    assert "轮廓检测" in response.answer
    assert response.sources


def test_knowledge_ask_stream_emits_tool_and_done_events(monkeypatch) -> None:
    repository = create_repository()
    video = seed_video_with_real_task(repository, "ask-stream")
    settings = ServiceSettings(
        knowledge_llm_mode="custom",
        knowledge_llm_enabled=True,
        knowledge_llm_base_url="https://api.example.com/v1",
        knowledge_llm_model="remote-model",
    )
    tag_service = TagService(repository, settings)
    index_service = FakeKnowledgeIndexService(repository, settings)
    rag_service = RagService(repository, index_service, tag_service, settings)
    index_service.index_video(video.video_id)

    monkeypatch.setattr(
        "video_sum_service.knowledge.rag_service.stream_knowledge_llm",
        lambda *args, **kwargs: iter(["先做轮廓检测", "，再做填涂识别。"]),
    )

    events = list(rag_service.ask_stream("讲了哪些步骤", context_limit=3))

    event_names = [name for name, _payload in events]
    assert "tool" in event_names
    assert "text_delta" in event_names
    assert "done" in event_names
    done_payload = next(payload for name, payload in events if name == "done")
    assert "轮廓检测" in str(done_payload["answer"])


def test_chat_knowledge_llm_returns_clear_timeout_error(monkeypatch) -> None:
    settings = ServiceSettings(
        knowledge_llm_mode="custom",
        knowledge_llm_enabled=True,
        knowledge_llm_base_url="https://api.example.com/v1",
        knowledge_llm_model="remote-model",
    )

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

        def post(self, *args, **kwargs):
            raise httpx.ReadTimeout("The read operation timed out")

    monkeypatch.setattr("video_sum_service.knowledge.local_llm.httpx.Client", FakeClient)

    try:
        chat_knowledge_llm(settings, system_prompt="system", user_prompt="user")
    except HTTPException as exc:
        assert exc.status_code == 504
        assert "响应超时" in str(exc.detail)
    else:
        raise AssertionError("expected HTTPException")
