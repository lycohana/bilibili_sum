from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import httpx
from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL

from video_sum_core.errors import UnsupportedInputError, VideoSumError
from video_sum_core.models.tasks import InputType, TaskResult
from video_sum_core.pipeline.base import PipelineContext, PipelineEvent, PipelineRunner
from video_sum_core.utils import ensure_directory, format_timestamp, normalize_video_url, sanitize_filename


@dataclass(slots=True)
class PipelineSettings:
    tasks_dir: Path
    whisper_model: str = "tiny"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"
    llm_enabled: bool = False
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = ""


class RealPipelineRunner(PipelineRunner):
    def __init__(self, settings: PipelineSettings) -> None:
        self._settings = settings

    def run(self, context: PipelineContext) -> tuple[list[PipelineEvent], TaskResult]:
        task_input = context.task_input
        if task_input.input_type is not InputType.URL:
            raise UnsupportedInputError("Current runner only supports URL input.")

        normalized_url, bvid = normalize_video_url(task_input.source)
        if "bilibili.com/video/" not in normalized_url:
            raise UnsupportedInputError("Current runner only supports Bilibili video URLs.")

        task_dir = ensure_directory(self._settings.tasks_dir / context.task_id)
        events: list[PipelineEvent] = []

        metadata = self._probe_video(normalized_url)
        title = task_input.title or metadata.get("title") or bvid or "video"
        safe_title = sanitize_filename(title)
        audio_path = self._download_audio(normalized_url, task_dir, safe_title, events)
        transcript, segments = self._transcribe(audio_path, metadata.get("duration"), events)
        summary = self._summarize(transcript, segments, title, events)
        result = self._export_result(task_dir, title, transcript, segments, summary)
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
        events: list[PipelineEvent],
    ) -> Path:
        events.append(PipelineEvent(stage="downloading", progress=10, message="开始下载音频"))
        output_template = str(task_dir / f"{safe_title}.%(ext)s")
        options = {
            "format": "bestaudio/best",
            "outtmpl": output_template,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
        }
        with YoutubeDL(options) as ydl:
            ydl.download([url])
        candidates = sorted(task_dir.glob(f"{safe_title}.*"))
        if not candidates:
            raise VideoSumError("Audio download failed.")
        events.append(PipelineEvent(stage="downloading", progress=35, message="音频下载完成"))
        return candidates[0]

    def _transcribe(
        self,
        audio_path: Path,
        duration: float | None,
        events: list[PipelineEvent],
    ) -> tuple[str, list[dict[str, object]]]:
        events.append(
            PipelineEvent(
                stage="transcribing",
                progress=45,
                message=f"开始转写，模型 {self._settings.whisper_model}",
            )
        )
        model = WhisperModel(
            self._settings.whisper_model,
            device=self._settings.whisper_device,
            compute_type=self._settings.whisper_compute_type,
        )
        raw_segments, _info = model.transcribe(str(audio_path), language="zh", vad_filter=True)

        segments: list[dict[str, object]] = []
        transcript_lines: list[str] = []
        for segment in raw_segments:
            item = {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": segment.text.strip(),
            }
            segments.append(item)
            transcript_lines.append(f"[{format_timestamp(item['start'])}] {item['text']}")
            if duration and duration > 0:
                progress = min(85, 45 + int((float(segment.end) / float(duration)) * 40))
            else:
                progress = min(85, 45 + len(segments))
            events.append(
                PipelineEvent(
                    stage="transcribing",
                    progress=progress,
                    message=f"已识别 {len(segments)} 段",
                    payload={"segment_count": len(segments)},
                )
            )
        transcript = "\n".join(transcript_lines)
        if not transcript.strip():
            raise VideoSumError("Transcription produced empty output.")
        return transcript, segments

    def _summarize(
        self,
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
        events: list[PipelineEvent],
    ) -> dict[str, object]:
        events.append(PipelineEvent(stage="summarizing", progress=90, message="开始生成摘要"))
        if self._settings.llm_enabled and self._settings.llm_api_key:
            summary = self._summarize_with_llm(transcript, segments, title)
        else:
            summary = self._summarize_with_rules(transcript, segments, title)
        events.append(PipelineEvent(stage="summarizing", progress=95, message="摘要生成完成"))
        return summary

    def _summarize_with_llm(
        self,
        transcript: str,
        segments: list[dict[str, object]],
        title: str,
    ) -> dict[str, object]:
        base_url = (self._settings.llm_base_url or "").rstrip("/")
        if not base_url or not self._settings.llm_model:
            raise VideoSumError("LLM configuration is incomplete.")
        payload = {
            "model": self._settings.llm_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是一名中文视频总结助手。"
                        "请严格输出 JSON，包含 title、overview、bulletPoints、chapters。"
                        "不要编造内容。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"视频标题：{title}\n\n"
                        f"转写全文：\n{transcript[:16000]}\n\n"
                        f"分段 JSON：\n{json.dumps(segments[:80], ensure_ascii=False)}\n\n"
                        "输出格式要求："
                        '{"title":"","overview":"","bulletPoints":[""],"chapters":[{"title":"","start":0,"summary":""}]}'
                    ),
                },
            ],
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Authorization": f"Bearer {self._settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        with httpx.Client(timeout=180) as client:
            response = client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        parsed.setdefault("title", title or "视频摘要")
        parsed.setdefault("overview", "")
        parsed.setdefault("bulletPoints", [])
        parsed.setdefault("chapters", [])
        return parsed

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
        return TaskResult(
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
        )
