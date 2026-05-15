FROM python:3.12-slim AS ffmpeg-static

ARG FFMPEG_STATIC_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
ARG FFMPEG_STATIC_FALLBACK_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-lgpl-7.1.tar.xz
ARG FFMPEG_STATIC_SHA256=
ENV FFMPEG_STATIC_URL=${FFMPEG_STATIC_URL} \
    FFMPEG_STATIC_FALLBACK_URL=${FFMPEG_STATIC_FALLBACK_URL} \
    FFMPEG_STATIC_SHA256=${FFMPEG_STATIC_SHA256}

RUN python - <<'PY'
import hashlib
import os
import shutil
import tarfile
import time
import urllib.request
from pathlib import Path

urls = [
    item.strip()
    for item in (
        os.environ.get("FFMPEG_STATIC_URL", ""),
        os.environ.get("FFMPEG_STATIC_FALLBACK_URL", ""),
    )
    if item.strip()
]
expected_sha256 = os.environ.get("FFMPEG_STATIC_SHA256", "").strip().lower()
archive = Path("/tmp/ffmpeg-static.tar.xz")
extract_root = Path("/tmp/ffmpeg")
target_dir = Path("/opt/ffmpeg/bin")
xz_magic = b"\xfd7zXZ\x00"

archive.parent.mkdir(parents=True, exist_ok=True)
extract_root.mkdir(parents=True, exist_ok=True)

errors = []
for url in urls:
    for attempt in range(1, 4):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "BiliSum Docker build ffmpeg downloader"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                status = getattr(response, "status", 200)
                if status >= 400:
                    raise RuntimeError(f"download failed with HTTP {status}")

                content_type = response.headers.get("content-type", "unknown")
                digest = hashlib.sha256()
                with archive.open("wb") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                        output.write(chunk)

            actual_sha256 = digest.hexdigest()
            if expected_sha256 and actual_sha256 != expected_sha256:
                raise RuntimeError(
                    f"sha256 mismatch: expected {expected_sha256}, got {actual_sha256}"
                )

            with archive.open("rb") as downloaded:
                magic = downloaded.read(len(xz_magic))
            if magic != xz_magic:
                sample = archive.read_bytes()[:200]
                raise RuntimeError(
                    "downloaded file is not an xz archive "
                    f"(content-type: {content_type}, first bytes: {sample!r})"
                )
            break
        except Exception as exc:
            errors.append(f"{url} attempt {attempt}: {exc}")
            if attempt < 3:
                time.sleep(attempt * 2)
    else:
        continue
    break
else:
    raise RuntimeError(
        "Unable to download a valid ffmpeg static archive:\n" + "\n".join(errors)
    )

with tarfile.open(archive, mode="r:xz") as tar:
    tar.extractall(extract_root, filter="data")

binaries = {
    path.name: path
    for path in extract_root.rglob("*")
    if path.name in {"ffmpeg", "ffprobe"} and path.is_file()
}
missing = [binary_name for binary_name in ("ffmpeg", "ffprobe") if binary_name not in binaries]
if missing:
    raise RuntimeError(f"ffmpeg archive is missing expected binaries: {', '.join(missing)}")

target_dir.mkdir(parents=True, exist_ok=True)

for binary_name in ("ffmpeg", "ffprobe"):
    source = binaries[binary_name]
    destination = target_dir / binary_name
    shutil.copy2(source, destination)
    destination.chmod(0o755)
PY

FROM python:3.12-slim

ENV PATH=/opt/ffmpeg/bin:${PATH} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    VIDEO_SUM_DOCKER=1 \
    VIDEO_SUM_HOST=0.0.0.0 \
    VIDEO_SUM_PORT=3838 \
    VIDEO_SUM_APP_DATA_ROOT=/data \
    VIDEO_SUM_DATA_DIR=/data \
    VIDEO_SUM_CACHE_DIR=/data/cache \
    VIDEO_SUM_TASKS_DIR=/data/tasks \
    VIDEO_SUM_DATABASE_URL=sqlite:////data/video_sum.db \
    VIDEO_SUM_WEB_STATIC_DIR=/app/apps/web/static

WORKDIR /app

COPY --from=ffmpeg-static /opt/ffmpeg /opt/ffmpeg

COPY pyproject.toml VERSION ./
COPY packages ./packages
COPY apps/service ./apps/service
COPY apps/web/static ./apps/web/static

RUN python -m pip install --upgrade pip setuptools wheel hatchling \
    && python -m pip install -e ./packages/infra -e ./packages/core -e ./apps/service

RUN mkdir -p /data/cache /data/tasks /data/logs

EXPOSE 3838
VOLUME ["/data"]

CMD ["python", "-m", "video_sum_service"]
