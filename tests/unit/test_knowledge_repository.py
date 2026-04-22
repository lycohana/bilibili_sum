import sqlite3

from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import KnowledgeIndexChunkRecord, VideoAssetRecord


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def test_repository_creates_knowledge_tables() -> None:
    repository = create_repository()

    table_names = {
        row["name"]
        for row in repository._connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()  # noqa: SLF001
    }

    assert "video_tags" in table_names
    assert "knowledge_index" in table_names


def test_repository_promotes_manual_tag_over_auto_tag() -> None:
    repository = create_repository()
    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-knowledge-tag",
            platform="bilibili",
            title="标签视频",
            source_url="https://www.bilibili.com/video/BV-knowledge-tag",
        )
    )

    assert repository.add_video_tag(video.video_id, "AI", source="auto_llm", confidence=0.67) is True
    assert repository.add_video_tag(video.video_id, "AI", source="manual", confidence=1.0) is True

    tags = repository.list_video_tags(video.video_id)

    assert len(tags) == 1
    assert tags[0].tag == "AI"
    assert tags[0].source == "manual"
    assert tags[0].confidence == 1.0


def test_repository_replaces_knowledge_chunks_and_cleans_up_on_video_delete() -> None:
    repository = create_repository()
    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV-knowledge-index",
            platform="bilibili",
            title="索引视频",
            source_url="https://www.bilibili.com/video/BV-knowledge-index",
        )
    )
    repository.add_video_tag(video.video_id, "CV")
    repository.replace_knowledge_chunks(
        video.video_id,
        [
            KnowledgeIndexChunkRecord(
                chunk_id="chunk-1",
                video_id=video.video_id,
                embedding_json="[0.1, 0.2]",
                indexed_content="答题卡识别流程",
                index_type="chapter",
                segment_order=1,
                anchor_label="流程",
                anchor_seconds=12.0,
            )
        ],
    )

    assert repository.get_knowledge_chunk_count() == 1
    assert len(repository.list_video_tags(video.video_id)) == 1

    deleted = repository.delete_video_asset(video.video_id)

    assert deleted is True
    assert repository.get_knowledge_chunk_count() == 0
    assert repository.list_video_tags(video.video_id) == []
