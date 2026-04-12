from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
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
from video_sum_core.models.tasks import InputType, MindMapNode, TaskMindMap, TaskResult
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
    mindmap_system_prompt: str = ""
    mindmap_user_prompt_template: str = ""
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

        logger.info(
            "pipeline run start task_id=%s input_type=%s source=%s",
            context.task_id,
            task_input.input_type.value,
            task_input.source,
        )

        if task_input.input_type is InputType.URL:
            result = self._run_from_url(context, emit)
        elif task_input.input_type is InputType.TRANSCRIPT_TEXT:
            result = self._run_from_transcript_text(context, emit)
        else:
            raise UnsupportedInputError(
                f"Current runner does not support input type '{task_input.input_type.value}'."
            )
        return events, result

    def _run_from_url(
        self,
        context: PipelineContext,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> TaskResult:
        task_input = context.task_input
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
            "pipeline url run finish task_id=%s segments=%d transcript_chars=%d output_dir=%s",
            context.task_id,
            len(segments),
            len(transcript),
            task_dir,
        )
        return result

    def _run_from_transcript_text(
        self,
        context: PipelineContext,
        emit: Callable[[str, int, str, dict[str, object] | None], None],
    ) -> TaskResult:
        task_dir = ensure_directory(self._settings.tasks_dir / context.task_id)
        title, transcript, segments = self._parse_transcript_payload(context.task_input.source, context.task_input.title)
        emit("preparing", 12, "正在复用已有转写内容", {"segment_count": len(segments)})
        emit(
            "transcribing",
            32,
            "已跳过重新转写，直接复用当前版本文本",
            {"transcript_chars": len(transcript), "segment_count": len(segments)},
        )
        summary = self._summarize(transcript, segments, title, emit)
        emit("exporting", 97, "正在导出新的摘要结果")
        result = self._export_result(task_dir, title, transcript, segments, summary)
        emit("exporting", 99, "新的摘要结果已写入本地目录")
        logger.info(
            "pipeline transcript rerun finish task_id=%s segments=%d transcript_chars=%d output_dir=%s",
            context.task_id,
            len(segments),
            len(transcript),
            task_dir,
        )
        return result

    def _parse_transcript_payload(
        self,
        source: str,
        title_hint: str | None,
    ) -> tuple[str, str, list[dict[str, object]]]:
        try:
            payload = json.loads(source)
        except json.JSONDecodeError as exc:
            raise VideoSumError("Transcript task payload is invalid JSON.") from exc

        if not isinstance(payload, dict):
            raise VideoSumError("Transcript task payload must be an object.")

        transcript = str(payload.get("transcript") or "").strip()
        if not transcript:
            raise VideoSumError("Transcript task payload is missing transcript content.")

        raw_segments = payload.get("segments") or []
        segments = self._coerce_transcript_segments(raw_segments)
        if not segments:
            raise VideoSumError("Transcript task payload is missing valid segments.")

        title = str(payload.get("title") or title_hint or "视频摘要").strip() or "视频摘要"
        return title, transcript, segments

    def _coerce_transcript_segments(self, value: object) -> list[dict[str, object]]:
        if not isinstance(value, list):
            return []
        segments: list[dict[str, object]] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            start = item.get("start")
            end = item.get("end")
            try:
                start_value = float(start) if start is not None else 0.0
            except (TypeError, ValueError):
                start_value = 0.0
            try:
                end_value = float(end) if end is not None else start_value
            except (TypeError, ValueError):
                end_value = start_value
            segments.append({"start": start_value, "end": end_value, "text": text})
        return segments

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
        runtime_python = runtime_python_executable(self._settings.runtime_channel)
        if runtime_python is None:
            raise VideoSumError(
                f"Managed runtime python is unavailable for channel '{self._settings.runtime_channel}'."
            )
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
        used_llm_summary = False
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
                used_llm_summary = True
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
        emit(
            "summarizing",
            95,
            "知识卡片摘要生成完成",
            {
                "result": self._build_task_result(transcript, summary).model_dump(mode="json"),
                "result_scope": "knowledge_cards",
            },
        )
        if used_llm_summary:
            emit("summarizing", 96, "正在生成知识笔记")
            try:
                note_payload = self._generate_knowledge_note_with_llm(
                    transcript=transcript,
                    segments=segments,
                    title=title,
                    summary=summary,
                )
                knowledge_note_markdown = str(note_payload.get("knowledgeNoteMarkdown") or "").strip()
                if knowledge_note_markdown:
                    summary["knowledgeNoteMarkdown"] = knowledge_note_markdown
                summary["llm_prompt_tokens"] = (_safe_int(summary.get("llm_prompt_tokens")) or 0) + (
                    _safe_int(note_payload.get("llm_prompt_tokens")) or 0
                )
                summary["llm_completion_tokens"] = (_safe_int(summary.get("llm_completion_tokens")) or 0) + (
                    _safe_int(note_payload.get("llm_completion_tokens")) or 0
                )
                summary["llm_total_tokens"] = (_safe_int(summary.get("llm_total_tokens")) or 0) + (
                    _safe_int(note_payload.get("llm_total_tokens")) or 0
                )
            except VideoSumError as exc:
                logger.warning("knowledge note llm generation failed, fallback to local note builder error=%s", exc)
                emit(
                    "summarizing",
                    97,
                    f"知识笔记生成失败，已回退为本地笔记：{exc}",
                    {"fallback": "knowledge_note_rules", "reason": str(exc)},
                )
            else:
                emit(
                    "summarizing",
                    98,
                    "知识笔记生成完成",
                    {
                        "result": self._build_task_result(transcript, summary).model_dump(mode="json"),
                        "result_scope": "knowledge_note",
                    },
                )
        emit("summarizing", 99, "结果整理完成")
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
        merged_chapters = self._merge_partial_chapters(partial_summaries, segments)
        aggregate_transcript, aggregate_segments = self._build_aggregate_summary_inputs(partial_summaries, merged_chapters)
        logger.info(
            "llm summary aggregate request model=%s chunk_count=%d aggregate_transcript_chars=%d aggregate_segments_chars=%d merged_chapters=%d",
            self._settings.llm_model,
            chunk_count,
            len(aggregate_transcript),
            len(aggregate_segments),
            len(merged_chapters),
        )
        merged = self._request_llm_json(
            base_url=base_url,
            payload=self._build_llm_summary_payload(
                title=title,
                transcript_excerpt=aggregate_transcript,
                segments_excerpt=aggregate_segments,
            ),
        )
        merged = self._merge_structured_summary(
            merged=merged,
            partial_summaries=partial_summaries,
            merged_chapters=merged_chapters,
            transcript=transcript,
            segments=segments,
            title=title,
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
                partial = self._request_llm_json(
                    base_url=base_url,
                    payload=self._build_llm_summary_payload(
                        title=f"{title} - 分块 {chunk_index}",
                        transcript_excerpt=str(chunk["transcript"]),
                        segments_excerpt=str(chunk["segments_json"]),
                    ),
                )
                partial["chunk_index"] = chunk_index
                partial["chunk_start"] = float(chunk.get("chunk_start") or 0)
                partial["chunk_end"] = float(chunk.get("chunk_end") or partial["chunk_start"])
                partial["source_segment_count"] = int(chunk.get("source_segment_count") or 0)
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

    def _request_llm_json(
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
                    "llm json transport retry model=%s attempt=%d/%d error=%s backoff=%.1fs",
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
                "llm json request failed status=%s model=%s detail=%s",
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
        logger.info("llm json response status=%s model=%s", response.status_code, self._settings.llm_model)
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
        logger.error("llm json returned invalid content preview=%s", preview)
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
                "你是一名严谨、克制、信息密度优先的中文视频内容编辑。"
                "你的任务不是泛泛总结，而是基于转写和分段信息，产出可以直接用于“知识卡片”页面的结构化内容。"
                "所有内容都必须忠实原文，不得编造，不得补充外部资料，不得输出 JSON 以外的任何文字。"
                "You must return valid json only."
            )
        )
        user_template = (
            self._settings.summary_user_prompt_template.strip()
            if self._settings.summary_user_prompt_template.strip()
            else """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：
生成一个适合详情页展示的结构化摘要，让用户在不看完整视频的情况下，也能快速理解：
1. 这支视频核心在讲什么；
2. 有哪些关键观点、论据、案例、争议和结论；
3. 内容是如何逐步展开的。

强约束：
1. 必须输出合法 JSON，对象顶层只允许包含 title、overview、bulletPoints、chapters、chapterGroups 五个字段。
2. title 必须是简洁、准确的中文标题，避免口号式空话。
3. overview 必须写成 3 到 5 句中文，整体形成一段完整概述：
   - 第 1 句交代主题或讨论对象；
   - 中间句交代关键论点、论据、背景、冲突或方法；
   - 最后 1 句交代结论、判断、影响或最终落点；
   - 总体要具体、完整，适合单独作为“核心概览”展示。
4. bulletPoints 必须是 5 到 8 条中文要点，每条 28 到 88 个字：
   - 每条都要能单独成为一张知识卡片；
   - 优先提炼事实、观点、因果、对比、条件、风险、建议、争议；
   - 不要把同一件事拆成多条近义重复表达；
   - 不要写“作者认为”“视频提到”这类低信息密度前缀，直接写结论。
5. chapters 必须按内容自然分布生成，每个章节必须包含 title、start、summary：
   - chapter.title 要像小标题，短而具体，能体现这一段的主题推进；
   - chapter.summary 必须比普通概述更详细，写成 2 到 3 个短句或 40 到 120 个字，说明这一段具体讲了什么、举了什么例子、得出了什么判断；
   - chapters 应体现内容推进关系，而不是机械平均切分；
   - 章节数量不要预设固定值，应根据内容转折、主题切换、论证层次和视频时长自适应决定；
   - 短视频可以较少章节，长视频或知识密度高的视频应适当增加章节，必要时可达到 9 到 12 个；
   - 只有在确实进入新主题、新问题、新案例或新结论时才切出新章节，不要为了凑数量硬拆。
6. chapterGroups 用来表示“大章节 / 小章节”层级，按真实结构归纳大章节；每个大章节必须包含 title、start、summary、children：
   - children 必须是从 chapters 中归并出来的小章节数组，每项仍然包含 title、start、summary；
   - chapterGroups.summary 要概括该大章节的主题推进，20 到 60 个字；
   - chapterGroups.title 必须是有内容的主题名，禁止使用“大章节1”“第一部分”“Part 1”“Section 1”这类占位标题；
   - 当原文层级明显时，大章节数量也应随内容自适应，不要固定成 2 到 4 组；
   - 如果层级不明显，可以少量归并；如果层级明显，可以返回更多组，但不要机械平均分配。
7. start 必须使用视频里真实出现的时间点，单位为秒，按升序排列。
8. 如果原文信息有限，也必须尽量提炼出非空 bulletPoints 和 chapters，不能返回空数组。
9. 不要写“视频主要讲了”“本视频介绍了”“作者首先”这类模板化空话，直接进入信息本体。
10. 不要引用不存在的数据，不要补充外部背景，不要猜测说话者未明确表达的动机。

写作要求：
- 保持中文自然、清楚、具体，避免官话和营销口吻。
- 优先保留高价值信息：定义、判断、证据、例子、条件、限制、影响、结论。
- 如果视频包含多个层次，overview 负责总览，bulletPoints 负责拆出关键结论，chapters 负责还原内容推进，chapterGroups 负责归纳章节层级。
- 标题必须像真实目录项，而不是编号占位符；宁可少而准，也不要为了数量固定而硬拆。

输出格式示例：
{{"title":"","overview":"","bulletPoints":["", "", "", "", ""],"chapters":[{{"title":"","start":0,"summary":""}}],"chapterGroups":[{{"title":"","start":0,"summary":"","children":[{{"title":"","start":0,"summary":""}}]}}]}}

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

    def _build_knowledge_note_messages(
        self,
        title: str,
        transcript_excerpt: str,
        segments_excerpt: str,
        summary_json: str,
    ) -> list[dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    "你是一名严谨、擅长整理学习型内容的中文知识编辑。"
                    "你的任务是基于转写、分段和现有结构化摘要，单独产出一篇适合阅读的知识笔记。"
                    "知识笔记必须比知识卡片更完整，能够承担学习、回顾和查阅任务。"
                    "所有内容都必须忠实原文，不得编造，不得补充外部资料，不得输出 JSON 以外的任何文字。"
                    "You must return valid json only."
                ),
            },
            {
                "role": "user",
                "content": self._render_user_prompt_template(
                    """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：
基于原始转写和结构化摘要，生成一篇适合详情页“知识笔记”阅读视图的 Markdown 笔记。

强约束：
1. 顶层只允许包含 knowledgeNoteMarkdown 一个字段。
2. knowledgeNoteMarkdown 必须是一篇完整 Markdown 笔记，不要输出代码围栏包裹整篇内容。
3. 笔记必须明显区别于知识卡片：
   - 不要只是把 bulletPoints 改写一遍；
   - 要有连续叙述、上下文解释、章节展开和重点串联；
   - 允许引用已有结构化摘要，但必须重新组织为适合阅读的笔记。
4. 遇到知识类内容时，优先组织为：核心结论、关键概念、推理/方法、章节展开、易错点/限制。
5. 遇到教程、评论、新闻等非知识类内容时，退化为通用深度笔记：主题概览、关键信息、内容推进、结论/影响。
6. 只有在原文确实涉及公式、符号、函数、逻辑表达式时才使用 LaTeX：
   - 行内公式使用 `$...$`
   - 独立公式使用 `$$...$$`
   - 不要强行输出数学公式。
7. 不要照抄转写全文，不要把原始 transcript 直接拼进笔记主体。
8. 不要补充外部背景，不要编造例子，不要猜测说话者未表达的动机。

写作要求：
- 标题层级清楚，便于长文阅读。
- 保留定义、条件、因果、例子、结论、限制、争议等高价值信息。
- 如果结构化摘要过于简略，应优先参考转写和分段把笔记写得更完整。

输出格式示例：
{{"knowledgeNoteMarkdown":"# 标题\n\n## 核心结论\n\n..."}}

视频标题：
{title}

已有结构化摘要：
{summary_json}

转写节选：
{transcript_excerpt}

分段数据节选：
{segments_excerpt}""",
                    title=title,
                    transcript_excerpt=transcript_excerpt,
                    segments_excerpt=segments_excerpt,
                    summary_json=summary_json,
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
        summary_json: str = "",
        knowledge_note_markdown: str = "",
    ) -> str:
        rendered = template
        replacements = {
            "title": title,
            "transcript": transcript_excerpt,
            "transcript_excerpt": transcript_excerpt,
            "segments_json": segments_excerpt,
            "segments_excerpt": segments_excerpt,
            "summary_json": summary_json,
            "knowledge_note_markdown": knowledge_note_markdown,
        }
        for key, value in replacements.items():
            rendered = rendered.replace(f"{{{key}}}", value)
        return rendered.replace("{{", "{").replace("}}", "}")

    def _build_llm_knowledge_note_payload(
        self,
        title: str,
        transcript_excerpt: str,
        segments_excerpt: str,
        summary_json: str,
    ) -> dict[str, object]:
        messages = self._build_knowledge_note_messages(title, transcript_excerpt, segments_excerpt, summary_json)
        messages = self._ensure_json_keyword_in_messages(messages)
        return {
            "model": self._settings.llm_model,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "enable_thinking": False,
        }

    def _generate_knowledge_note_with_llm(
        self,
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
        summary: dict[str, object],
    ) -> dict[str, object]:
        base_url = (self._settings.llm_base_url or "").rstrip("/")
        if not base_url or not self._settings.llm_model:
            raise LLMConfigurationError("LLM 配置不完整，请检查 Base URL 和模型名。")
        transcript_excerpt = self._build_transcript_excerpt(transcript)
        segments_excerpt = self._build_segments_excerpt(segments)
        summary_json = _truncate_text(
            json.dumps(
                {
                    "title": summary.get("title"),
                    "overview": summary.get("overview"),
                    "bulletPoints": summary.get("bulletPoints"),
                    "chapters": summary.get("chapters"),
                },
                ensure_ascii=False,
            ),
            2400,
        )
        logger.info(
            "llm knowledge note request model=%s transcript_chars=%d segments=%d summary_chars=%d",
            self._settings.llm_model,
            len(transcript_excerpt),
            len(segments),
            len(summary_json),
        )
        payload = self._build_llm_knowledge_note_payload(
            title=title,
            transcript_excerpt=transcript_excerpt,
            segments_excerpt=segments_excerpt,
            summary_json=summary_json,
        )
        result = self._request_llm_json(base_url=base_url, payload=payload)
        result.setdefault("knowledgeNoteMarkdown", "")
        if not str(result.get("knowledgeNoteMarkdown") or "").strip():
            raise VideoSumError("LLM returned empty knowledge note markdown.")
        return result

    def build_and_export_mindmap(
        self,
        task_id: str,
        title: str,
        result: TaskResult,
    ) -> tuple[TaskMindMap, Path]:
        mindmap = self._generate_mindmap_with_llm(title=title, result=result)
        task_dir = ensure_directory(self._settings.tasks_dir / task_id)
        mindmap_path = task_dir / "mindmap.json"
        mindmap_path.write_text(
            json.dumps(mindmap.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return mindmap, mindmap_path

    def _build_mindmap_messages(
        self,
        title: str,
        summary_json: str,
        knowledge_note_markdown: str,
    ) -> list[dict[str, str]]:
        system_prompt = (
            self._settings.mindmap_system_prompt.strip()
            if self._settings.mindmap_system_prompt.strip()
            else (
                "你是一名擅长把学习内容重新组织为知识导图的中文内容编辑。"
                "你的任务是基于已有结构化摘要和知识笔记，输出一个适合思维导图展示、信息密度充足、覆盖完整的 JSON 树。"
                "所有内容都必须忠实原文，不得编造，不得补充外部资料，不得输出 JSON 以外的任何文字。"
                "You must return valid json only."
            )
        )
        user_template = (
            self._settings.mindmap_user_prompt_template.strip()
            if self._settings.mindmap_user_prompt_template.strip()
            else """请阅读下面的视频资料，并输出一个 JSON 对象。
注意：你必须返回合法的 json 对象，且只返回 json。

目标：
把当前视频内容组织成一棵真正“像思维导图”的知识树。它必须以概念、主题、方法、结论之间的关系为核心，而不是把章节标题换个层级重新排列。最末层节点仍然必须能回到原视频片段。

强约束：
1. 顶层只允许包含 title、root、nodes 三个字段。
2. root 必须是整棵导图的根节点 id。
3. nodes 必须是数组，其中包含唯一的根节点；每个节点必须包含 id、label、type、summary、children、time_anchor、source_chapter_titles、source_chapter_starts。
4. type 只能是 root、theme、topic、leaf 之一。
5. 整体结构必须是树，最大深度为 root -> theme -> topic/leaf -> leaf。
6. 顶层 theme 数量应为 4 到 8 个，每个 theme 下应有 3 到 6 个 topic 或 leaf；除非原内容本身很短，否则不要生成过于稀疏的导图。
7. leaf 节点必须能映射到原章节，并带真实时间点；time_anchor 必须取自 source_chapter_starts 中最早的时间点。
8. source_chapter_titles 和 source_chapter_starts 只保留最相关的 1 到 3 项，且数量一致。
9. label 必须是有内容的主题名，禁止“主题1”“Part 1”“Section 1”等占位标题。
10. summary 要适合学习复盘，直接写信息本体，不要重复整段知识笔记；theme/topic 的 summary 尽量写成 2 到 4 句，leaf 的 summary 至少要交代“结论 / 方法 / 条件 / 例子”中的两项。
11. label 和 summary 内如果出现数学内容，优先使用 KaTeX 兼容的 LaTeX 写法，例如 `$\\frac{1}{n}$`、`$(-1)^n$`、`$\\varepsilon$-$N$`；不要输出无法解析的伪公式。
12. 只允许输出 JSON；但 JSON 字符串内部允许包含少量 Markdown 和 `$...$` / `$$...$$` 数学公式。
13. 不要把 chapters 或 chapterGroups 直接一一平移成 theme/topic；必须先做语义归纳，再组织层级。
14. 如果多个章节都在讲同一个概念、同一种方法、同一类例子，应该聚合成一个主题，而不是拆成多个并列节点。
15. 导图的每一层都应体现“父主题如何拆成子主题”，而不是简单的时间顺序。

写作要求：
- 优先按“概念定义 / 推导方法 / 典型例子 / 易错点 / 结论判断 / 应用条件”这类知识结构重组。
- 根节点应该是整支视频真正的学习主题，不要只是视频标题原样重复，除非标题本身已经是明确概念。
- theme 层应该是 4 到 8 个最核心的大主题，彼此之间要有明显区分。
- topic 层应承担细化作用，只有当某个 theme 下确实存在两到三类不同子议题时才保留 topic；否则可直接挂 leaf。
- leaf 节点要具体、短促、可点击后立刻看懂，不要写成长句，也不要只是“第X部分”。
- 允许把多个来源章节压缩成一个更抽象、更像脑图节点的表达。
- 如果原文本身是教程或知识讲解，优先提炼“知识结构”；如果原文是评论或资讯，优先提炼“观点结构”和“因果关系”。
- 若视频包含公式、定义、判别条件、证明步骤、典型例题，不要省略它们；应把它们拆成独立主题或叶子节点，而不是只保留一个笼统标题。
- 不要怕信息多，只要层级清楚即可；优先保证“覆盖完整”和“节点可学”，不要只给每个主题一个空泛标签。
- 对于数学/理工类内容，优先把“定义、命题、判别条件、证明思路、典型例题、易错点”拆成不同节点；不要把整段证明压成一句泛泛描述。
- 如果一个 theme 下只生成了 1 个叶子节点，优先继续细化，除非原文确实只讲了这一点。
- 如果知识笔记已经给出分点、例题或条件，你应该把这些信息展开到对应节点，而不是只复述 theme 名称。
- 最终观感要像学习者自己整理出来的脑图，而不是讲稿目录。

输出格式示例：
{{"title":"","root":"root","nodes":[{{"id":"root","label":"","type":"root","summary":"","children":[{{"id":"theme-1","label":"","type":"theme","summary":"","children":[{{"id":"leaf-1","label":"","type":"leaf","summary":"","children":[],"time_anchor":0,"source_chapter_titles":[""],"source_chapter_starts":[0]}}],"source_chapter_titles":[],"source_chapter_starts":[]}}],"source_chapter_titles":[],"source_chapter_starts":[]}}]}}

视频标题：
{title}

已有结构化摘要：
{summary_json}

知识笔记：
{knowledge_note_markdown}"""
        )
        return [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": self._render_user_prompt_template(
                    user_template,
                    title=title,
                    transcript_excerpt="",
                    segments_excerpt="",
                    summary_json=summary_json,
                    knowledge_note_markdown=knowledge_note_markdown,
                ),
            },
        ]

    def _build_llm_mindmap_payload(
        self,
        title: str,
        summary_json: str,
        knowledge_note_markdown: str,
    ) -> dict[str, object]:
        messages = self._build_mindmap_messages(title, summary_json, knowledge_note_markdown)
        messages = self._ensure_json_keyword_in_messages(messages)
        return {
            "model": self._settings.llm_model,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "enable_thinking": False,
        }

    def _generate_mindmap_with_llm(
        self,
        title: str,
        result: TaskResult,
    ) -> TaskMindMap:
        base_url = (self._settings.llm_base_url or "").rstrip("/")
        if not base_url or not self._settings.llm_model:
            raise LLMConfigurationError("LLM 配置不完整，请检查 Base URL 和模型名。")

        summary_json = _truncate_text(
            json.dumps(
                {
                    "title": title,
                    "overview": result.overview,
                    "keyPoints": result.key_points,
                    "chapters": result.timeline,
                    "chapterGroups": result.chapter_groups,
                },
                ensure_ascii=False,
            ),
            9000,
        )
        knowledge_note_markdown = _truncate_text(result.knowledge_note_markdown or "", 12000)
        logger.info(
            "llm mindmap request model=%s summary_chars=%d knowledge_note_chars=%d key_points=%d chapters=%d chapter_groups=%d",
            self._settings.llm_model,
            len(summary_json),
            len(knowledge_note_markdown),
            len(result.key_points or []),
            len(result.timeline or []),
            len(result.chapter_groups or []),
        )
        payload = self._build_llm_mindmap_payload(title, summary_json, knowledge_note_markdown)
        llm_result = self._request_llm_json(base_url=base_url, payload=payload)
        return self._normalize_mindmap_payload(llm_result, title=title, result=result)

    def _normalize_mindmap_payload(
        self,
        payload: dict[str, object],
        *,
        title: str,
        result: TaskResult,
    ) -> TaskMindMap:
        chapters = [
            {
                "title": str(item.get("title") or "").strip(),
                "start": float(item.get("start") or 0),
                "summary": str(item.get("summary") or "").strip(),
            }
            for item in result.timeline
            if isinstance(item, dict)
        ]
        root_id = str(payload.get("root") or "root").strip() or "root"
        raw_nodes = payload.get("nodes")
        root_node_payload: dict[str, object] | None = None
        if isinstance(raw_nodes, list):
            for item in raw_nodes:
                if isinstance(item, dict) and str(item.get("id") or "").strip() == root_id:
                    root_node_payload = item
                    break
            if root_node_payload is None:
                root_node_payload = next((item for item in raw_nodes if isinstance(item, dict)), None)
        elif isinstance(raw_nodes, dict):
            root_node_payload = raw_nodes
        if root_node_payload is None:
            root_node_payload = {"id": root_id, "label": title, "type": "root", "summary": result.overview, "children": []}

        used_ids: set[str] = set()
        root_node = self._normalize_mindmap_node(
            root_node_payload,
            depth=0,
            title=title,
            chapters=chapters,
            used_ids=used_ids,
        )
        root_node.id = root_id
        root_node.type = "root"
        if not root_node.label.strip():
            root_node.label = title

        if len(root_node.children) > 8:
            root_node.children = root_node.children[:8]

        return TaskMindMap(version=1, title=str(payload.get("title") or title).strip() or title, root=root_node.id, nodes=[root_node])

    def _normalize_mindmap_node(
        self,
        payload: dict[str, object],
        *,
        depth: int,
        title: str,
        chapters: list[dict[str, object]],
        used_ids: set[str],
    ) -> MindMapNode:
        raw_children = payload.get("children")
        child_payloads = [item for item in raw_children if isinstance(item, dict)] if isinstance(raw_children, list) else []
        normalized_children: list[MindMapNode] = []
        if depth < 3:
            max_children = 8 if depth == 0 else 6
            for child in child_payloads[:max_children]:
                normalized_children.append(
                    self._normalize_mindmap_node(
                        child,
                        depth=depth + 1,
                        title=title,
                        chapters=chapters,
                        used_ids=used_ids,
                    )
                )

        label = self._normalize_content_title(
            str(payload.get("label") or payload.get("title") or "").strip(),
            fallback_text=str(payload.get("summary") or "").strip(),
            fallback_prefix="主题" if depth <= 1 else "节点",
            fallback_index=max(1, len(used_ids) + 1),
        )
        summary = _truncate_text(str(payload.get("summary") or "").strip(), 360)
        source_titles = [str(item).strip() for item in (payload.get("source_chapter_titles") or []) if str(item).strip()]
        source_starts: list[float] = []
        for item in (payload.get("source_chapter_starts") or []):
            if item is None or str(item).strip() == "":
                continue
            try:
                source_starts.append(float(item))
            except (TypeError, ValueError):
                continue

        if not source_titles and not source_starts:
            inferred_titles, inferred_starts = self._infer_mindmap_sources(label, summary, chapters)
            source_titles = inferred_titles
            source_starts = inferred_starts

        if len(source_titles) > 3:
            source_titles = source_titles[:3]
        if len(source_starts) > 3:
            source_starts = source_starts[:3]
        pair_count = min(len(source_titles), len(source_starts))
        if pair_count:
            source_titles = source_titles[:pair_count]
            source_starts = source_starts[:pair_count]

        raw_time_anchor = payload.get("time_anchor")
        time_anchor = float(raw_time_anchor) if raw_time_anchor is not None and str(raw_time_anchor).strip() != "" else None
        if time_anchor is None and source_starts:
            time_anchor = min(source_starts)
        if time_anchor is None and normalized_children:
            child_anchors = [child.time_anchor for child in normalized_children if child.time_anchor is not None]
            if child_anchors:
                time_anchor = min(child_anchors)

        node_type = str(payload.get("type") or "").strip().lower()
        if depth == 0:
            node_type = "root"
        elif depth == 1:
            node_type = "theme"
        elif normalized_children and depth < 3:
            node_type = "topic"
        else:
            node_type = "leaf"
            normalized_children = []

        if node_type == "leaf" and time_anchor is None:
            inferred_titles, inferred_starts = self._infer_mindmap_sources(label, summary, chapters)
            if inferred_starts:
                source_titles = inferred_titles
                source_starts = inferred_starts
                time_anchor = min(inferred_starts)

        node_id = self._normalize_mindmap_node_id(str(payload.get("id") or "").strip(), label, node_type, used_ids)

        return MindMapNode(
            id=node_id,
            label=label or ("根节点" if depth == 0 else "主题"),
            type=node_type,
            summary=summary,
            children=normalized_children,
            time_anchor=time_anchor if node_type == "leaf" else None,
            source_chapter_titles=source_titles,
            source_chapter_starts=source_starts,
        )

    def _normalize_mindmap_node_id(
        self,
        raw_id: str,
        label: str,
        node_type: str,
        used_ids: set[str],
    ) -> str:
        base = raw_id or re.sub(r"[^a-z0-9]+", "-", self._dedupe_text_key(label or node_type)).strip("-")
        if not base:
            base = node_type
        candidate = base
        suffix = 2
        while candidate in used_ids:
            candidate = f"{base}-{suffix}"
            suffix += 1
        used_ids.add(candidate)
        return candidate

    def _infer_mindmap_sources(
        self,
        label: str,
        summary: str,
        chapters: list[dict[str, object]],
    ) -> tuple[list[str], list[float]]:
        if not chapters:
            return [], []
        query = self._dedupe_text_key(f"{label} {summary}")
        ranked: list[tuple[int, dict[str, object]]] = []
        for chapter in chapters:
            title = str(chapter.get("title") or "").strip()
            chapter_summary = str(chapter.get("summary") or "").strip()
            haystack = self._dedupe_text_key(f"{title} {chapter_summary}")
            score = 0
            if label and self._dedupe_text_key(label) and self._dedupe_text_key(label) in haystack:
                score += 5
            if summary and self._dedupe_text_key(summary) and self._dedupe_text_key(summary)[:12] in haystack:
                score += 4
            if query and haystack:
                score += len(set(query[:24]) & set(haystack[:24]))
            ranked.append((score, chapter))
        ranked.sort(key=lambda item: (-item[0], float(item[1].get("start") or 0)))
        selected = [item[1] for item in ranked[:3] if item[0] > 0] or [ranked[0][1]]
        titles = [str(item.get("title") or "").strip() for item in selected if str(item.get("title") or "").strip()]
        starts = [float(item.get("start") or 0) for item in selected]
        return titles[:3], starts[:3]

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
                    "chunk_start": float(current[0].get("start") or 0),
                    "chunk_end": float(current[-1].get("end") or current[-1].get("start") or 0),
                    "source_segment_count": len(current),
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
        merged_chapters: list[dict[str, object]] | None = None,
    ) -> tuple[str, str]:
        lines: list[str] = []
        segments: list[dict[str, object]] = []
        final_chapters = merged_chapters or []

        if final_chapters:
            lines.append("## 合并后的全局章节")
            for chapter in final_chapters:
                start = float(chapter.get("start") or 0)
                chapter_title = str(chapter.get("title") or "").strip()
                summary = str(chapter.get("summary") or "").strip()
                if not summary:
                    continue
                lines.append(f"[{self._format_seconds(start)}] {chapter_title}：{summary}")
                segments.append(
                    {
                        "start": start,
                        "text": _truncate_text(f"{chapter_title}：{summary}", 180),
                    }
                )
            lines.append("")

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
            "chapterGroups": self._build_chapter_groups_from_chapters(chapters),
            "knowledgeNoteMarkdown": self._build_knowledge_note_markdown(
                title=title or "视频摘要",
                overview=overview,
                bullet_points=bullet_points,
                chapters=chapters,
                transcript=transcript,
            ),
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

        chapters = self._coerce_chapters(normalized.get("chapters"), segments)
        if not chapters:
            chapters = self._build_chapters_fallback(segments)
        normalized["chapters"] = chapters
        chapter_groups = self._coerce_chapter_groups(normalized.get("chapterGroups"), chapters)
        if not chapter_groups:
            chapter_groups = self._build_chapter_groups_from_chapters(chapters)
        normalized["chapterGroups"] = chapter_groups

        knowledge_note_markdown = str(normalized.get("knowledgeNoteMarkdown") or "").strip()
        if not knowledge_note_markdown:
            knowledge_note_markdown = self._build_knowledge_note_markdown(
                title=str(normalized["title"]),
                overview=overview,
                bullet_points=bullet_points,
                chapters=chapters,
                transcript=transcript,
            )
        normalized["knowledgeNoteMarkdown"] = knowledge_note_markdown
        return normalized

    def _build_knowledge_note_markdown(
        self,
        title: str,
        overview: str,
        bullet_points: list[str],
        chapters: list[dict[str, object]],
        transcript: str,
    ) -> str:
        sections: list[str] = [f"# {title or '知识笔记'}"]

        if overview:
            sections.extend(["", "## 核心概览", "", overview.strip()])

        if bullet_points:
            sections.extend(["", "## 关键要点", ""])
            sections.extend(f"- {point.strip()}" for point in bullet_points if point.strip())

        if chapters:
            sections.extend(["", "## 内容展开"])
            for index, chapter in enumerate(chapters, start=1):
                chapter_title = str(chapter.get("title") or f"章节 {index}").strip()
                chapter_summary = str(chapter.get("summary") or "").strip()
                start = float(chapter.get("start") or 0)
                sections.extend(
                    [
                        "",
                        f"### {chapter_title}",
                        "",
                        f"- 时间点：{self._format_seconds(start)}",
                    ]
                )
                if chapter_summary:
                    sections.extend(["", chapter_summary])

        transcript_lines = [line.strip() for line in transcript.splitlines() if line.strip()]
        if transcript_lines:
            sections.extend(["", "## 原文摘录", ""])
            excerpt = transcript_lines[:6]
            sections.extend(f"> {line}" for line in excerpt)
            if len(transcript_lines) > len(excerpt):
                sections.extend(["", "> ..."])

        return "\n".join(sections).strip()

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

    def _merge_structured_summary(
        self,
        merged: dict[str, object],
        partial_summaries: list[dict[str, object]],
        merged_chapters: list[dict[str, object]],
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
    ) -> dict[str, object]:
        result = dict(merged)
        structural_chapters = merged_chapters or self._merge_partial_chapters(partial_summaries, segments)
        target_count = self._suggest_chapter_count(segments)
        llm_chapters = self._coerce_chapters(result.get("chapters"), segments)

        if len(llm_chapters) >= max(3, min(target_count, len(structural_chapters))) and len(llm_chapters) >= len(structural_chapters):
            final_chapters = llm_chapters
        else:
            final_chapters = structural_chapters or llm_chapters or self._build_chapters_fallback(segments)
        final_chapters = self._rebalance_chapters_for_coverage(final_chapters, segments)

        result["title"] = str(result.get("title") or title or "视频摘要").strip()
        result["overview"] = str(result.get("overview") or "").strip() or self._build_overview_from_partials(partial_summaries, transcript)
        bullet_points = self._coerce_bullet_points(result.get("bulletPoints"))
        if len(bullet_points) < min(5, max(3, math.ceil(target_count / 2))):
            bullet_points = self._build_bullet_points_from_partials(partial_summaries, final_chapters, result["overview"], transcript, segments)
        result["bulletPoints"] = bullet_points
        result["chapters"] = final_chapters
        result["chapterGroups"] = self._build_chapter_groups_from_chapters(final_chapters)
        return result

    def _merge_partial_chapters(
        self,
        partial_summaries: list[dict[str, object]],
        segments: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        merged: list[dict[str, object]] = []
        seen_keys: set[tuple[int, str]] = set()

        for partial in partial_summaries:
            chunk_start = float(partial.get("chunk_start") or 0)
            chunk_end = float(partial.get("chunk_end") or chunk_start)
            chapters = self._coerce_chapters(partial.get("chapters"), segments)
            for chapter in chapters:
                start = self._align_chapter_start(float(chapter.get("start") or chunk_start), segments, chunk_start, chunk_end)
                title = str(chapter.get("title") or "").strip()
                summary = str(chapter.get("summary") or "").strip()
                if not summary:
                    continue
                dedupe_key = (int(start), self._dedupe_text_key(title or summary))
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                self._append_or_merge_chapter(
                    merged,
                    {
                        "title": title,
                        "start": start,
                        "summary": summary,
                    },
                )

        merged.sort(key=lambda item: float(item.get("start") or 0))
        normalized: list[dict[str, object]] = []
        for index, chapter in enumerate(merged, start=1):
            title = self._normalize_content_title(
                str(chapter.get("title") or "").strip(),
                fallback_text=str(chapter.get("summary") or "").strip(),
                fallback_prefix="章节",
                fallback_index=index,
            )
            normalized.append(
                {
                    "title": title,
                    "start": float(chapter.get("start") or 0),
                    "summary": str(chapter.get("summary") or "").strip()[:160],
                }
            )
        return self._rebalance_chapters_for_coverage(normalized, segments)

    def _append_or_merge_chapter(
        self,
        chapters: list[dict[str, object]],
        chapter: dict[str, object],
    ) -> None:
        start = float(chapter.get("start") or 0)
        title_key = self._dedupe_text_key(str(chapter.get("title") or ""))
        summary = str(chapter.get("summary") or "").strip()

        for existing in chapters:
            existing_start = float(existing.get("start") or 0)
            existing_title_key = self._dedupe_text_key(str(existing.get("title") or ""))
            if abs(existing_start - start) <= 45 or (title_key and title_key == existing_title_key):
                existing_summary = str(existing.get("summary") or "").strip()
                if len(summary) > len(existing_summary):
                    existing["summary"] = summary
                if len(str(chapter.get("title") or "")) > len(str(existing.get("title") or "")):
                    existing["title"] = str(chapter.get("title") or "")
                existing["start"] = min(existing_start, start)
                return
        chapters.append(dict(chapter))

    def _align_chapter_start(
        self,
        start: float,
        segments: list[dict[str, object]],
        chunk_start: float,
        chunk_end: float,
    ) -> float:
        if not segments:
            return max(0.0, start)
        candidates = [
            float(segment.get("start") or 0)
            for segment in segments
            if chunk_start - 1e-6 <= float(segment.get("start") or 0) <= max(chunk_end, chunk_start)
        ]
        if not candidates:
            candidates = [float(segment.get("start") or 0) for segment in segments]
        if not candidates:
            return max(0.0, start)
        return min(candidates, key=lambda item: abs(item - start))

    def _build_overview_from_partials(
        self,
        partial_summaries: list[dict[str, object]],
        transcript: str,
    ) -> str:
        sentences: list[str] = []
        for partial in partial_summaries:
            overview = str(partial.get("overview") or "").strip()
            if not overview:
                continue
            for piece in re.split(r"(?<=[。！？!?])", overview):
                clean_piece = piece.strip()
                if clean_piece and clean_piece not in sentences:
                    sentences.append(clean_piece)
                if len(sentences) >= 5:
                    return "".join(sentences)[:400]
        return self._build_overview_fallback(transcript)

    def _build_bullet_points_from_partials(
        self,
        partial_summaries: list[dict[str, object]],
        chapters: list[dict[str, object]],
        overview: str,
        transcript: str,
        segments: list[dict[str, object]],
    ) -> list[str]:
        points: list[str] = []
        for partial in partial_summaries:
            for point in partial.get("bulletPoints") or []:
                clean_point = str(point).strip()
                if not clean_point:
                    continue
                key = self._dedupe_text_key(clean_point)
                if any(self._dedupe_text_key(existing) == key for existing in points):
                    continue
                points.append(clean_point[:88])
                if len(points) >= 8:
                    return points

        for chapter in chapters:
            summary = str(chapter.get("summary") or "").strip()
            if not summary:
                continue
            candidate = summary[:88]
            key = self._dedupe_text_key(candidate)
            if any(self._dedupe_text_key(existing) == key for existing in points):
                continue
            points.append(candidate)
            if len(points) >= 8:
                return points

        fallback = self._build_bullet_points_fallback(overview, transcript, segments)
        for point in fallback:
            clean_point = str(point).strip()
            key = self._dedupe_text_key(clean_point)
            if clean_point and not any(self._dedupe_text_key(existing) == key for existing in points):
                points.append(clean_point)
            if len(points) >= 8:
                break
        return points[:8]

    def _dedupe_text_key(self, value: str) -> str:
        normalized = re.sub(r"[\W_]+", "", str(value or "").lower())
        return normalized[:24]

    def _coerce_chapters(
        self,
        value: object,
        segments: list[dict[str, object]] | None = None,
    ) -> list[dict[str, object]]:
        if not isinstance(value, list):
            return []
        chapters: list[dict[str, object]] = []
        limit = self._chapter_limit(segments or [])
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            summary = str(item.get("summary") or "").strip()
            if not summary:
                continue
            title = self._normalize_content_title(
                str(item.get("title") or "").strip(),
                fallback_text=summary,
                fallback_prefix="章节",
                fallback_index=index + 1,
            )
            chapters.append(
                {
                    "title": title,
                    "start": float(item.get("start") or 0),
                    "summary": summary[:160],
                }
            )
        return chapters[:limit]

    def _build_chapters_fallback(self, segments: list[dict[str, object]]) -> list[dict[str, object]]:
        if not segments:
            return []
        chapters: list[dict[str, object]] = []
        target_count = self._suggest_chapter_count(segments)
        step = max(1, math.ceil(len(segments) / max(1, target_count)))
        for index in range(0, len(segments), step):
            group = segments[index : index + step]
            if not group:
                continue
            summary = " ".join(str(item.get("text") or "").strip() for item in group if str(item.get("text") or "").strip())
            if not summary:
                continue
            chapters.append(
                {
                    "title": self._normalize_content_title(
                        "",
                        fallback_text=summary,
                        fallback_prefix="章节",
                        fallback_index=len(chapters) + 1,
                    ),
                    "start": float(group[0].get("start") or 0),
                    "summary": summary[:160],
                }
            )
            if len(chapters) >= self._chapter_limit(segments):
                break
        return self._rebalance_chapters_for_coverage(chapters, segments)

    def _coerce_chapter_groups(
        self,
        value: object,
        chapters: list[dict[str, object]] | None = None,
    ) -> list[dict[str, object]]:
        if not isinstance(value, list):
            return []
        groups: list[dict[str, object]] = []
        limit = self._chapter_group_limit(chapters or [])
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            children = self._coerce_chapters(item.get("children"), chapters)
            if not children:
                continue
            summary = str(item.get("summary") or "").strip()[:120]
            title = self._normalize_content_title(
                str(item.get("title") or "").strip(),
                fallback_text=summary,
                fallback_prefix="主题",
                fallback_index=index + 1,
                child_titles=[str(child.get("title") or "").strip() for child in children],
            )
            groups.append(
                {
                    "title": title,
                    "start": float(item.get("start") or children[0].get("start") or 0),
                    "summary": summary,
                    "children": children,
                }
            )
        return groups[:limit]

    def _build_chapter_groups_from_chapters(self, chapters: list[dict[str, object]]) -> list[dict[str, object]]:
        if not chapters:
            return []
        desired_groups = self._suggest_chapter_group_count(chapters)
        group_size = max(1, math.ceil(len(chapters) / max(1, desired_groups)))
        groups: list[dict[str, object]] = []
        for index in range(0, len(chapters), group_size):
            items = chapters[index : index + group_size]
            if not items:
                continue
            first = items[0]
            last = items[-1]
            summary = "；".join(str(item.get("title") or "").strip() for item in items if str(item.get("title") or "").strip())
            groups.append(
                {
                    "title": self._normalize_content_title(
                        "",
                        fallback_text=summary,
                        fallback_prefix="主题",
                        fallback_index=len(groups) + 1,
                        child_titles=[str(item.get("title") or "").strip() for item in items],
                    ),
                    "start": float(first.get("start") or 0),
                    "summary": summary[:120] or f"{self._format_seconds(float(first.get('start') or 0))} - {self._format_seconds(float(last.get('start') or 0))}",
                    "children": items,
                }
            )
        return groups[: self._chapter_group_limit(chapters)]

    def _chapter_limit(self, segments: list[dict[str, object]]) -> int:
        if not segments:
            return 12
        target = self._suggest_chapter_count(segments)
        return max(8, min(48, target * 2))

    def _chapter_group_limit(self, chapters: list[dict[str, object]]) -> int:
        if not chapters:
            return 5
        return max(2, min(8, self._suggest_chapter_group_count(chapters) + 1))

    def _suggest_chapter_count(self, segments: list[dict[str, object]]) -> int:
        if not segments:
            return 4
        first_start = float(segments[0].get("start") or 0)
        last_end = float(segments[-1].get("end") or segments[-1].get("start") or first_start)
        duration = max(0.0, last_end - first_start)
        segment_count = len(segments)
        duration_minutes = duration / 60.0 if duration > 0 else 0.0
        duration_target = math.ceil(duration_minutes / 3.5) if duration_minutes > 0 else 4
        density_target = math.ceil(segment_count / 120) if segment_count > 0 else 0
        return max(4, min(28, max(duration_target, density_target, 4)))

    def _suggest_chapter_group_count(self, chapters: list[dict[str, object]]) -> int:
        chapter_count = len(chapters)
        return max(1, min(8, math.ceil(chapter_count / 4)))

    def _rebalance_chapters_for_coverage(
        self,
        chapters: list[dict[str, object]],
        segments: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        if not chapters:
            return []

        ordered = sorted(chapters, key=lambda item: float(item.get("start") or 0))
        target_count = self._suggest_chapter_count(segments)
        if len(ordered) <= target_count:
            return ordered

        first_start = float(segments[0].get("start") or ordered[0].get("start") or 0) if segments else float(ordered[0].get("start") or 0)
        last_end = (
            float(segments[-1].get("end") or segments[-1].get("start") or ordered[-1].get("start") or first_start)
            if segments
            else float(ordered[-1].get("start") or first_start)
        )
        duration = max(1.0, last_end - first_start)
        window_size = max(45.0, duration / max(1, target_count))

        buckets: list[list[dict[str, object]]] = []
        for chapter in ordered:
            start = float(chapter.get("start") or 0)
            bucket_index = min(target_count - 1, max(0, int((start - first_start) / window_size)))
            while len(buckets) <= bucket_index:
                buckets.append([])
            buckets[bucket_index].append(chapter)

        merged_buckets: list[dict[str, object]] = []
        for bucket in buckets:
            if not bucket:
                continue
            merged_buckets.append(self._merge_chapter_bucket(bucket))

        if len(merged_buckets) > target_count:
            sampled: list[dict[str, object]] = []
            for index in range(target_count):
                source_index = min(len(merged_buckets) - 1, round(index * (len(merged_buckets) - 1) / max(1, target_count - 1)))
                sampled.append(merged_buckets[source_index])
            deduped: list[dict[str, object]] = []
            seen: set[tuple[int, str]] = set()
            for chapter in sampled:
                key = (int(float(chapter.get("start") or 0)), self._dedupe_text_key(str(chapter.get("title") or "")))
                if key in seen:
                    continue
                seen.add(key)
                deduped.append(chapter)
            merged_buckets = deduped

        return merged_buckets

    def _merge_chapter_bucket(self, bucket: list[dict[str, object]]) -> dict[str, object]:
        first = bucket[0]
        titles = [str(item.get("title") or "").strip() for item in bucket if str(item.get("title") or "").strip()]
        summaries = [str(item.get("summary") or "").strip() for item in bucket if str(item.get("summary") or "").strip()]
        title = self._normalize_content_title(
            titles[0] if titles else "",
            fallback_text="；".join(summaries),
            fallback_prefix="章节",
            fallback_index=1,
            child_titles=titles[1:],
        )
        summary_parts: list[str] = []
        seen_summary_keys: set[str] = set()
        for summary in summaries:
            key = self._dedupe_text_key(summary)
            if not key or key in seen_summary_keys:
                continue
            seen_summary_keys.add(key)
            summary_parts.append(summary)
            if len("；".join(summary_parts)) >= 150:
                break
        return {
            "title": title,
            "start": float(first.get("start") or 0),
            "summary": "；".join(summary_parts)[:160],
        }

    def _normalize_content_title(
        self,
        title: str,
        fallback_text: str = "",
        fallback_prefix: str = "章节",
        fallback_index: int = 1,
        child_titles: list[str] | None = None,
    ) -> str:
        clean_title = self._clean_title(title)
        if clean_title and not self._is_placeholder_title(clean_title):
            return clean_title

        for child_title in child_titles or []:
            normalized = self._clean_title(child_title)
            if normalized and not self._is_placeholder_title(normalized):
                return normalized

        derived_from_text = self._derive_title_from_text(fallback_text)
        if derived_from_text:
            return derived_from_text

        return f"{fallback_prefix} {fallback_index}"

    def _clean_title(self, value: str) -> str:
        title = str(value or "").strip()
        title = re.sub(r"^[\-•\d\.\)\(、\s]+", "", title)
        if not title:
            return ""
        if self._looks_like_rich_title(title):
            return self._truncate_rich_title(title, max_length=52, extension=24)
        return title[:24]

    def _looks_like_rich_title(self, value: str) -> bool:
        title = str(value or "")
        return bool("$" in title or re.search(r"\\[A-Za-z]+|[_^{}]", title))

    def _truncate_rich_title(self, value: str, *, max_length: int, extension: int = 0) -> str:
        title = str(value or "").strip()
        if len(title) <= max_length:
            return title

        in_math = False
        last_safe_break = None
        last_safe_end = None
        hard_limit = min(len(title), max_length + max(0, extension))

        for index, char in enumerate(title[:hard_limit]):
            if char == "$" and (index == 0 or title[index - 1] != "\\"):
                in_math = not in_math
            if not in_math:
                last_safe_end = index + 1
                if char.isspace() or char in "，,。；;：:、)]）】":
                    last_safe_break = index + 1
                if index + 1 >= max_length:
                    break

        if in_math:
            opening_index = title.rfind("$", 0, hard_limit)
            if opening_index >= 8:
                return title[:opening_index].rstrip("，,。；;：:、 ")

        safe_cut = last_safe_break or last_safe_end
        if safe_cut is None or safe_cut <= 0:
            return title[:hard_limit].rstrip("，,。；;：:、 ")
        return title[:safe_cut].rstrip("，,。；;：:、 ")

    def _is_placeholder_title(self, value: str) -> bool:
        title = str(value or "").strip()
        if not title:
            return True
        normalized = title.lower()
        return bool(
            re.fullmatch(r"(大)?章节\s*\d+", title)
            or re.fullmatch(r"主题\s*\d+", title)
            or re.fullmatch(r"第?\s*\d+\s*(章|节|部分)", title)
            or re.fullmatch(r"(part|section|chapter)\s*[-:：]?\s*\d+", normalized)
        )

    def _derive_title_from_text(self, value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        text = re.sub(r"^(这一部分|本部分|这里|该部分|这一章|本章|本节|这一节)(主要)?(讲|介绍|讨论|说明|分析|围绕)?", "", text)
        text = re.split(r"[。；!！?？\n]", text, maxsplit=1)[0].strip(" ：:-")
        text = re.sub(r"\s+", "", text)
        if not text:
            return ""
        if len(text) > 24:
            text = text[:24].rstrip("，,、；;：:")
        return text

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
        knowledge_note_path = task_dir / "knowledge_note.md"
        knowledge_note_markdown = str(summary.get("knowledgeNoteMarkdown") or "").strip()
        transcript_path.write_text(transcript, encoding="utf-8")
        summary_path.write_text(
            json.dumps({"title": title, "summary": summary, "segments": segments}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        knowledge_note_path.write_text(knowledge_note_markdown, encoding="utf-8")
        logger.info(
            "result exported transcript_path=%s summary_path=%s knowledge_note_path=%s",
            transcript_path,
            summary_path,
            knowledge_note_path,
        )
        return self._build_task_result(
            transcript,
            summary,
            artifacts={
                "transcript_path": str(transcript_path),
                "summary_path": str(summary_path),
                "knowledge_note_path": str(knowledge_note_path),
            },
        )

    def _build_task_result(
        self,
        transcript: str,
        summary: dict[str, object],
        artifacts: dict[str, str] | None = None,
    ) -> TaskResult:
        knowledge_note_markdown = str(summary.get("knowledgeNoteMarkdown") or "").strip()
        return TaskResult(
            overview=str(summary.get("overview") or ""),
            knowledge_note_markdown=knowledge_note_markdown,
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
            chapter_groups=[
                {
                    "title": str(group.get("title") or ""),
                    "start": group.get("start"),
                    "summary": str(group.get("summary") or ""),
                    "children": [
                        {
                            "title": str(item.get("title") or ""),
                            "start": item.get("start"),
                            "summary": str(item.get("summary") or ""),
                        }
                        for item in (group.get("children") or [])
                        if isinstance(item, dict)
                    ],
                }
                for group in summary.get("chapterGroups", [])
                if isinstance(group, dict)
            ],
            artifacts=artifacts or {},
            llm_prompt_tokens=_safe_int(summary.get("llm_prompt_tokens")),
            llm_completion_tokens=_safe_int(summary.get("llm_completion_tokens")),
            llm_total_tokens=_safe_int(summary.get("llm_total_tokens")),
        )
