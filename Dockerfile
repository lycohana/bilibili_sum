FROM python:3.12-slim

ARG APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn

RUN if [ -n "${APT_MIRROR}" ]; then \
        sed -i "s|http://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

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

COPY pyproject.toml VERSION ./
COPY packages ./packages
COPY apps/service ./apps/service
COPY apps/web/static ./apps/web/static

RUN python -m pip install --upgrade pip setuptools wheel hatchling \
    && python -m pip install ./packages/infra ./packages/core './apps/service[knowledge]'

RUN mkdir -p /data/cache /data/tasks /data/logs

EXPOSE 3838
VOLUME ["/data"]

CMD ["python", "-m", "video_sum_service"]
