import logging
from datetime import datetime, timezone
from pathlib import Path
from threading import Thread

from video_sum_core.models.tasks import TaskResult, TaskStatus
from video_sum_core.pipeline.base import PipelineContext, PipelineRunner
from video_sum_service.repository import SqliteTaskRepository
from video_sum_service.schemas import TaskRecord

logger = logging.getLogger("video_sum_service.worker")


class TaskWorker:
    """Very small background worker used to execute placeholder tasks."""

    def __init__(
        self,
        repository: SqliteTaskRepository,
        pipeline_runner: PipelineRunner,
        *,
        auto_generate_mindmap: bool = False,
    ) -> None:
        self._repository = repository
        self._pipeline_runner = pipeline_runner
        self._auto_generate_mindmap = auto_generate_mindmap

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

    def submit_mindmap(self, task_id: str, *, force: bool = False) -> None:
        logger.info("queue task mindmap generation task_id=%s force=%s", task_id, force)
        thread = Thread(target=self._run_mindmap, args=(task_id, force), daemon=True)
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

            events, result = self._pipeline_runner.run(
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
                self._repository.append_event(
                    task_id=task_id,
                    stage="mindmap_queued",
                    progress=100,
                    message="已按设置自动发起思维导图生成",
                    payload={"automatic": True},
                )
                self.submit_mindmap(task_id)
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
