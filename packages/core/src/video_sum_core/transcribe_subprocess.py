from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional


logger = logging.getLogger("video_sum_core.transcribe_subprocess")

MODEL_PREPARE_START_PROGRESS = 56
MODEL_PREPARE_END_PROGRESS = 64
TRANSCRIBE_START_PROGRESS = 66
TRANSCRIBE_END_PROGRESS = 84


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )


def write_progress(progress_path: Path, payload: dict[str, object]) -> None:
    with progress_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        handle.flush()


def _format_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    size = float(max(value, 0))
    unit_index = 0
    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1
    if unit_index == 0:
        return f"{int(size)}{units[unit_index]}"
    return f"{size:.1f}{units[unit_index]}"


class _ModelDownloadReporter:
    def __init__(self, progress_path: Path, total_bytes: int, file_count: int) -> None:
        self._progress_path = progress_path
        self._total_bytes = max(total_bytes, 1)
        self._file_count = file_count
        self._current: dict[str, int] = {}
        self._last_progress = MODEL_PREPARE_START_PROGRESS
        self._last_message = ""

    def update(self, key: str, current: int, total: Optional[int] = None) -> None:
        bounded = max(0, current)
        if total is not None:
            bounded = min(bounded, max(0, total))
        self._current[key] = bounded
        downloaded = min(sum(self._current.values()), self._total_bytes)
        ratio = min(1.0, downloaded / self._total_bytes)
        progress = min(
            MODEL_PREPARE_END_PROGRESS - 1,
            MODEL_PREPARE_START_PROGRESS
            + max(0, int(ratio * (MODEL_PREPARE_END_PROGRESS - MODEL_PREPARE_START_PROGRESS - 1))),
        )
        message = (
            f"首次下载转写模型，已完成 {int(ratio * 100)}% "
            f"({ _format_bytes(downloaded) } / { _format_bytes(self._total_bytes) })"
        )
        if progress > self._last_progress or message != self._last_message:
            self._last_progress = progress
            self._last_message = message
            write_progress(
                self._progress_path,
                {
                    "stage": "transcribing",
                    "progress": progress,
                    "message": message,
                    "payload": {
                        "downloaded_bytes": downloaded,
                        "total_bytes": self._total_bytes,
                        "file_count": self._file_count,
                    },
                },
            )

    def finish(self) -> None:
        self.update("__all__", self._total_bytes, self._total_bytes)


def ensure_model_available(model_name: str, progress_path: Path) -> str:
    from faster_whisper import utils
    from huggingface_hub import snapshot_download
    from tqdm.auto import tqdm

    # Local path or unsupported custom identifier: let faster-whisper handle it directly.
    if Path(model_name).exists():
        return model_name

    if "/" in model_name:
        repo_id = model_name
    else:
        repo_id = utils._MODELS.get(model_name)  # type: ignore[attr-defined]
        if repo_id is None:
            return model_name

    allow_patterns = [
        "config.json",
        "preprocessor_config.json",
        "model.bin",
        "tokenizer.json",
        "vocabulary.*",
    ]

    dry_run = snapshot_download(
        repo_id,
        allow_patterns=allow_patterns,
        tqdm_class=utils.disabled_tqdm,
        dry_run=True,
    )
    pending = [info for info in dry_run if getattr(info, "will_download", False)]
    if not pending:
        write_progress(
            progress_path,
            {
                "stage": "transcribing",
                "progress": MODEL_PREPARE_START_PROGRESS,
                "message": "正在检查转写模型缓存",
                "payload": {"model": model_name, "phase": "checking-cache"},
            },
        )
        write_progress(
            progress_path,
            {
                "stage": "transcribing",
                "progress": MODEL_PREPARE_START_PROGRESS,
                "message": "转写模型已缓存，正在加载模型",
                "payload": {"model": model_name, "downloaded": False},
            },
        )
        return str(
            snapshot_download(
                repo_id,
                allow_patterns=allow_patterns,
                tqdm_class=utils.disabled_tqdm,
            )
        )

    total_bytes = sum(int(getattr(info, "file_size", 0) or 0) for info in pending)
    write_progress(
        progress_path,
        {
            "stage": "transcribing",
            "progress": MODEL_PREPARE_START_PROGRESS,
            "message": f"首次下载转写模型，共 {len(pending)} 个文件，约 {_format_bytes(total_bytes)}",
            "payload": {"model": model_name, "file_count": len(pending), "total_bytes": total_bytes},
        },
    )

    reporter = _ModelDownloadReporter(progress_path=progress_path, total_bytes=total_bytes, file_count=len(pending))

    class ProgressTqdm(tqdm):
        _reporter = reporter

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._briefvid_key = kwargs.get("desc") or f"file-{id(self)}"
            self._briefvid_total = int(self.total or 0)

        def update(self, n=1):
            result = super().update(n)
            self._reporter.update(self._briefvid_key, int(self.n or 0), self._briefvid_total)
            return result

        def close(self):
            self._reporter.update(self._briefvid_key, int(self.total or self.n or 0), int(self.total or 0))
            return super().close()

    model_path = snapshot_download(
        repo_id,
        allow_patterns=allow_patterns,
        tqdm_class=ProgressTqdm,
    )
    reporter.finish()
    write_progress(
        progress_path,
        {
            "stage": "transcribing",
            "progress": MODEL_PREPARE_END_PROGRESS,
            "message": "转写模型下载完成，正在初始化模型",
            "payload": {"model": model_name, "downloaded": True},
        },
    )
    return str(model_path)


def configure_runtime_library_dirs() -> None:
    raw_paths = os.environ.get("VIDEO_SUM_DLL_PATHS", "")
    if not raw_paths:
        return
    dll_paths: list[str] = []
    for entry in raw_paths.split(os.pathsep):
        path = entry.strip()
        if path and path not in dll_paths and Path(path).exists():
            dll_paths.append(path)

    if not dll_paths:
        return

    os.environ["PATH"] = os.pathsep.join([*dll_paths, os.environ.get("PATH", "")])
    add_dll_directory = getattr(os, "add_dll_directory", None)
    if add_dll_directory is None:
        return
    for path in dll_paths:
        try:
            add_dll_directory(path)
        except OSError:
            logger.debug("skip dll directory path=%s", path, exc_info=True)


def transcribe(
    audio_path: Path,
    model_name: str,
    device: str,
    compute_type: str,
    progress_path: Path,
    output_path: Path,
    duration: float | None,
) -> None:
    configure_runtime_library_dirs()
    from faster_whisper import WhisperModel

    logger.info(
        "child transcription start audio=%s model=%s device=%s compute_type=%s",
        audio_path,
        model_name,
        device,
        compute_type,
    )
    write_progress(
        progress_path,
        {
            "stage": "transcribing",
            "progress": MODEL_PREPARE_START_PROGRESS,
            "message": "正在检查转写模型缓存",
            "payload": {"model": model_name, "phase": "checking-cache"},
        },
    )
    prepared_model = ensure_model_available(model_name, progress_path)
    write_progress(
        progress_path,
        {
            "stage": "transcribing",
            "progress": MODEL_PREPARE_END_PROGRESS,
            "message": "模型已就绪，正在初始化转写引擎",
            "payload": {"model": model_name, "phase": "initializing-model"},
        },
    )
    model = WhisperModel(prepared_model, device=device, compute_type=compute_type)
    raw_segments, _info = model.transcribe(str(audio_path), language="zh", vad_filter=True)

    segments: list[dict[str, object]] = []
    transcript_lines: list[str] = []
    last_reported_progress = TRANSCRIBE_START_PROGRESS

    for segment in raw_segments:
        item = {
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": segment.text.strip(),
        }
        segments.append(item)
        transcript_lines.append(f"[{format_timestamp(item['start'])}] {item['text']}")

        if duration and duration > 0:
            progress = min(
                TRANSCRIBE_END_PROGRESS,
                TRANSCRIBE_START_PROGRESS + int((float(segment.end) / float(duration)) * (TRANSCRIBE_END_PROGRESS - TRANSCRIBE_START_PROGRESS)),
            )
        else:
            progress = min(TRANSCRIBE_END_PROGRESS, TRANSCRIBE_START_PROGRESS + min(TRANSCRIBE_END_PROGRESS - TRANSCRIBE_START_PROGRESS, len(segments)))

        if progress > last_reported_progress:
            last_reported_progress = progress
            write_progress(
                progress_path,
                {
                    "stage": "transcribing",
                    "progress": progress,
                    "message": f"正在转写，已识别 {len(segments)} 段",
                    "payload": {
                        "segment_count": len(segments),
                        "current_time": round(float(segment.end), 3),
                    },
                },
            )

    transcript = "\n".join(transcript_lines)
    if not transcript.strip():
        raise RuntimeError("Transcription produced empty output.")

    write_progress(
        progress_path,
        {
            "stage": "transcribing",
            "progress": TRANSCRIBE_END_PROGRESS,
            "message": f"转写完成，共识别 {len(segments)} 段",
            "payload": {"segment_count": len(segments)},
        },
    )
    output_path.write_text(
        json.dumps({"transcript": transcript, "segments": segments}, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info(
        "child transcription finish audio=%s segments=%d transcript_chars=%d",
        audio_path,
        len(segments),
        len(transcript),
    )


def format_timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run faster-whisper transcription in an isolated subprocess.")
    parser.add_argument("--audio-path", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--progress-path", required=True)
    parser.add_argument("--output-path", required=True)
    parser.add_argument("--duration", type=float)
    return parser.parse_args()


def main() -> int:
    configure_logging()
    args = parse_args()
    try:
        transcribe(
            audio_path=Path(args.audio_path),
            model_name=args.model,
            device=args.device,
            compute_type=args.compute_type,
            progress_path=Path(args.progress_path),
            output_path=Path(args.output_path),
            duration=args.duration,
        )
    except Exception:
        logger.exception("child transcription failed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
