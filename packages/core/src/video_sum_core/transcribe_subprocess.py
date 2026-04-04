from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from faster_whisper import WhisperModel


logger = logging.getLogger("video_sum_core.transcribe_subprocess")


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )


def write_progress(progress_path: Path, payload: dict[str, object]) -> None:
    with progress_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        handle.flush()


def transcribe(
    audio_path: Path,
    model_name: str,
    device: str,
    compute_type: str,
    progress_path: Path,
    output_path: Path,
    duration: float | None,
) -> None:
    logger.info(
        "child transcription start audio=%s model=%s device=%s compute_type=%s",
        audio_path,
        model_name,
        device,
        compute_type,
    )
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    raw_segments, _info = model.transcribe(str(audio_path), language="zh", vad_filter=True)

    segments: list[dict[str, object]] = []
    transcript_lines: list[str] = []
    last_reported_progress = 58

    for segment in raw_segments:
        item = {
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": segment.text.strip(),
        }
        segments.append(item)
        transcript_lines.append(f"[{format_timestamp(item['start'])}] {item['text']}")

        if duration and duration > 0:
            progress = min(82, 58 + int((float(segment.end) / float(duration)) * 24))
        else:
            progress = min(82, 58 + min(24, len(segments)))

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
            "progress": 84,
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
