FROM python:3.12-slim

RUN sed -i 's|http://deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/ffmpeg/bin:${PATH} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
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

# Layer 1: Install from pre-downloaded wheels (no network needed)
COPY docker-wheels/ ./wheels/
RUN pip install --no-index --find-links=./wheels video_sum_service[knowledge] && rm -rf ./wheels

# Layer 2: Copy pre-downloaded vector model
COPY bge-model/ /root/.cache/huggingface/hub/models--BAAI--bge-small-zh-v1.5/

# Layer 3: Copy app source (changes frequently, does NOT re-trigger pip install)
COPY apps/web/static ./apps/web/static

RUN mkdir -p /data/cache /data/tasks /data/logs

EXPOSE 3838
VOLUME ["/data"]

CMD ["python", "-m", "video_sum_service"]
