from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx
from yt_dlp import YoutubeDL

from video_sum_core.errors import (
    LLMAuthenticationError,
    LLMConfigurationError,
    UnsupportedInputError,
    VideoSumError,
)
from video_sum_core.models.tasks import InputType, TaskResult
from video_sum_core.pipeline.base import PipelineContext, PipelineEvent, PipelineEventReporter, PipelineRunner
from video_sum_core.utils import ensure_directory, normalize_video_url, sanitize_filename
from video_sum_infra.runtime import (
    ffmpeg_location,
    runtime_library_dirs,
    runtime_python_executable,
    sanitized_subprocess_dll_search,
)

logger = logging.getLogger("video_sum_core.pipeline.real")


def _windows_hidden_subprocess_kwargs() -> dict[str, object]:
    if os.name != "nt":
        return {}

    kwargs: dict[str, object] = {}
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if creationflags:
        kwargs["creationflags"] = creationflags

    startupinfo_cls = getattr(subprocess, "STARTUPINFO", None)
    use_show_window = getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
    sw_hide = getattr(subprocess, "SW_HIDE", 0)
    if startupinfo_cls is not None:
        startupinfo = startupinfo_cls()
        startupinfo.dwFlags |= use_show_window
        startupinfo.wShowWindow = sw_hide
        kwargs["startupinfo"] = startupinfo

    return kwargs


def _safe_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _truncate_text(value: str, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit]


def _extract_response_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return _truncate_text(response.text.strip(), 400)

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            code = error.get("code")
            if message and code:
                return f"{code}: {message}"
            if message:
                return str(message)
        message = payload.get("message")
        if message:
            return str(message)
    return _truncate_text(json.dumps(payload, ensure_ascii=False), 400)


def _extract_json_object_text(value: str) -> str:
    text = str(value or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def _should_retry_llm_transport_error(error: Exception) -> bool:
    return isinstance(
        error,
        (
            httpx.ConnectError,
            httpx.ConnectTimeout,
            httpx.ReadTimeout,
            httpx.WriteTimeout,
            httpx.ReadError,
            httpx.WriteError,
            httpx.CloseError,
            httpx.ProxyError,
            httpx.RemoteProtocolError,
            httpx.NetworkError,
            httpx.ProtocolError,
            httpx.TransportError,
        ),
    )


@dataclass(slots=True)
class PipelineSettings:
    tasks_dir: Path
    runtime_channel: str = "base"
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    llm_enabled: bool = False
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""
    summary_system_prompt: str = ""
    summary_user_prompt_template: str = ""
    summary_chunk_target_chars: int = 2200
    summary_chunk_overlap_segments: int = 2
    summary_chunk_concurrency: int = 2
    summary_chunk_retry_count: int = 2


class RealPipelineRunner(PipelineRunner):
    def __init__(self, settings: PipelineSettings) -> None:
        self._settings = settings

    def run(
        self,
        context: PipelineContext,
        on_event: PipelineEventReporter | None = None,
    ) -> tuple[list[PipelineEvent], TaskResult]:
        task_input = context.task_input
        if task_input.input_type is not InputType.URL:
            raise UnsupportedInputError("Current runner only supports URL input.")

        events: list[PipelineEvent] = []

        def emit(stage: str, progress: int, message: str, payload: dict[str, object] | None = None) -> None:
            event = PipelineEvent(stage=stage, progress=progress, message=message, payload=payload or {})
            events.append(event)
            logger.info(
                "pipeline event task_id=%s stage=%s progress=%s message=%s payload=%s",
                context.task_id,
                stage,
                progress,
                message,
                event.payload,
            )
            if on_event is not None:
                on_event(event)

        logger.info("pipeline run start task_id=%s source=%s", context.task_id, task_input.source)
        emit("preparing", 8, "正在规范化视频链接")
        normalized_url, bvid = normalize_video_url(task_input.source)
        if "bilibili.com/video/" not in normalized_url:
            raise UnsupportedInputError("Current runner only supports Bilibili video URLs.")

        task_dir = ensure_directory(self._settings.tasks_dir / context.task_id)
        emit("probing", 12, "正在读取视频信息", {"url": normalized_url})
        metadata = self._probe_video(normalized_url)
        title = task_input.title or metadata.get("title") or bvid or "video"
        safe_title = sanitize_filename(title)
        emit(
            "probing",
            16,
            "视频信息读取完成",
            {"title": title, "duration": metadata.get("duration")},
        )
        audio_path = self._download_audio(normalized_url, task_dir, safe_title, emit)
        transcript, segments = self._transcribe(audio_path, metadata.get("duration"), emit)
        summary = self._summarize(transcript, segments, title, emit)
        emit("exporting", 97, "正在导出任务结果")
        result = self._export_result(task_dir, title, transcript, segments, summary)
        emit("exporting", 99, "结果文件已写入本地目录")
        logger.info(
            "pipeline run finish task_id=%s segments=%d transcript_chars=%d output_dir=%s",
            context.task_id,
            len(segments),
            len(transcript),
            task_dir,
        )
        return events, result

    def _probe_video(self, url: str) -> dict:
        with YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        if not isinstance(info, dict):
            raise VideoSumError("Failed to probe video metadata.")
        return info

    def _download_audio(
        self,
        url: str,
        task_dir: Path,
        safe_title: str,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> Path:
        emit("downloading", 20, "正在连接音频源")
        output_template = str(task_dir / f"{safe_title}.%(ext)s")
        download_progress = {
            "value": 20,
            "last_emit_time": 0.0,
            "last_downloaded_bytes": 0,
            "last_message": "",
        }

        def progress_hook(data: dict[str, object]) -> None:
            status = str(data.get("status") or "")
            if status == "downloading":
                now = time.monotonic()
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                downloaded = int(data.get("downloaded_bytes") or 0)
                speed = data.get("speed")
                eta = data.get("eta")
                fragment_index = data.get("fragment_index")
                fragment_count = data.get("fragment_count")

                if total and downloaded:
                    ratio = max(0.0, min(1.0, float(downloaded) / float(total)))
                    progress = min(42, 22 + int(ratio * 20))
                    message = self._build_download_message(
                        downloaded=downloaded,
                        total=int(total),
                        speed=speed,
                        eta=eta,
                        fragment_index=fragment_index,
                        fragment_count=fragment_count,
                    )
                    should_emit = (
                        progress > download_progress["value"]
                        or now - float(download_progress["last_emit_time"]) >= 0.8
                        or abs(downloaded - int(download_progress["last_downloaded_bytes"])) >= 2 * 1024 * 1024
                    )
                    if should_emit:
                        download_progress["value"] = progress
                        download_progress["last_emit_time"] = now
                        download_progress["last_downloaded_bytes"] = downloaded
                        download_progress["last_message"] = message
                        emit(
                            "downloading",
                            progress,
                            message,
                            {
                                "downloaded_bytes": downloaded,
                                "total_bytes": int(total),
                                "speed": int(speed) if speed else None,
                                "eta": eta,
                            },
                        )
                elif downloaded:
                    progress = min(38, 22 + min(14, int(math.log10(max(downloaded, 1))) * 2))
                    message = self._build_download_message(
                        downloaded=downloaded,
                        total=None,
                        speed=speed,
                        eta=eta,
                        fragment_index=fragment_index,
                        fragment_count=fragment_count,
                    )
                    should_emit = (
                        now - float(download_progress["last_emit_time"]) >= 0.8
                        or abs(downloaded - int(download_progress["last_downloaded_bytes"])) >= 2 * 1024 * 1024
                    )
                    if should_emit:
                        download_progress["value"] = max(int(download_progress["value"]), progress)
                        download_progress["last_emit_time"] = now
                        download_progress["last_downloaded_bytes"] = downloaded
                        download_progress["last_message"] = message
                        emit(
                            "downloading",
                            int(download_progress["value"]),
                            message,
                            {
                                "downloaded_bytes": downloaded,
                                "speed": int(speed) if speed else None,
                                "eta": eta,
                            },
                        )
            elif status == "finished":
                emit("downloading", 44, "音频下载完成，正在提取音轨")

        def postprocessor_hook(data: dict[str, object]) -> None:
            status = str(data.get("status") or "")
            postprocessor = str(data.get("postprocessor") or "")
            if status == "started":
                emit("downloading", 46, f"正在执行 {postprocessor or '后处理'}")
            elif status == "processing":
                emit("downloading", 47, f"正在提取 MP3 音频")
            elif status == "finished":
                emit("downloading", 48, "音频提取完成")

        options = {
            "format": "bestaudio/best",
            "outtmpl": output_template,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [postprocessor_hook],
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
        }
        ffmpeg_exe = ffmpeg_location()
        if ffmpeg_exe is not None:
            options["ffmpeg_location"] = str(ffmpeg_exe)
            logger.info("using ffmpeg location: %s", ffmpeg_exe)
        else:
            logger.warning("ffmpeg not found, yt_dlp will use system PATH")
        with YoutubeDL(options) as ydl:
            ydl.download([url])
        candidates = sorted(task_dir.glob(f"{safe_title}.*"))
        if not candidates:
            raise VideoSumError("Audio download failed.")
        emit("downloading", 48, "音频文件已就绪")
        return candidates[0]

    def _build_download_message(
        self,
        downloaded: int,
        total: int | None,
        speed: float | None,
        eta: int | None,
        fragment_index: object | None,
        fragment_count: object | None,
    ) -> str:
        parts = [f"已下载 {self._format_bytes(downloaded)}"]
        if total:
            parts.append(f"/ {self._format_bytes(total)}")
        if speed:
            parts.append(f"速度 {self._format_bytes(int(speed))}/s")
        if eta is not None:
            parts.append(f"剩余约 {int(eta)} 秒")
        if fragment_index and fragment_count:
            parts.append(f"分片 {fragment_index}/{fragment_count}")
        return " ".join(parts)

    def _format_bytes(self, value: int) -> str:
        units = ["B", "KB", "MB", "GB"]
        size = float(max(value, 0))
        unit_index = 0
        while size >= 1024 and unit_index < len(units) - 1:
            size /= 1024
            unit_index += 1
        if unit_index == 0:
            return f"{int(size)}{units[unit_index]}"
        return f"{size:.1f}{units[unit_index]}"

    def _transcribe(
        self,
        audio_path: Path,
        duration: float | None,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> tuple[str, list[dict[str, object]]]:
        attempts = [
            {
                "model": self._settings.whisper_model,
                "device": self._settings.whisper_device,
                "compute_type": self._settings.whisper_compute_type,
                "message": f"正在加载转写模型 {self._settings.whisper_model}",
            }
        ]
        if self._settings.whisper_device == "cpu" and self._settings.whisper_compute_type != "float32":
            attempts.append(
                {
                    "model": self._settings.whisper_model,
                    "device": "cpu",
                    "compute_type": "float32",
                    "message": f"兼容模式重试，正在加载转写模型 {self._settings.whisper_model}",
                }
            )

        last_error: VideoSumError | None = None
        for index, attempt in enumerate(attempts):
            emit(
                "transcribing",
                52,
                str(attempt["message"]),
                {
                    "model": attempt["model"],
                    "device": attempt["device"],
                    "compute_type": attempt["compute_type"],
                    "attempt": index + 1,
                },
            )
            logger.info(
                "launch transcription subprocess attempt=%s model=%s device=%s compute_type=%s audio=%s",
                index + 1,
                attempt["model"],
                attempt["device"],
                attempt["compute_type"],
                audio_path,
            )
            emit("transcribing", 58, "开始转写音频内容")
            try:
                transcript, segments = self._run_transcription_subprocess(
                    audio_path=audio_path,
                    duration=duration,
                    emit=emit,
                    model_name=str(attempt["model"]),
                    device=str(attempt["device"]),
                    compute_type=str(attempt["compute_type"]),
                )
                logger.info(
                    "transcription finished audio=%s segments=%d transcript_chars=%d attempt=%s",
                    audio_path,
                    len(segments),
                    len(transcript),
                    index + 1,
                )
                return transcript, segments
            except VideoSumError as exc:
                last_error = exc
                is_last_attempt = index == len(attempts) - 1
                if is_last_attempt or not self._should_retry_transcription(exc):
                    raise
                emit("transcribing", 56, "转写引擎异常，正在切换兼容模式重试")

        raise last_error or VideoSumError("Transcription failed.")

    def _run_transcription_subprocess(
        self,
        audio_path: Path,
        duration: float | None,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
        model_name: str,
        device: str,
        compute_type: str,
    ) -> tuple[str, list[dict[str, object]]]:
        progress_path = audio_path.with_name("transcription_worker_progress.jsonl")
        output_path = audio_path.with_name("transcription_worker_result.json")
        if progress_path.exists():
            progress_path.unlink()
        if output_path.exists():
            output_path.unlink()

        command = self._build_transcription_command(
            audio_path=audio_path,
            model_name=model_name,
            device=device,
            compute_type=compute_type,
            progress_path=progress_path,
            output_path=output_path,
        )
        if duration is not None:
            command.extend(["--duration", str(duration)])

        env = os.environ.copy()
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env.setdefault("PYTHONUTF8", "1")
        runtime_paths = [str(path) for path in runtime_library_dirs(self._settings.runtime_channel)]
        ffmpeg_dir = ffmpeg_location()
        if ffmpeg_dir is not None:
            runtime_paths.append(str(ffmpeg_dir))
        env["VIDEO_SUM_DLL_PATHS"] = os.pathsep.join(runtime_paths)
        merged_path: list[str] = []
        for entry in [*runtime_paths, *(env.get("PATH", "").split(os.pathsep))]:
            item = entry.strip()
            if item and item not in merged_path:
                merged_path.append(item)
        env["PATH"] = os.pathsep.join(merged_path)
        with sanitized_subprocess_dll_search():
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                cwd=str(audio_path.parent),
                **_windows_hidden_subprocess_kwargs(),
            )

        progress_offset = 0
        timeout_seconds = max(30 * 60, int((duration or 0) * 8) + 10 * 60)
        deadline = time.monotonic() + timeout_seconds
        while process.poll() is None:
            progress_offset = self._replay_transcription_progress(progress_path, progress_offset, emit)
            if time.monotonic() > deadline:
                process.kill()
                stdout, stderr = process.communicate()
                logger.error(
                    "transcription subprocess timeout audio=%s model=%s device=%s compute_type=%s stdout=%s stderr=%s",
                    audio_path,
                    model_name,
                    device,
                    compute_type,
                    stdout.strip(),
                    stderr.strip(),
                )
                raise VideoSumError("Transcription subprocess timed out.")
            time.sleep(0.2)

        progress_offset = self._replay_transcription_progress(progress_path, progress_offset, emit)
        stdout, stderr = process.communicate()
        if process.returncode != 0:
            # 检查是否是 CUDA 清理时的访问冲突，但输出文件已成功写入
            is_native_crash = self._is_native_crash_returncode(process.returncode)
            output_valid = output_path.exists()
            if output_valid:
                try:
                    payload = json.loads(output_path.read_text(encoding="utf-8"))
                    transcript = str(payload.get("transcript") or "")
                    segments = list(payload.get("segments") or [])
                    if transcript.strip() and segments:
                        # 输出有效，接受结果，记录警告但不抛出异常
                        logger.warning(
                            "transcription subprocess crashed during cleanup but output is valid "
                            "audio=%s model=%s device=%s compute_type=%s returncode=%s segments=%d transcript_chars=%d",
                            audio_path,
                            model_name,
                            device,
                            compute_type,
                            process.returncode,
                            len(segments),
                            len(transcript),
                        )
                        return transcript, segments
                except (json.JSONDecodeError, OSError):
                    pass  # 输出文件损坏，继续抛出异常

            logger.error(
                "transcription subprocess failed audio=%s model=%s device=%s compute_type=%s returncode=%s stdout=%s stderr=%s",
                audio_path,
                model_name,
                device,
                compute_type,
                process.returncode,
                stdout.strip(),
                stderr.strip(),
            )
            native_hint = ""
            if is_native_crash:
                native_hint = " The transcription runtime crashed at the native library level."
            raise VideoSumError(
                f"Transcription subprocess failed with exit code {process.returncode}."
                f"{native_hint} Runtime={device}/{compute_type} model={model_name}."
            )
        if stderr.strip():
            logger.info("transcription subprocess stderr audio=%s stderr=%s", audio_path, stderr.strip())
        if not output_path.exists():
            raise VideoSumError("Transcription subprocess completed without output.")

        payload = json.loads(output_path.read_text(encoding="utf-8"))
        transcript = str(payload.get("transcript") or "")
        segments = list(payload.get("segments") or [])
        if not transcript.strip():
            raise VideoSumError("Transcription produced empty output.")
        return transcript, segments

    def _build_transcription_command(
        self,
        audio_path: Path,
        model_name: str,
        device: str,
        compute_type: str,
        progress_path: Path,
        output_path: Path,
    ) -> list[str]:
        runtime_python = runtime_python_executable(self._settings.runtime_channel) or Path(sys.executable)
        command = [str(runtime_python), "-m", "video_sum_core.transcribe_subprocess"]

        command.extend(
            [
                "--audio-path",
                str(audio_path),
                "--model",
                model_name,
                "--device",
                device,
                "--compute-type",
                compute_type,
                "--progress-path",
                str(progress_path),
                "--output-path",
                str(output_path),
            ]
        )
        return command

    def _should_retry_transcription(self, error: VideoSumError) -> bool:
        message = str(error)
        return "native library level" in message or "exit code 3221226505" in message

    def _is_native_crash_returncode(self, returncode: int) -> bool:
        return returncode in {3221226505, -1073740791}

    def _replay_transcription_progress(
        self,
        progress_path: Path,
        offset: int,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> int:
        if not progress_path.exists():
            return offset
        with progress_path.open("r", encoding="utf-8") as handle:
            handle.seek(offset)
            for line in handle:
                raw = line.strip()
                if not raw:
                    continue
                event = json.loads(raw)
                emit(
                    str(event.get("stage") or "transcribing"),
                    int(event.get("progress") or 0),
                    str(event.get("message") or ""),
                    event.get("payload") or {},
                )
            return handle.tell()

    def _summarize(
        self,
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> dict[str, object]:
        emit(
            "summarizing",
            88,
            self._build_summary_start_message(),
            {"llm_enabled": self._settings.llm_enabled and bool(self._settings.llm_api_key)},
        )
        if self._settings.llm_enabled and self._settings.llm_api_key:
            emit("summarizing", 91, f"正在请求 LLM：{self._settings.llm_model or '未命名模型'}")
            logger.info(
                "llm summary request model=%s base_url=%s transcript_chars=%d segments=%d",
                self._settings.llm_model,
                self._settings.llm_base_url,
                len(transcript),
                len(segments),
            )
            try:
                summary = self._summarize_with_llm(transcript, segments, title, emit)
            except (LLMAuthenticationError, LLMConfigurationError) as exc:
                logger.warning("llm unavailable, fallback to rule summary reason=%s", exc)
                emit(
                    "summarizing",
                    91,
                    f"LLM 不可用，已切换为本地规则摘要：{exc}",
                    {"fallback": "rules", "reason": str(exc)},
                )
                summary = self._summarize_with_rules(transcript, segments, title)
        else:
            emit("summarizing", 91, "未启用 LLM，使用本地规则摘要")
            logger.info("rule summary start transcript_chars=%d segments=%d", len(transcript), len(segments))
            summary = self._summarize_with_rules(transcript, segments, title)
        summary = self._normalize_summary(summary, transcript, segments, title)
        emit("summarizing", 95, "摘要生成完成")
        logger.info(
            "summary finished title=%s bullet_points=%d chapters=%d overview_chars=%d",
            title,
            len(summary.get("bulletPoints", [])),
            len(summary.get("chapters", [])),
            len(str(summary.get("overview") or "")),
        )
        return summary

    def _build_summary_start_message(self) -> str:
        if self._settings.llm_enabled and self._settings.llm_api_key:
            return "开始生成 LLM 摘要"
        return "开始生成本地规则摘要"

    def _summarize_with_llm(
        self,
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> dict[str, object]:
        base_url = (self._settings.llm_base_url or "").rstrip("/")
        if not base_url or not self._settings.llm_model:
            raise LLMConfigurationError("LLM 配置不完整，请检查 Base URL 和模型名。")
        chunks = self._build_summary_chunks(segments)
        if not chunks:
            chunks = [
                {
                    "index": 1,
                    "transcript": transcript,
                    "segments_json": json.dumps(segments, ensure_ascii=False),
                }
            ]
        logger.info(
            "llm summary chunk plan model=%s chunks=%d target_chars=%d overlap_segments=%d",
            self._settings.llm_model,
            len(chunks),
            self._settings.summary_chunk_target_chars,
            self._settings.summary_chunk_overlap_segments,
        )

        partial_summaries: list[dict[str, object]] = []
        chunk_count = len(chunks)
        concurrency = max(1, int(self._settings.summary_chunk_concurrency))
        retry_count = max(0, int(self._settings.summary_chunk_retry_count))
        emit(
            "summarizing",
            91,
            f"正在并发汇总 {chunk_count} 个内容块",
            {"chunk_count": chunk_count, "concurrency": concurrency},
        )
        completed = 0
        failures: list[str] = []
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            future_map = {
                executor.submit(self._request_llm_summary_chunk, base_url, title, chunk, chunk_count, retry_count): chunk
                for chunk in chunks
            }
            for future in as_completed(future_map):
                chunk = future_map[future]
                chunk_index = int(chunk["index"])
                try:
                    partial = future.result()
                    partial_summaries.append(partial)
                    completed += 1
                    progress = min(94, 91 + max(0, math.floor(completed * 3 / max(1, chunk_count))))
                    emit(
                        "summarizing",
                        progress,
                        f"已完成第 {chunk_index}/{chunk_count} 个内容块",
                        {"chunk_index": chunk_index, "chunk_count": chunk_count, "completed_chunks": completed},
                    )
                except VideoSumError as exc:
                    failures.append(f"chunk={chunk_index}: {exc}")
                    completed += 1
                    logger.warning(
                        "llm summary chunk skipped after retries model=%s chunk=%d/%d error=%s",
                        self._settings.llm_model,
                        chunk_index,
                        chunk_count,
                        exc,
                    )
                    emit(
                        "summarizing",
                        min(94, 91 + max(0, math.floor(completed * 3 / max(1, chunk_count)))),
                        f"第 {chunk_index}/{chunk_count} 个内容块失败，已跳过继续",
                        {"chunk_index": chunk_index, "chunk_count": chunk_count, "error": str(exc)},
                    )

        partial_summaries.sort(key=lambda item: int(item.get("chunk_index") or 0))
        if not partial_summaries:
            raise VideoSumError("All LLM summary chunks failed.")

        total_prompt_tokens = sum((_safe_int(item.get("llm_prompt_tokens")) or 0) for item in partial_summaries)
        total_completion_tokens = sum((_safe_int(item.get("llm_completion_tokens")) or 0) for item in partial_summaries)
        total_tokens = sum((_safe_int(item.get("llm_total_tokens")) or 0) for item in partial_summaries)

        emit(
            "summarizing",
            94,
            "正在合并分块摘要",
            {"chunk_count": chunk_count},
        )
        aggregate_transcript, aggregate_segments = self._build_aggregate_summary_inputs(partial_summaries)
        logger.info(
            "llm summary aggregate request model=%s chunk_count=%d aggregate_transcript_chars=%d aggregate_segments_chars=%d",
            self._settings.llm_model,
            chunk_count,
            len(aggregate_transcript),
            len(aggregate_segments),
        )
        merged = self._request_llm_summary(
            base_url=base_url,
            payload=self._build_llm_summary_payload(
                title=title,
                transcript_excerpt=aggregate_transcript,
                segments_excerpt=aggregate_segments,
            ),
        )
        if failures:
            merged.setdefault("overview", "")
            merged["overview"] = f"{merged['overview']}\n\n注意：有 {len(failures)} 个分块摘要失败，最终结果基于成功分块汇总。".strip()
        merged["llm_prompt_tokens"] = total_prompt_tokens + (_safe_int(merged.get("llm_prompt_tokens")) or 0)
        merged["llm_completion_tokens"] = total_completion_tokens + (_safe_int(merged.get("llm_completion_tokens")) or 0)
        merged["llm_total_tokens"] = total_tokens + (_safe_int(merged.get("llm_total_tokens")) or 0)
        return merged

    def _request_llm_summary_chunk(
        self,
        base_url: str,
        title: str,
        chunk: dict[str, object],
        chunk_count: int,
        retry_count: int,
    ) -> dict[str, object]:
        chunk_index = int(chunk["index"])
        last_error: Exception | None = None
        for attempt in range(retry_count + 1):
            logger.info(
                "llm summary chunk request model=%s chunk=%d/%d attempt=%d transcript_chars=%d segments_json_chars=%d",
                self._settings.llm_model,
                chunk_index,
                chunk_count,
                attempt + 1,
                len(str(chunk["transcript"])),
                len(str(chunk["segments_json"])),
            )
            try:
                partial = self._request_llm_summary(
                    base_url=base_url,
                    payload=self._build_llm_summary_payload(
                        title=f"{title} - 分块 {chunk_index}",
                        transcript_excerpt=str(chunk["transcript"]),
                        segments_excerpt=str(chunk["segments_json"]),
                    ),
                )
                partial["chunk_index"] = chunk_index
                return partial
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "llm summary chunk request failed model=%s chunk=%d/%d attempt=%d error=%s",
                    self._settings.llm_model,
                    chunk_index,
                    chunk_count,
                    attempt + 1,
                    exc,
                )
        raise VideoSumError(str(last_error) if last_error else f"Chunk {chunk_index} failed.")

    def _request_llm_summary(
        self,
        base_url: str,
        payload: dict[str, object],
    ) -> dict[str, object]:
        headers = {
            "Authorization": f"Bearer {self._settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        transport_retry_count = max(0, int(self._settings.summary_chunk_retry_count))
        last_error: Exception | None = None
        response: httpx.Response | None = None
        for attempt in range(transport_retry_count + 1):
            try:
                with httpx.Client(timeout=180, follow_redirects=True) as client:
                    response = client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
                break
            except Exception as exc:
                last_error = exc
                if attempt >= transport_retry_count or not _should_retry_llm_transport_error(exc):
                    raise
                backoff_seconds = min(6.0, 1.5 * (attempt + 1))
                logger.warning(
                    "llm summary transport retry model=%s attempt=%d/%d error=%s backoff=%.1fs",
                    self._settings.llm_model,
                    attempt + 1,
                    transport_retry_count + 1,
                    exc,
                    backoff_seconds,
                )
                time.sleep(backoff_seconds)
        if response is None:
            raise VideoSumError(str(last_error) if last_error else "LLM request failed before receiving response.")
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = _extract_response_error_detail(exc.response)
            logger.error(
                "llm summary request failed status=%s model=%s detail=%s",
                exc.response.status_code,
                self._settings.llm_model,
                detail,
            )
            status_code = exc.response.status_code
            if status_code in (401, 403):
                raise LLMAuthenticationError(
                    f"LLM API Key 无效、已过期，或当前模型/接口无权限访问（HTTP {status_code}: {detail}）。"
                ) from exc
            raise VideoSumError(f"LLM request failed with status {status_code}: {detail}") from exc
        logger.info("llm summary response status=%s model=%s", response.status_code, self._settings.llm_model)
        response_json = response.json()
        content = response_json["choices"][0]["message"]["content"]
        parsed = self._parse_llm_json_content(content)
        usage = response_json.get("usage") or {}
        parsed.setdefault("title", "")
        parsed.setdefault("overview", "")
        parsed.setdefault("bulletPoints", [])
        parsed.setdefault("chapters", [])
        parsed["llm_prompt_tokens"] = _safe_int(usage.get("prompt_tokens"))
        parsed["llm_completion_tokens"] = _safe_int(usage.get("completion_tokens"))
        parsed["llm_total_tokens"] = _safe_int(usage.get("total_tokens"))
        return parsed

    def _parse_llm_json_content(self, content: str) -> dict[str, object]:
        candidates = [str(content or "").strip()]
        extracted = _extract_json_object_text(content)
        if extracted not in candidates:
            candidates.append(extracted)

        for candidate in candidates:
            if not candidate:
                continue
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                try:
                    return json.loads(candidate, strict=False)
                except json.JSONDecodeError:
                    continue

        preview = _truncate_text(str(content or "").replace("\r", "\\r").replace("\n", "\\n"), 600)
        logger.error("llm summary returned invalid json content preview=%s", preview)
        raise VideoSumError("LLM returned invalid JSON content.")

    def _build_llm_summary_payload(
        self,
        title: str,
        transcript_excerpt: str,
        segments_excerpt: str,
    ) -> dict[str, object]:
        messages = self._build_summary_messages(title, transcript_excerpt, segments_excerpt)
        messages = self._ensure_json_keyword_in_messages(messages)
        # Qwen mixed-thinking models may reject json_object mode when thinking is enabled.
        return {
            "model": self._settings.llm_model,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "enable_thinking": False,
        }

    def _build_summary_messages(
        self,
        title: str,
        transcript_excerpt: str,
        segments_excerpt: str,
    ) -> list[dict[str, str]]:
        system_prompt = (
            self._settings.summary_system_prompt.strip()
            if self._settings.summary_system_prompt.strip()
            else (
                "你是一名严谨的中文视频摘要助手。"
                "你的唯一任务是基于用户提供的转写和分段信息，生成可直接展示给前端页面的结构化摘要。"
                "不得编造视频中没有出现的信息，不得输出 JSON 以外的任何文字。"
                "You must return valid json only."
            )
        )
        user_template = (
            self._settings.summary_user_prompt_template.strip()
            if self._settings.summary_user_prompt_template.strip()
            else """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：生成一个可读性强、信息密度高、适合中文用户阅读的视频摘要。

强约束：
1. 必须输出合法 JSON，对象顶层只允许包含 title、overview、bulletPoints、chapters 四个字段。
2. overview 必须是 2 到 4 句中文，概括视频核心观点、讨论主题和最终结论。
3. bulletPoints 必须是 4 到 6 条中文要点，每条 18 到 60 个字，禁止空字符串，禁止重复改写同一条意思。
4. chapters 必须是 3 到 6 个章节，每个章节必须包含 title、start、summary。
5. chapter.title 要短，像小标题；chapter.summary 要概括该时间段内容，20 到 80 个字。
6. start 必须使用视频里真实出现的时间点，单位为秒，按升序排列。
7. 如果原文信息有限，也必须尽量提炼出非空 bulletPoints 和 chapters，不能返回空数组。
8. 不要写“视频主要讲了”“本视频介绍了”这种空话，直接写内容。
9. 不要引用不存在的数据，不要补充外部背景，不要分析说话者身份之外的隐含动机。

写作要求：
- 保持中文自然、紧凑、具体。
- 优先提炼观点、结论、争议点、使用体验、推荐条件。
- chapters 应体现内容推进，而不是机械平均切分。

输出格式示例：
{{"title":"","overview":"","bulletPoints":["", "", "", ""],"chapters":[{{"title":"","start":0,"summary":""}}]}}

视频标题：{title}

转写节选：
{transcript}

分段数据节选：
{segments_json}"""
        )
        return [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": self._render_user_prompt_template(
                    user_template,
                    title=title,
                    transcript_excerpt=transcript_excerpt,
                    segments_excerpt=segments_excerpt,
                ),
            },
        ]

    def _ensure_json_keyword_in_messages(self, messages: list[dict[str, str]]) -> list[dict[str, str]]:
        if any("json" in str(message.get("content") or "").lower() for message in messages):
            return messages

        patched = [dict(message) for message in messages]
        if patched:
            patched[0]["content"] = f"{patched[0].get('content', '').rstrip()}\nReturn valid json only."
        else:
            patched = [{"role": "system", "content": "Return valid json only."}]
        return patched

    def _render_user_prompt_template(
        self,
        template: str,
        title: str,
        transcript_excerpt: str,
        segments_excerpt: str,
    ) -> str:
        return template.format(
            title=title,
            transcript=transcript_excerpt,
            transcript_excerpt=transcript_excerpt,
            segments_json=segments_excerpt,
            segments_excerpt=segments_excerpt,
        )

    def _build_summary_chunks(self, segments: list[dict[str, object]]) -> list[dict[str, object]]:
        if not segments:
            return []

        chunks: list[dict[str, object]] = []
        target_chars = max(800, int(self._settings.summary_chunk_target_chars))
        overlap = max(0, int(self._settings.summary_chunk_overlap_segments))
        start = 0
        index = 1
        total = len(segments)

        while start < total:
            current: list[dict[str, object]] = []
            current_chars = 0
            cursor = start
            while cursor < total:
                segment = segments[cursor]
                text = str(segment.get("text") or "").strip()
                estimated = len(text) + 24
                if current and current_chars + estimated > target_chars:
                    break
                current.append(segment)
                current_chars += estimated
                cursor += 1

            if not current:
                current = [segments[start]]
                cursor = start + 1

            chunk_lines = [
                f"[{self._format_seconds(float(item.get('start') or 0))}] {str(item.get('text') or '').strip()}"
                for item in current
                if str(item.get("text") or "").strip()
            ]
            compact_segments = [
                {
                    "start": float(item.get("start") or 0),
                    "text": _truncate_text(str(item.get("text") or "").strip(), 120),
                }
                for item in current
                if str(item.get("text") or "").strip()
            ]
            chunks.append(
                {
                    "index": index,
                    "transcript": _truncate_text("\n".join(chunk_lines), target_chars + 400),
                    "segments_json": _truncate_text(json.dumps(compact_segments, ensure_ascii=False), target_chars + 400),
                }
            )
            index += 1
            if cursor >= total:
                break
            start = max(cursor - overlap, start + 1)
        return chunks

    def _build_aggregate_summary_inputs(
        self,
        partial_summaries: list[dict[str, object]],
    ) -> tuple[str, str]:
        lines: list[str] = []
        segments: list[dict[str, object]] = []
        for item in partial_summaries:
            chunk_index = int(item.get("chunk_index") or 0)
            title = str(item.get("title") or f"分块 {chunk_index}")
            overview = str(item.get("overview") or "").strip()
            bullet_points = [str(point).strip() for point in item.get("bulletPoints") or [] if str(point).strip()]
            chapters = [chapter for chapter in item.get("chapters") or [] if isinstance(chapter, dict)]

            lines.append(f"### 分块 {chunk_index}: {title}")
            if overview:
                lines.append(f"概览：{overview}")
            for point in bullet_points[:6]:
                lines.append(f"- {point}")
            for chapter in chapters[:6]:
                start = float(chapter.get("start") or 0)
                summary = str(chapter.get("summary") or "").strip()
                chapter_title = str(chapter.get("title") or f"章节 {chunk_index}")
                if summary:
                    lines.append(f"[{self._format_seconds(start)}] {chapter_title}：{summary}")
                    segments.append(
                        {
                            "start": start,
                            "text": _truncate_text(f"{chapter_title}：{summary}", 140),
                        }
                    )
            lines.append("")
        return _truncate_text("\n".join(lines).strip(), 5200), _truncate_text(json.dumps(segments, ensure_ascii=False), 2600)

    def _format_seconds(self, value: float) -> str:
        total = max(0, int(value))
        minutes = total // 60
        seconds = total % 60
        return f"{minutes:02d}:{seconds:02d}"

    def _build_transcript_excerpt(self, transcript: str) -> str:
        lines = [line.strip() for line in transcript.splitlines() if line.strip()]
        if len(lines) <= 120:
            return _truncate_text("\n".join(lines), 3600)
        head = lines[:70]
        tail = lines[-35:]
        return _truncate_text("\n".join(head + ["[...中间转写已省略...]"] + tail), 3600)

    def _build_segments_excerpt(self, segments: list[dict[str, object]]) -> str:
        if len(segments) <= 32:
            selected = segments
        else:
            head = segments[:12]
            middle_start = max(12, len(segments) // 2 - 4)
            middle = segments[middle_start : middle_start + 8]
            tail = segments[-12:]
            selected = [*head, {"start": "...", "text": "中间分段已省略"}, *middle, *tail]

        compact_segments: list[dict[str, object]] = []
        for item in selected:
            compact_segments.append(
                {
                    "start": item.get("start"),
                    "text": _truncate_text(str(item.get("text") or ""), 72),
                }
            )
        return _truncate_text(json.dumps(compact_segments, ensure_ascii=False), 1800)

    def _summarize_with_rules(
        self,
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
    ) -> dict[str, object]:
        lines = [line.strip() for line in transcript.splitlines() if line.strip()]
        overview = "\n".join(lines[:3])[:400]
        bullet_points = [line.split("] ", 1)[-1][:80] for line in lines[:5]]
        chapters = []
        if segments:
            step = max(1, len(segments) // 4)
            for index in range(0, len(segments), step):
                group = segments[index : index + step]
                chapters.append(
                    {
                        "title": f"章节 {len(chapters) + 1}",
                        "start": group[0]["start"],
                        "summary": " ".join(str(item["text"]) for item in group)[:120],
                    }
                )
                if len(chapters) >= 4:
                    break
        return {
            "title": title or "视频摘要",
            "overview": overview,
            "bulletPoints": bullet_points,
            "chapters": chapters,
        }

    def _normalize_summary(
        self,
        summary: dict[str, object],
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
    ) -> dict[str, object]:
        normalized = dict(summary)
        normalized["title"] = str(normalized.get("title") or title or "视频摘要")

        overview = str(normalized.get("overview") or "").strip()
        if not overview:
            overview = self._build_overview_fallback(transcript)
        normalized["overview"] = overview

        bullet_points = self._coerce_bullet_points(normalized.get("bulletPoints"))
        if not bullet_points:
            bullet_points = self._build_bullet_points_fallback(overview, transcript, segments)
        normalized["bulletPoints"] = bullet_points

        chapters = self._coerce_chapters(normalized.get("chapters"))
        if not chapters:
            chapters = self._build_chapters_fallback(segments)
        normalized["chapters"] = chapters
        return normalized

    def _build_overview_fallback(self, transcript: str) -> str:
        lines = [line.strip() for line in transcript.splitlines() if line.strip()]
        return "\n".join(lines[:3])[:400]

    def _coerce_bullet_points(self, value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        items = [str(item).strip() for item in value if str(item).strip()]
        return items[:6]

    def _build_bullet_points_fallback(
        self,
        overview: str,
        transcript: str,
        segments: list[dict[str, object]],
    ) -> list[str]:
        points: list[str] = []
        if overview:
            chunks = [part.strip(" \n\r\t-•") for part in overview.replace("。", "。\n").splitlines()]
            for chunk in chunks:
                if chunk:
                    points.append(chunk[:80])
                if len(points) >= 4:
                    break

        if len(points) < 3:
            transcript_lines = [line.strip() for line in transcript.splitlines() if line.strip()]
            for line in transcript_lines:
                text = line.split("] ", 1)[-1].strip()
                if text and text not in points:
                    points.append(text[:80])
                if len(points) >= 5:
                    break

        if len(points) < 3 and segments:
            step = max(1, len(segments) // 5)
            for index in range(0, len(segments), step):
                text = str(segments[index].get("text") or "").strip()
                if text and text not in points:
                    points.append(text[:80])
                if len(points) >= 5:
                    break
        return points[:5]

    def _coerce_chapters(self, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list):
            return []
        chapters: list[dict[str, object]] = []
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            summary = str(item.get("summary") or "").strip()
            if not summary:
                continue
            chapters.append(
                {
                    "title": str(item.get("title") or f"章节 {index + 1}"),
                    "start": float(item.get("start") or 0),
                    "summary": summary[:160],
                }
            )
        return chapters[:6]

    def _build_chapters_fallback(self, segments: list[dict[str, object]]) -> list[dict[str, object]]:
        if not segments:
            return []
        chapters: list[dict[str, object]] = []
        step = max(1, len(segments) // 4)
        for index in range(0, len(segments), step):
            group = segments[index : index + step]
            if not group:
                continue
            summary = " ".join(str(item.get("text") or "").strip() for item in group if str(item.get("text") or "").strip())
            if not summary:
                continue
            chapters.append(
                {
                    "title": f"章节 {len(chapters) + 1}",
                    "start": float(group[0].get("start") or 0),
                    "summary": summary[:160],
                }
            )
            if len(chapters) >= 4:
                break
        return chapters

    def _export_result(
        self,
        task_dir: Path,
        title: str,
        transcript: str,
        segments: list[dict[str, object]],
        summary: dict[str, object],
    ) -> TaskResult:
        transcript_path = task_dir / "transcript.txt"
        summary_path = task_dir / "summary.json"
        transcript_path.write_text(transcript, encoding="utf-8")
        summary_path.write_text(
            json.dumps({"title": title, "summary": summary, "segments": segments}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info(
            "result exported transcript_path=%s summary_path=%s",
            transcript_path,
            summary_path,
        )
        return TaskResult(
            overview=str(summary.get("overview") or ""),
            transcript_text=transcript,
            segment_summaries=[str(item["summary"]) for item in summary.get("chapters", [])],
            key_points=[str(item) for item in summary.get("bulletPoints", [])],
            timeline=[
                {
                    "title": str(item["title"]),
                    "start": item["start"],
                    "summary": str(item["summary"]),
                }
                for item in summary.get("chapters", [])
            ],
            artifacts={
                "transcript_path": str(transcript_path),
                "summary_path": str(summary_path),
            },
            llm_prompt_tokens=_safe_int(summary.get("llm_prompt_tokens")),
            llm_completion_tokens=_safe_int(summary.get("llm_completion_tokens")),
            llm_total_tokens=_safe_int(summary.get("llm_total_tokens")),
        )
