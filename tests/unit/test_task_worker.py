import sqlite3
import time
from pathlib import Path
from threading import Event

from video_sum_core.models.tasks import InputType, TaskInput, TaskResult, TaskStatus
from video_sum_core.pipeline.base import PipelineContext, PipelineEvent, PipelineRunner
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import VideoAssetRecord, VideoPageOptionResponse
from video_sum_service.worker import TaskWorker


class FakePipelineRunner(PipelineRunner):
    def __init__(self, result: TaskResult) -> None:
        self._result = result

    def run(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        return [], self._result


class FakeVisualPipelineRunner(FakePipelineRunner):
    def __init__(self, result: TaskResult) -> None:
        super().__init__(result)
        self.visual_inputs: list[TaskInput] = []
        self.visual_force_values: list[bool] = []

    def build_and_export_visual_evidence(self, task_id: str, task_input: TaskInput, title: str, result: TaskResult, mode=None, force=False, on_event=None):
        self.visual_inputs.append(task_input)
        self.visual_force_values.append(force)
        visual_dir = Path(f"C:/tmp/{task_id}-visual")
        if on_event is not None:
            on_event(PipelineEvent(stage="visual_note_composing", progress=92, message="正在整合图文笔记"))
        context = {"status": "ready", "frame_count": 1, "insert_count": 1, "warnings": [], "mode": mode or "frame_insert"}
        return context, visual_dir / "visual_note.md", visual_dir / "visual_context.json"


class BlockingPipelineRunner(PipelineRunner):
    def __init__(self) -> None:
        self.started: list[str] = []
        self._release_by_task: dict[str, Event] = {}

    def run(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        self.started.append(context.task_id)
        gate = self._release_by_task.setdefault(context.task_id, Event())
        gate.wait(timeout=5)
        return [], TaskResult(overview=context.task_id)

    def release(self, task_id: str) -> None:
        self._release_by_task.setdefault(task_id, Event()).set()


class BlockingSummaryAndMindmapRunner(BlockingPipelineRunner):
    def __init__(self) -> None:
        super().__init__()
        self.mindmap_started: list[str] = []
        self._mindmap_release_by_task: dict[str, Event] = {}

    def build_and_export_mindmap(self, task_id: str, title: str, result: TaskResult):
        self.mindmap_started.append(task_id)
        gate = self._mindmap_release_by_task.setdefault(task_id, Event())
        gate.wait(timeout=5)
        mindmap = type(
            "MindMap",
            (),
            {"root": "root", "nodes": [type("Node", (), {"children": []})()]},
        )()
        return mindmap, Path(f"C:/tmp/{task_id}-mindmap.json")

    def release_mindmap(self, task_id: str) -> None:
        self._mindmap_release_by_task.setdefault(task_id, Event()).set()

    def build_and_export_visual_evidence(self, task_id: str, task_input: TaskInput, title: str, result: TaskResult, mode=None, on_event=None):
        visual_dir = Path(f"C:/tmp/{task_id}-visual")
        context = {
            "status": "ready",
            "frame_count": 1,
            "insert_count": 1,
            "mode": mode or "frame_insert",
            "warnings": [],
            "observations": [{"frame_id": "f0001", "timestamp_seconds": 0, "caption": "画面"}],
        }
        return context, visual_dir / "visual_note.md", visual_dir / "visual_context.json"


class PartialFailurePipelineRunner(PipelineRunner):
    def preflight(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        if on_event is not None:
            on_event(PipelineEvent(stage="preflight", progress=2, message="预检通过"))

    def run(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        if on_event is not None:
            on_event(
                PipelineEvent(
                    stage="transcribing",
                    progress=86,
                    message="转写完成，已保存可复用文本",
                    payload={
                        "result": TaskResult(
                            transcript_text="[00:00] 测试转写",
                            artifacts={
                                "transcript_path": "C:/tmp/transcript.txt",
                                "summary_path": "C:/tmp/summary.json",
                            },
                        ).model_dump(mode="json"),
                        "result_scope": "transcript",
                    },
                )
            )
        raise RuntimeError("llm api key invalid")


class PreflightFailurePipelineRunner(PipelineRunner):
    def __init__(self) -> None:
        self.run_called = False

    def preflight(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        raise RuntimeError("llm preflight failed")

    def run(self, context: PipelineContext, on_event=None):  # type: ignore[override]
        self.run_called = True
        return [], TaskResult()


class TrackingTaskWorker(TaskWorker):
    def __init__(
        self,
        repository: SqliteTaskRepository,
        pipeline_runner: PipelineRunner,
        *,
        auto_generate_mindmap: bool,
        auto_generate_visual_evidence: bool = False,
    ) -> None:
        super().__init__(
            repository,
            pipeline_runner,
            auto_generate_mindmap=auto_generate_mindmap,
            auto_generate_visual_evidence=auto_generate_visual_evidence,
        )
        self.mindmap_calls: list[tuple[str, bool]] = []
        self.visual_calls: list[tuple[str, bool]] = []

    def submit_mindmap(self, task_id: str, *, force: bool = False) -> None:  # type: ignore[override]
        self.mindmap_calls.append((task_id, force))

    def submit_visual_evidence(self, task_id: str, *, force: bool = False) -> None:  # type: ignore[override]
        self.visual_calls.append((task_id, force))


def create_repository() -> SqliteTaskRepository:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    repository = SqliteTaskRepository(connection)
    repository.initialize()
    return repository


def create_task(repository: SqliteTaskRepository):
    return repository.create_task(
        TaskInput(input_type=InputType.URL, source="https://example.com/video", title="测试视频")
    )


def wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition not met before timeout")


def test_worker_auto_generates_mindmap_when_enabled() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记",
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=True)

    worker._run_task(record.task_id)

    refreshed = repository.get_task(record.task_id)
    assert refreshed is not None
    assert refreshed.status == TaskStatus.COMPLETED
    assert worker.mindmap_calls == [(record.task_id, False)]


def test_worker_skips_auto_mindmap_when_disabled() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记",
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=False)

    worker._run_task(record.task_id)

    assert worker.mindmap_calls == []


def test_worker_skips_auto_mindmap_when_required_inputs_are_missing() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="",
        artifacts={},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=True)

    worker._run_task(record.task_id)

    assert worker.mindmap_calls == []


def test_worker_auto_generates_visual_evidence_when_enabled() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记",
        timeline=[{"title": "章节", "start": 0.0, "summary": "摘要"}],
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    worker = TrackingTaskWorker(
        repository,
        FakeVisualPipelineRunner(result),
        auto_generate_mindmap=False,
        auto_generate_visual_evidence=True,
    )

    worker._run_task(record.task_id)

    assert worker.visual_calls == [(record.task_id, False)]


def test_worker_visual_evidence_uses_bound_video_page_for_transcript_tasks() -> None:
    repository = create_repository()
    video = repository.upsert_video_asset(
        VideoAssetRecord(
            canonical_id="BV1visual",
            platform="bilibili",
            title="合集",
            source_url="https://www.bilibili.com/video/BV1visual",
            pages=[
                VideoPageOptionResponse(page=1, title="P1", source_url="https://www.bilibili.com/video/BV1visual?p=1"),
                VideoPageOptionResponse(page=72, title="P72", source_url="https://www.bilibili.com/video/BV1visual?p=72"),
            ],
        )
    )
    record = repository.create_task(
        TaskInput(input_type=InputType.TRANSCRIPT_TEXT, source='{"transcript":"[00:00] 内容"}', title="P72"),
        video_id=video.video_id,
        page_number=72,
        page_title="P72",
    )
    result = TaskResult(
        overview="概览",
        knowledge_note_markdown="# 知识笔记",
        timeline=[{"title": "章节", "start": 0.0, "summary": "摘要"}],
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    repository.save_result(record.task_id, result)
    repository.update_status(record.task_id, TaskStatus.COMPLETED)
    runner = FakeVisualPipelineRunner(result)
    worker = TaskWorker(repository, runner, auto_generate_mindmap=False)

    worker._run_visual_evidence(record.task_id, force=True)

    assert runner.visual_inputs
    visual_input = runner.visual_inputs[0]
    assert visual_input.input_type == InputType.URL
    assert visual_input.source == "https://www.bilibili.com/video/BV1visual?p=72"
    assert visual_input.title == "P72"
    assert runner.visual_force_values == [True]


def test_worker_skips_auto_visual_evidence_when_disabled() -> None:
    repository = create_repository()
    record = create_task(repository)
    result = TaskResult(
        overview="概览",
        timeline=[{"title": "章节", "start": 0.0, "summary": "摘要"}],
        artifacts={"summary_path": str(Path("C:/tmp/summary.json"))},
    )
    worker = TrackingTaskWorker(repository, FakePipelineRunner(result), auto_generate_mindmap=False)

    worker._run_task(record.task_id)

    assert worker.visual_calls == []


def test_worker_preserves_transcript_result_when_summary_phase_fails() -> None:
    repository = create_repository()
    record = create_task(repository)
    worker = TaskWorker(repository, PartialFailurePipelineRunner(), auto_generate_mindmap=False)

    worker._run_task(record.task_id)

    refreshed = repository.get_task(record.task_id)
    assert refreshed is not None
    assert refreshed.status == TaskStatus.FAILED
    assert refreshed.result is not None
    assert refreshed.result.transcript_text == "[00:00] 测试转写"
    assert refreshed.result.artifacts["summary_path"] == "C:/tmp/summary.json"


def test_worker_stops_before_run_when_preflight_fails() -> None:
    repository = create_repository()
    record = create_task(repository)
    runner = PreflightFailurePipelineRunner()
    worker = TaskWorker(repository, runner, auto_generate_mindmap=False)

    worker._run_task(record.task_id)

    refreshed = repository.get_task(record.task_id)
    assert refreshed is not None
    assert refreshed.status == TaskStatus.FAILED
    assert runner.run_called is False


def test_worker_limits_summary_task_concurrency() -> None:
    repository = create_repository()
    records = [create_task(repository) for _ in range(3)]
    runner = BlockingPipelineRunner()
    worker = TaskWorker(repository, runner, auto_generate_mindmap=False, task_concurrency=1)

    for record in records:
        worker.submit(record)

    wait_for(lambda: len(runner.started) == 1)
    statuses = {record.task_id: repository.get_task(record.task_id).status for record in records if repository.get_task(record.task_id)}
    assert list(statuses.values()).count(TaskStatus.RUNNING) == 1
    assert list(statuses.values()).count(TaskStatus.QUEUED) == 2

    first_task_id = runner.started[0]
    runner.release(first_task_id)
    wait_for(lambda: len(runner.started) == 2)

    second_running = [task_id for task_id in runner.started if repository.get_task(task_id).status == TaskStatus.RUNNING]
    assert len(second_running) == 1

    second_task_id = [task_id for task_id in runner.started if task_id != first_task_id][0]
    runner.release(second_task_id)
    wait_for(lambda: len(runner.started) == 3)

    for task_id in runner.started:
        runner.release(task_id)
    wait_for(lambda: all(repository.get_task(record.task_id).status == TaskStatus.COMPLETED for record in records))


def test_worker_uses_separate_summary_and_mindmap_pools() -> None:
    repository = create_repository()
    summary_record = create_task(repository)
    mindmap_record = create_task(repository)
    repository.save_result(
        mindmap_record.task_id,
        TaskResult(
            overview="概览",
            knowledge_note_markdown="# 笔记",
            artifacts={"summary_path": "C:/tmp/summary.json"},
        ),
    )
    repository.update_status(mindmap_record.task_id, TaskStatus.COMPLETED)

    runner = BlockingSummaryAndMindmapRunner()
    worker = TaskWorker(repository, runner, auto_generate_mindmap=False, task_concurrency=1, mindmap_concurrency=1)

    worker.submit(summary_record)
    worker.submit_mindmap(mindmap_record.task_id)

    wait_for(lambda: len(runner.started) == 1)
    wait_for(lambda: len(runner.mindmap_started) == 1)

    assert repository.get_task(summary_record.task_id).status == TaskStatus.RUNNING
    refreshed_mindmap_record = repository.get_task(mindmap_record.task_id)
    assert refreshed_mindmap_record is not None
    assert refreshed_mindmap_record.result is not None
    assert refreshed_mindmap_record.result.mindmap_status == "generating"

    runner.release(summary_record.task_id)
    runner.release_mindmap(mindmap_record.task_id)
    wait_for(lambda: repository.get_task(summary_record.task_id).status == TaskStatus.COMPLETED)


def test_worker_close_for_new_work_preserves_existing_queue() -> None:
    repository = create_repository()
    records = [create_task(repository) for _ in range(2)]
    runner = BlockingPipelineRunner()
    worker = TaskWorker(repository, runner, auto_generate_mindmap=False, task_concurrency=1)

    worker.submit(records[0])
    worker.submit(records[1])
    wait_for(lambda: len(runner.started) == 1)

    worker.close_for_new_work()
    rejected_record = create_task(repository)
    worker.submit(rejected_record)
    time.sleep(0.1)

    runner.release(records[0].task_id)
    wait_for(lambda: len(runner.started) == 2)
    runner.release(records[1].task_id)
    wait_for(lambda: repository.get_task(records[1].task_id).status == TaskStatus.COMPLETED)

    assert repository.get_latest_event(rejected_record.task_id) is None
    assert repository.get_task(rejected_record.task_id).status == TaskStatus.QUEUED


def test_worker_shutdown_cancels_pending_jobs() -> None:
    repository = create_repository()
    records = [create_task(repository) for _ in range(2)]
    runner = BlockingPipelineRunner()
    worker = TaskWorker(repository, runner, auto_generate_mindmap=False, task_concurrency=1)

    worker.submit(records[0])
    worker.submit(records[1])
    wait_for(lambda: len(runner.started) == 1)

    worker.shutdown(wait=False, cancel_pending=True)
    runner.release(records[0].task_id)
    wait_for(lambda: repository.get_task(records[0].task_id).status == TaskStatus.COMPLETED)
    time.sleep(0.1)

    assert runner.started == [records[0].task_id]
