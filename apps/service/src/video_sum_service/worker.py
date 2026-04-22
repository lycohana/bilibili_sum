import logging
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Condition, Lock, Thread

from video_sum_core.models.tasks import TaskResult, TaskStatus
from video_sum_core.pipeline.base import PipelineContext, PipelineRunner
from video_sum_infra.config import ServiceSettings
from video_sum_service.knowledge import KnowledgeIndexService
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import TaskRecord

logger = logging.getLogger("video_sum_service.worker")


@dataclass(frozen=True)
class _MindmapJob:
    task_id: str
    force: bool


class _TaskQueueState:
    def __init__(self, name: str, concurrency: int) -> None:
        self.name = name
        self.concurrency = max(1, int(concurrency))
        self.pending: deque[object] = deque()
        self.pending_ids: set[str] = set()
        self.running_ids: set[str] = set()

    def job_id_for(self, job: object) -> str:
        if isinstance(job, TaskRecord):
            return job.task_id
        if isinstance(job, _MindmapJob):
            return job.task_id
        raise TypeError(f"Unsupported job type: {type(job)!r}")


class TaskWorker:
    """Background worker with separate queues for summary and mindmap work."""

    def __init__(
        self,
        repository: SqliteTaskRepository,
        pipeline_runner: PipelineRunner,
        *,
        auto_generate_mindmap: bool = False,
        knowledge_index_auto_rebuild: str = "disabled",
        knowledge_index_settings: ServiceSettings | None = None,
        task_concurrency: int = 1,
        mindmap_concurrency: int = 1,
    ) -> None:
        self._repository = repository
        self._pipeline_runner = pipeline_runner
        self._auto_generate_mindmap = auto_generate_mindmap
        self._knowledge_index_auto_rebuild = str(knowledge_index_auto_rebuild or "disabled")
        self._knowledge_index_settings = knowledge_index_settings or ServiceSettings()
        self._task_state = _TaskQueueState("task", task_concurrency)
        self._mindmap_state = _TaskQueueState("mindmap", mindmap_concurrency)
        self._lock = Lock()
        self._condition = Condition(self._lock)
        self._accept_new_work = True
        self._shutdown_requested = False
        self._dispatch_threads = [
            Thread(target=self._dispatch_loop, args=(self._task_state, self._run_task_job), daemon=True),
            Thread(target=self._dispatch_loop, args=(self._mindmap_state, self._run_mindmap_job), daemon=True),
        ]
        for thread in self._dispatch_threads:
            thread.start()

    def submit(self, task: TaskRecord) -> None:
        logger.info(
            "queue summary task task_id=%s video_id=%s input_type=%s source=%s",
            task.task_id,
            task.video_id,
            task.task_input.input_type.value,
            task.task_input.source,
        )
        enqueued = self._enqueue(self._task_state, task)
        if enqueued:
            self._repository.update_status(task.task_id, TaskStatus.QUEUED)
            self._repository.append_event(
                task_id=task.task_id,
                stage="queued",
                progress=0,
                message="任务已进入后台队列",
            )

    def submit_mindmap(self, task_id: str, *, force: bool = False) -> None:
        logger.info("queue mindmap generation task_id=%s force=%s", task_id, force)
        enqueued = self._enqueue(self._mindmap_state, _MindmapJob(task_id=task_id, force=force))
        if enqueued:
            self._repository.append_event(
                task_id=task_id,
                stage="mindmap_queued",
                progress=100,
                message="思维导图已进入后台队列",
                payload={"force": force},
            )

    def close_for_new_work(self) -> None:
        with self._condition:
            self._accept_new_work = False
            self._condition.notify_all()

    def shutdown(self, wait: bool = False) -> None:
        with self._condition:
            self._accept_new_work = False
            self._shutdown_requested = True
            self._condition.notify_all()
        if wait:
            for thread in self._dispatch_threads:
                thread.join()

    def _enqueue(self, state: _TaskQueueState, job: object) -> bool:
        job_id = state.job_id_for(job)
        with self._condition:
            if not self._accept_new_work:
                logger.info("reject new %s job because worker is closed task_id=%s", state.name, job_id)
                return False
            if job_id in state.pending_ids or job_id in state.running_ids:
                logger.info("skip duplicate %s job task_id=%s", state.name, job_id)
                return False
            state.pending.append(job)
            state.pending_ids.add(job_id)
            self._condition.notify_all()
            return True

    def _dispatch_loop(self, state: _TaskQueueState, runner) -> None:
        while True:
            job = self._wait_for_available_job(state)
            if job is None:
                return
            job_id = state.job_id_for(job)
            thread = Thread(target=self._execute_job, args=(state, job, runner), daemon=True, name=f"{state.name}-{job_id}")
            thread.start()

    def _wait_for_available_job(self, state: _TaskQueueState) -> object | None:
        with self._condition:
            while True:
                if self._shutdown_requested and not state.pending and not state.running_ids:
                    return None
                if not self._accept_new_work and not state.pending and not state.running_ids:
                    return None
                if state.pending and len(state.running_ids) < state.concurrency:
                    job = state.pending.popleft()
                    job_id = state.job_id_for(job)
                    state.pending_ids.discard(job_id)
                    state.running_ids.add(job_id)
                    return job
                self._condition.wait()

    def _execute_job(self, state: _TaskQueueState, job: object, runner) -> None:
        job_id = state.job_id_for(job)
        try:
            runner(job)
        finally:
            with self._condition:
                state.running_ids.discard(job_id)
                self._condition.notify_all()

    def _run_task_job(self, task: TaskRecord) -> None:
        self._run_task(task.task_id)

    def _run_task(self, task_id: str) -> None:
        record = self._repository.get_task(task_id)
        if record is None:
            logger.warning("skip missing task task_id=%s", task_id)
            return

        logger.info(
            "start task execution task_id=%s video_id=%s title=%s",
            task_id,
            record.video_id,
            record.task_input.title,
        )

        self._repository.update_status(task_id, TaskStatus.RUNNING)
        self._repository.append_event(
            task_id=task_id,
            stage="running",
            progress=5,
            message="任务开始执行",
        )

        try:
            context = PipelineContext(task_id=task_id, task_input=record.task_input)

            def handle_pipeline_event(event) -> None:
                payload = dict(event.payload or {})
                result_payload = payload.get("result")
                if isinstance(result_payload, dict):
                    try:
                        partial_result = TaskResult.model_validate(result_payload)
                    except Exception:
                        logger.warning(
                            "skip invalid partial result task_id=%s stage=%s",
                            task_id,
                            event.stage,
                        )
                    else:
                        self._repository.save_result(task_id, partial_result)

                self._repository.append_event(
                    task_id=task_id,
                    stage=event.stage,
                    progress=event.progress,
                    message=event.message,
                    payload=payload,
                )

            self._pipeline_runner.preflight(
                context,
                on_event=handle_pipeline_event,
            )

            _, result = self._pipeline_runner.run(
                context,
                on_event=handle_pipeline_event,
            )

            final_result = result if isinstance(result, TaskResult) else TaskResult()
            self._repository.save_result(task_id, final_result)
            self._repository.update_status(task_id, TaskStatus.COMPLETED)
            self._repository.append_event(
                task_id=task_id,
                stage="completed",
                progress=100,
                message="任务已完成",
                payload={"completed_at": datetime.now(timezone.utc).isoformat()},
            )
            logger.info(
                "task completed task_id=%s key_points=%d timeline=%d transcript_chars=%d",
                task_id,
                len(final_result.key_points),
                len(final_result.timeline),
                len(final_result.transcript_text or ""),
            )
            if self._auto_generate_mindmap and self._can_auto_generate_mindmap(final_result):
                self.submit_mindmap(task_id)
            if self._knowledge_index_auto_rebuild == "on_task_completed":
                self._index_completed_task(record.video_id, task_id)
        except Exception as exc:
            logger.exception("task failed task_id=%s error=%s", task_id, exc)
            self._repository.update_error(task_id, "TASK_EXECUTION_FAILED", str(exc))
            self._repository.update_status(task_id, TaskStatus.FAILED)
            self._repository.append_event(
                task_id=task_id,
                stage="failed",
                progress=100,
                message="任务执行失败",
                payload={"error": str(exc)},
            )

    def _can_auto_generate_mindmap(self, result: TaskResult) -> bool:
        return bool(
            result.knowledge_note_markdown.strip()
            and result.artifacts.get("summary_path")
        )

    def _index_completed_task(self, video_id: str | None, task_id: str) -> None:
        if not video_id:
            return
        self._repository.append_event(
            task_id=task_id,
            stage="knowledge_index_refreshing",
            progress=100,
            message="正在刷新知识库索引",
        )
        try:
            index_service = KnowledgeIndexService(self._repository, self._knowledge_index_settings)
            indexed = index_service.index_video(video_id)
            self._repository.append_event(
                task_id=task_id,
                stage="knowledge_index_completed",
                progress=100,
                message="知识库索引已刷新",
                payload={"indexed": indexed},
            )
            logger.info("auto refreshed knowledge index video_id=%s indexed=%s", video_id, indexed)
        except Exception as exc:
            self._repository.append_event(
                task_id=task_id,
                stage="knowledge_index_failed",
                progress=100,
                message="知识库索引刷新失败",
                payload={"error": str(exc)},
            )
            logger.warning("auto knowledge index refresh failed video_id=%s error=%s", video_id, exc)

    def _run_mindmap_job(self, job: _MindmapJob) -> None:
        self._run_mindmap(job.task_id, job.force)

    def _run_mindmap(self, task_id: str, force: bool) -> None:
        record = self._repository.get_task(task_id)
        if record is None or record.result is None:
            logger.warning("skip missing task result for mindmap task_id=%s", task_id)
            return
        if record.status != TaskStatus.COMPLETED:
            logger.warning("skip non-completed task mindmap task_id=%s status=%s", task_id, record.status.value)
            return
        if not hasattr(self._pipeline_runner, "build_and_export_mindmap"):
            logger.warning("pipeline runner does not support mindmap generation task_id=%s", task_id)
            return

        current_result = record.result.model_copy(
            update={
                "mindmap_status": "generating",
                "mindmap_error_message": None,
            }
        )
        self._repository.save_result(task_id, current_result)
        self._repository.append_event(
            task_id=task_id,
            stage="mindmap_llm_request",
            progress=90,
            message="正在调用 LLM 生成思维导图",
            payload={"force": force},
        )

        try:
            mindmap, mindmap_path = self._pipeline_runner.build_and_export_mindmap(  # type: ignore[attr-defined]
                task_id=task_id,
                title=record.task_input.title or "思维导图",
                result=current_result,
            )
            self._repository.append_event(
                task_id=task_id,
                stage="mindmap_generating",
                progress=96,
                message="正在整理导图结构并写入结果",
            )
            refreshed = self._repository.get_task(task_id)
            if refreshed is None or refreshed.result is None:
                return
            final_result = refreshed.result.model_copy(
                update={
                    "artifacts": {**refreshed.result.artifacts, "mindmap_path": str(Path(mindmap_path))},
                    "mindmap_status": "ready",
                    "mindmap_error_message": None,
                    "mindmap_artifact_path": str(Path(mindmap_path)),
                    "mindmap_updated_at": datetime.now(timezone.utc),
                }
            )
            self._repository.save_result(task_id, final_result)
            self._repository.append_event(
                task_id=task_id,
                stage="mindmap_completed",
                progress=100,
                message="思维导图生成完成",
                payload={
                    "root": mindmap.root,
                    "top_level_count": len(mindmap.nodes[0].children) if mindmap.nodes else 0,
                },
            )
            logger.info(
                "mindmap generation completed task_id=%s root=%s top_level=%d",
                task_id,
                mindmap.root,
                len(mindmap.nodes[0].children) if mindmap.nodes else 0,
            )
        except Exception as exc:
            logger.exception("mindmap generation failed task_id=%s error=%s", task_id, exc)
            refreshed = self._repository.get_task(task_id)
            if refreshed is None or refreshed.result is None:
                return
            failed_result = refreshed.result.model_copy(
                update={
                    "mindmap_status": "failed",
                    "mindmap_error_message": str(exc),
                }
            )
            self._repository.save_result(task_id, failed_result)
            self._repository.append_event(
                task_id=task_id,
                stage="mindmap_failed",
                progress=100,
                message="思维导图生成失败",
                payload={"error": str(exc), "force": force},
            )
