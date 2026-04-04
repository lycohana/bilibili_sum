import logging
from datetime import datetime, timezone
from threading import Thread

from video_sum_core.models.tasks import TaskResult, TaskStatus
from video_sum_core.pipeline.base import PipelineContext, PipelineRunner
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import TaskRecord

logger = logging.getLogger("video_sum_service.worker")


class TaskWorker:
    """Very small background worker used to execute placeholder tasks."""

    def __init__(self, repository: SqliteTaskRepository, pipeline_runner: PipelineRunner) -> None:
        self._repository = repository
        self._pipeline_runner = pipeline_runner

    def submit(self, task: TaskRecord) -> None:
        logger.info(
            "queue task task_id=%s video_id=%s input_type=%s source=%s",
            task.task_id,
            task.video_id,
            task.task_input.input_type.value,
            task.task_input.source,
        )
        thread = Thread(target=self._run_task, args=(task.task_id,), daemon=True)
        thread.start()

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

        self._repository.append_event(
            task_id=task_id,
            stage="queued",
            progress=0,
            message="任务已进入后台队列",
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
            events, result = self._pipeline_runner.run(
                context,
                on_event=lambda event: self._repository.append_event(
                    task_id=task_id,
                    stage=event.stage,
                    progress=event.progress,
                    message=event.message,
                    payload=event.payload,
                ),
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
