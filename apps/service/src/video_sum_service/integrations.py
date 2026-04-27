import io
import json
import wave

import httpx
from fastapi import HTTPException

from video_sum_infra.config import ServiceSettings
from video_sum_infra.runtime import service_log_path

from video_sum_service.context import COVER_CACHE_DIR, settings_manager
from video_sum_service.settings_manager import SettingsUpdatePayload

MAX_LOG_CHARS = 20_000
MAX_LOG_LINE_CHARS = 1_000


def trim_log_text(content: str, *, max_chars: int = MAX_LOG_CHARS, max_line_chars: int = MAX_LOG_LINE_CHARS) -> str:
    lines = content.splitlines()
    trimmed_lines = [
        f"{line[:max_line_chars]}... [line truncated]"
        if len(line) > max_line_chars
        else line
        for line in lines
    ]
    trimmed = "\n".join(trimmed_lines)
    if len(trimmed) <= max_chars:
        return trimmed
    return f"... [log truncated, showing last {max_chars} chars]\n{trimmed[-max_chars:]}"


def read_log_tail(max_lines: int = 200) -> str:
    log_path = service_log_path()
    if not log_path.exists():
        return ""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return trim_log_text("\n".join(lines[-max(1, max_lines) :]))


def cache_cover_image(source_url: str, canonical_id: str, referer_url: str | None = None) -> str:
    if not source_url:
        return ""
    normalized_source = source_url.replace("http://", "https://")
    COVER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = COVER_CACHE_DIR / f"{canonical_id}.jpg"
    if target.exists():
        return f"/media/covers/{target.name}"
    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
            ),
            "Referer": referer_url or "https://www.bilibili.com/",
        }
        with httpx.Client(timeout=30, follow_redirects=True, headers=headers) as client:
            response = client.get(normalized_source)
            response.raise_for_status()
        target.write_bytes(response.content)
        return f"/media/covers/{target.name}"
    except Exception:
        return normalized_source


def extract_http_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None

    if isinstance(payload, dict):
        for key in ("detail", "message", "error", "msg"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    text = (response.text or "").strip()
    return text or f"HTTP {response.status_code}"


def extract_llm_message_content(body: dict[str, object] | None) -> str:
    if not isinstance(body, dict):
        return ""
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    text_parts.append(text.strip())
        return "\n".join(text_parts).strip()
    return ""


def build_test_wav_bytes(duration_ms: int = 250, sample_rate: int = 16000) -> bytes:
    frame_count = max(1, int(sample_rate * duration_ms / 1000))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * frame_count)
    return buffer.getvalue()


def probe_llm_connection(payload: SettingsUpdatePayload | None = None) -> dict[str, object]:
    current_settings = settings_manager.current
    updates = payload.model_dump(exclude_none=True) if payload is not None else {}
    effective_settings = ServiceSettings.model_validate(
        {**current_settings.model_dump(mode="json"), **updates}
    )

    base_url = str(effective_settings.llm_base_url or "").strip().rstrip("/")
    api_key = str(effective_settings.llm_api_key or "").strip()
    model = str(effective_settings.llm_model or "").strip()

    if not base_url:
        raise HTTPException(status_code=400, detail="请先填写 API Base URL。")
    if not api_key:
        raise HTTPException(status_code=400, detail="请先填写 API Key。")
    if not model:
        raise HTTPException(status_code=400, detail="请先填写模型名称。")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    request_payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是一个 JSON 测试助手。你只能返回合法 JSON，不能输出任何额外文字。",
            },
            {
                "role": "user",
                "content": (
                    "请只返回一个合法 JSON 对象，不要带 markdown 代码块，不要带解释。"
                    '格式必须是：{"ok":true,"message":"test"}'
                ),
            },
        ],
        "temperature": 0,
        "max_tokens": 64,
    }

    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            response = client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=request_payload,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"LLM 连接失败：{exc}") from exc

    if response.status_code >= 400:
        detail = extract_http_error_detail(response)
        raise HTTPException(
            status_code=response.status_code,
            detail=f"LLM 测试失败：{detail}",
        )

    try:
        body = response.json()
    except ValueError:
        body = None

    preview = extract_llm_message_content(body)
    if not preview:
        raise HTTPException(status_code=502, detail="LLM 测试失败：接口已连通，但没有返回可读取的消息内容。")

    try:
        parsed_json = json.loads(preview)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"LLM 测试失败：接口可访问，但当前模型未返回合法 JSON。{exc.msg}",
        ) from exc

    preview = preview[:200]
    return {
        "ok": True,
        "message": f"LLM 连接与 JSON 输出测试成功：{model}",
        "model": model,
        "baseUrl": base_url,
        "responsePreview": preview,
        "jsonOutputAvailable": True,
        "jsonPreview": json.dumps(parsed_json, ensure_ascii=False)[:200],
    }


def probe_asr_connection(payload: SettingsUpdatePayload | None = None) -> dict[str, object]:
    current_settings = settings_manager.current
    updates = payload.model_dump(exclude_none=True) if payload is not None else {}
    effective_settings = ServiceSettings.model_validate(
        {**current_settings.model_dump(mode="json"), **updates}
    )

    base_url = str(effective_settings.siliconflow_asr_base_url or "").strip().rstrip("/")
    api_key = str(effective_settings.siliconflow_asr_api_key or "").strip()
    model = str(effective_settings.siliconflow_asr_model or "").strip()

    if not base_url:
        raise HTTPException(status_code=400, detail="请先填写 SiliconFlow Base URL。")
    if not api_key:
        raise HTTPException(status_code=400, detail="请先填写 SiliconFlow API Key。")
    if not model:
        raise HTTPException(status_code=400, detail="请先填写 ASR 模型名称。")

    headers = {"Authorization": f"Bearer {api_key}"}
    request_url = f"{base_url}/audio/transcriptions"
    audio_bytes = build_test_wav_bytes()

    try:
        timeout = httpx.Timeout(connect=20.0, read=90.0, write=90.0, pool=20.0)
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                request_url,
                headers=headers,
                data={"model": model},
                files={"file": ("bilisum-asr-test.wav", audio_bytes, "audio/wav")},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"ASR 连接失败：{exc}") from exc

    if response.status_code in {401, 403}:
        detail = extract_http_error_detail(response)
        raise HTTPException(status_code=response.status_code, detail=f"ASR 测试失败：认证失败，{detail}")
    if response.status_code >= 400:
        detail = extract_http_error_detail(response)
        raise HTTPException(status_code=response.status_code, detail=f"ASR 测试失败：{detail}")

    try:
        body = response.json()
    except ValueError:
        body = None

    transcript = str(body.get("text") or "").strip() if isinstance(body, dict) else ""
    return {
        "ok": True,
        "message": (
            f"ASR 连接测试成功：{model}"
            if transcript
            else f"ASR 连接测试成功：{model}（接口已响应，但测试音频未返回文本）"
        ),
        "model": model,
        "baseUrl": base_url,
        "responsePreview": transcript[:120],
    }
